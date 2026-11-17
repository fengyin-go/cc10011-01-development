/**
 * 模板编排侧的准入数据集落点处理（纯函数）。
 *
 * - 待处理清单接收采集站点准入数据集后再同步；
 * - 先核对「按提交时负责人状态完成激活」（提交时负责人状态）才完成激活；
 * - 站点登记处理失败时接着完成：沿用上一份确认版本，先记录激活依据，当天处理轨迹留存；
 * - 冲突：比较准入数据集在该激活依据下的另一套边界（等待当前负责人重新确认），
 *   按业务规定判定模板编排记录，准入数据集供复核。
 */

import {
  BASIS_CURRENT_RECONFIRM,
  BASIS_SUBMIT_OWNER,
  type AdmissionRecord,
  type AuditEvent,
  type IntakeState,
  type TemplateIntakeItem,
} from './types.ts'

let intakeSeq = 0
let eventSeq = 0

function nextIntakeId(items: TemplateIntakeItem[]): number {
  intakeSeq = Math.max(intakeSeq, ...items.map((i) => i.id), 0)
  intakeSeq += 1
  return intakeSeq
}

function nextEventId(events: AuditEvent[]): number {
  eventSeq = Math.max(eventSeq, ...events.map((e) => e.id), 0)
  eventSeq += 1
  return eventSeq
}

function currentAdmission(records: AdmissionRecord[], siteCode: string): AdmissionRecord | undefined {
  return records.find((r) => r.siteCode === siteCode && r.isCurrent)
}

export type IntakeInput = {
  templateCode: string
  siteCode: string
  records: AdmissionRecord[]
  existingItems: TemplateIntakeItem[]
  events: AuditEvent[]
  now: string
  /** 站点登记处理失败标记：失败时沿用上一份确认版本。 */
  upstreamFailed?: boolean
}

export type IntakeResult = {
  item: TemplateIntakeItem
  events: AuditEvent[]
}

/**
 * 接收一条准入数据集变更落点并完成同步判定。
 */
export function syncIntake(input: IntakeInput): IntakeResult {
  const { templateCode, siteCode, records, existingItems, now, upstreamFailed } = input
  const current = currentAdmission(records, siteCode)
  const lastConfirmed = existingItems
    .filter((i) => i.templateCode === templateCode && i.state === 'confirmed')
    .sort((a, b) => b.id - a.id)[0]

  const events = [...input.events]
  let state: IntakeState = 'pending'
  let activationBasis = BASIS_SUBMIT_OWNER
  let conflictNote = ''

  if (!current) {
    state = 'failed'
    conflictNote = `站点 ${siteCode} 没有当前准入版本，未被准入的站点不会进入可引用候选`
  } else if (upstreamFailed) {
    // 站点登记处理失败：接着完成，沿用上一份确认版本
    if (lastConfirmed) {
      state = 'confirmed'
      activationBasis = BASIS_SUBMIT_OWNER
      conflictNote = `站点登记处理失败，沿用上一份确认版本 v${lastConfirmed.datasetVersion}，先记录「${BASIS_SUBMIT_OWNER}」`
    } else {
      state = 'failed'
      conflictNote = '站点登记处理失败且无上一份确认版本可沿用'
    }
  } else if (current.state === 'admitted' && current.submitOwnerStatus === '在职') {
    // 先核对按提交时负责人状态完成激活
    state = 'confirmed'
    activationBasis = BASIS_SUBMIT_OWNER
  } else if (current.state === 'reconfirm-pending') {
    // 另一套边界冲突：提交时激活 vs 等待当前负责人重新确认
    state = 'conflict'
    activationBasis = BASIS_CURRENT_RECONFIRM
    conflictNote =
      `检测到另一套边界「${BASIS_CURRENT_RECONFIRM}」：提交时负责人状态=${current.submitOwnerStatus}，` +
      `当前负责人状态=${current.currentOwnerStatus}。按业务规定以「${BASIS_SUBMIT_OWNER}」为复核依据，准入记录供复核`
  } else if (current.state === 'rejected' || current.state === 'merged') {
    state = 'failed'
    activationBasis = current.basis
    conflictNote = `站点当前准入版本为「${current.state}」，拒绝/归并原因可在准入数据集回查：${current.rejectionReason}`
  } else {
    state = 'failed'
    conflictNote = `准入状态 ${current.state} 不满足模板引用条件`
  }

  const item: TemplateIntakeItem = {
    id: nextIntakeId(existingItems),
    templateCode,
    datasetVersion: current ? records.length ? maxDatasetVersion(records) : 0 : lastConfirmed?.datasetVersion ?? 0,
    boundarySnapshot: current
      ? {
          siteCode,
          state: current.state,
          submitOwnerStatus: current.submitOwnerStatus,
          currentOwnerStatus: current.currentOwnerStatus,
          basis: current.basis,
        }
      : {
          siteCode,
          state: 'rejected',
          submitOwnerStatus: '停用',
          currentOwnerStatus: '停用',
          basis: lastConfirmed?.activationBasis ?? BASIS_SUBMIT_OWNER,
        },
    state,
    activationBasis,
    lastConfirmedVersion: lastConfirmed?.datasetVersion ?? null,
    conflictNote,
    receivedAt: now,
    processedAt: now,
  }

  const kindMap: Record<IntakeState, string> = {
    pending: '准入落点接收',
    confirmed: '准入数据集同步',
    failed: '准入同步失败',
    conflict: '准入边界冲突',
  }
  events.push({
    id: nextEventId(events),
    at: now,
    actor: '模板编排',
    kind: kindMap[state],
    detail: `${templateCode} <- ${siteCode}：${conflictNote || activationBasis}`,
  })

  return { item, events }
}

function maxDatasetVersion(records: AdmissionRecord[]): number {
  return records.reduce((max, r) => Math.max(max, r.version), 0)
}

/**
 * 冲突复核：以「按提交时负责人状态完成激活」为复核依据判定模板编排记录。
 * 复核后冲突项转为 confirmed（边界仍留痕在 conflictNote 与 boundarySnapshot 中）。
 */
export function resolveConflict(
  item: TemplateIntakeItem,
  records: AdmissionRecord[],
  reviewer: string,
  now: string,
): { item: TemplateIntakeItem; event: AuditEvent } {
  const current = currentAdmission(records, item.boundarySnapshot.siteCode)
  const resolved: TemplateIntakeItem = {
    ...item,
    state: 'confirmed',
    activationBasis: BASIS_SUBMIT_OWNER,
    processedAt: now,
    conflictNote:
      `[已复核 ${now} by ${reviewer}] 以「${BASIS_SUBMIT_OWNER}」为准；` +
      `另一套边界「${BASIS_CURRENT_RECONFIRM}」留痕。` + item.conflictNote,
  }
  const event: AuditEvent = {
    id: 0, // 由服务层重新编号
    at: now,
    actor: reviewer,
    kind: '冲突复核',
    detail: `${item.templateCode} 复核依据=${BASIS_SUBMIT_OWNER}，准入版本 v${current?.version ?? item.datasetVersion} 供复核`,
  }
  return { item: resolved, event }
}

/** 可引用站点候选：只有已准入（admitted）的当前版本才能进入。 */
export function candidateSites(records: AdmissionRecord[]): AdmissionRecord[] {
  return records
    .filter((r) => r.isCurrent && r.state === 'admitted')
    .sort((a, b) => a.siteCode.localeCompare(b.siteCode))
}
