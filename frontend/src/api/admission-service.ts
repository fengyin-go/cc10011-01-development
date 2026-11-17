/**
 * 采集站点激活核验服务层：把纯函数引擎接到本地持久化上。
 *
 * 关键约束：
 * - 站点底表(site)与准入结果(admissions)通过 commitBundle 原子提交，
 *   中途保存失败时两侧都不变，登记保持/退回「待校验」；
 * - 负责人角色只能操作受控归属站点，越权请求被拒绝并写只读证据；
 * - 拒绝原因链只追加不清空，负责人失去站点归属后仍可回查。
 */

import { assertSingleCurrentVersion, reconfirmAdmission, verifySites } from '@/domain/engine'
import { candidateSites, resolveConflict, syncIntake } from '@/domain/intake'
import {
  BASIS_CURRENT_RECONFIRM,
  type AccessDenial,
  type AdmissionRecord,
  type AuditEvent,
  type OwnerProfile,
  type TemplateIntakeItem,
} from '@/domain/types'
import {
  armCommitFailure,
  commitBundle,
  listRows,
  readDomainBundle,
  resetDomainBundle,
  saveDomainBundle,
  type AdmissionBundle,
} from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { getSession, type Session } from '@/stores/session'

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
}

export function readBundle(): AdmissionBundle {
  return readDomainBundle()
}

/** 当前会话可核验的站点编号集合；admin 不设限。 */
function permittedSiteCodes(session: Session, owners: OwnerProfile[]): string[] | undefined {
  if (session.role === 'admin') return undefined
  const owner = owners.find((o) => o.ownerName === session.ownerName)
  return owner ? owner.controlledSites : []
}

function recordDenial(
  bundle: AdmissionBundle,
  session: Session,
  action: string,
  target: string,
  reason: string,
): AccessDenial {
  const denial: AccessDenial = {
    id: nextId(bundle.accessDenials),
    at: nowText(),
    actor: session.displayName,
    actorRole: session.role === 'admin' ? '值班管理员' : '站点负责人',
    attemptedAction: action,
    target,
    reason,
  }
  return denial
}

export type VerifyResponse = ActionResult & {
  summary?: {
    scanned: number
    admitted: number
    rejected: number
    merged: number
    reconfirmPending: number
  }
}

/**
 * 批量激活核验。
 * @param siteCodes 指定站点编号；不传则核验全部「待校验」站点。
 * @param forceFail 置 true 时模拟落盘失败，验证原子回滚。
 */
export function runBatchVerify(siteCodes?: string[], forceFail = false): VerifyResponse {
  const session = getSession()
  const bundle = readDomainBundle()
  const siteRows = listRows('site')
  const allowed = permittedSiteCodes(session, bundle.owners)

  // 越权判定：负责人请求核验非受控站点 -> 拒绝并留只读证据
  if (session.role === 'owner' && siteCodes) {
    const scope = new Set(allowed ?? [])
    const illegal = siteCodes.filter((code) => !scope.has(code))
    if (illegal.length > 0) {
      const denial = recordDenial(
        bundle,
        session,
        '批量激活核验',
        illegal.join('、'),
        '负责人操作后仍是受控归属，越权请求被拒绝（站点不在受控归属清单内）',
      )
      saveDomainBundle({ ...bundle, accessDenials: [...bundle.accessDenials, denial] })
      return { ok: false, message: `越权请求已拒绝并留证：${illegal.join('、')} 不在 ${session.ownerName} 的受控归属内` }
    }
  }

  const outcome = verifySites({
    siteRows,
    owners: bundle.owners,
    existing: bundle.admissions,
    actor: session.displayName,
    allowedSiteCodes: allowed,
    siteCodes,
    now: nowText(),
  })

  if (outcome.summary.scanned === 0) {
    return { ok: false, message: '没有可核验的待校验站点（负责人角色仅能核验受控归属站点）' }
  }

  assertSingleCurrentVersion(outcome.admissions)

  // 计算核验后的站点登记：未触及的行原样保留，触及的行按引擎结论落状态
  const touched = new Set(Object.keys(outcome.siteStatusById).map(Number))
  const nextSiteRows: EntryRow[] = siteRows.map((row) => {
    if (!touched.has(Number(row.id))) return row
    const status = outcome.siteStatusById[Number(row.id)]
    return { ...row, status, pending: status !== '已激活', abnormal: status === '待校验' && row.abnormal }
  })

  const nextBundle: AdmissionBundle = {
    ...bundle,
    admissions: outcome.admissions,
    auditEvents: [...bundle.auditEvents, ...outcome.events].sort((a, b) => a.id - b.id),
    datasetVersion: Math.max(bundle.datasetVersion, ...outcome.admissions.map((r) => r.version), 0),
  }

  if (forceFail) armCommitFailure()
  try {
    // 站点底表与准入结果作为一个整体提交
    commitBundle(nextSiteRows, nextBundle)
  } catch (error) {
    // 中途保存失败：缓存已回滚，登记仍停在「待校验」，没有半成品准入版本
    return {
      ok: false,
      message: `核验结果保存失败，已整体退回待校验：${error instanceof Error ? error.message : '未知错误'}`,
    }
  }

  return {
    ok: true,
    summary: outcome.summary,
    message: `核验完成：扫描 ${outcome.summary.scanned} 个，准入 ${outcome.summary.admitted}、拒绝 ${outcome.summary.rejected}、归并 ${outcome.summary.merged}、待重新确认 ${outcome.summary.reconfirmPending}`,
  }
}

/** 当前负责人重新确认后激活（仅 reconfirm-pending 可操作）。 */
export function runReconfirm(siteCode: string): ActionResult {
  const session = getSession()
  const bundle = readDomainBundle()
  const target = bundle.admissions.find((r) => r.siteCode === siteCode && r.isCurrent)
  if (!target) return { ok: false, message: '没有找到该站点的当前准入版本' }

  if (session.role === 'owner') {
    const owner = bundle.owners.find((o) => o.ownerName === session.ownerName)
    if (!owner || !owner.controlledSites.includes(siteCode)) {
      const denial = recordDenial(bundle, session, '负责人重新确认', siteCode, '越权重新确认被拒绝：站点不在受控归属内')
      saveDomainBundle({ ...bundle, accessDenials: [...bundle.accessDenials, denial] })
      return { ok: false, message: '越权请求已拒绝并留证' }
    }
  }

  const result = reconfirmAdmission(bundle.admissions, target.siteId, session.displayName, nowText())
  if (!result.ok) return { ok: false, message: result.message }
  assertSingleCurrentVersion(result.records)
  const event: AuditEvent = { ...result.event!, id: nextId(bundle.auditEvents) }
  // 重新确认通过 -> 站点登记同步激活，底表与准入结果仍走同一个原子提交
  const siteRows = listRows('site')
  const nextSiteRows = siteRows.map((row) =>
    String(row['站点编号']) === siteCode ? { ...row, status: '已激活', pending: false, abnormal: false } : row,
  )
  const nextBundle: AdmissionBundle = {
    ...bundle,
    admissions: result.records,
    auditEvents: [...bundle.auditEvents, event],
    datasetVersion: Math.max(bundle.datasetVersion, ...result.records.map((r) => r.version)),
  }
  commitBundle(nextSiteRows, nextBundle)
  return { ok: true, message: result.message }
}

/** 负责人停用/启用：模拟「负责人停用事件与站点激活核验同时到达」。 */
export function toggleOwner(ownerName: string): ActionResult {
  const session = getSession()
  if (session.role !== 'admin') {
    const bundle = readDomainBundle()
    const denial = recordDenial(bundle, session, '切换负责人归属状态', ownerName, '仅值班管理员可维护负责人台账')
    saveDomainBundle({ ...bundle, accessDenials: [...bundle.accessDenials, denial] })
    return { ok: false, message: '越权请求已拒绝并留证：负责人台账仅值班管理员可维护' }
  }
  const bundle = readDomainBundle()
  const now = nowText()
  const owners = bundle.owners.map((o): OwnerProfile => {
    if (o.ownerName !== ownerName) return o
    const nextStatus = o.ownerStatus === '在职' ? '停用' : '在职'
    return {
      ...o,
      ownerStatus: nextStatus,
      // 停用即失去全部站点归属；重新启用后受控清单需管理员另行恢复，这里保留原清单
      controlledSites: nextStatus === '停用' ? [] : o.controlledSites,
      updatedAt: now,
    }
  })
  const target = owners.find((o) => o.ownerName === ownerName)
  const event: AuditEvent = {
    id: nextId(bundle.auditEvents),
    at: now,
    actor: session.displayName,
    kind: '负责人归属变更',
    detail: `${ownerName} 归属状态变更为「${target?.ownerStatus}」，提交时归属与当前归属可能形成不同生效时间`,
  }
  saveDomainBundle({ ...bundle, owners, auditEvents: [...bundle.auditEvents, event] })
  return { ok: true, message: `${ownerName} 已${target?.ownerStatus === '停用' ? '停用并解除站点归属' : '恢复在职'}` }
}

export function listOwners(): OwnerProfile[] {
  return readDomainBundle().owners
}

export function listAdmissions(): AdmissionRecord[] {
  return readDomainBundle().admissions.filter((r) => r.isCurrent)
}

export function listAdmissionHistory(siteCode?: string): AdmissionRecord[] {
  const records = readDomainBundle().admissions
  return siteCode ? records.filter((r) => r.siteCode === siteCode) : records
}

export function listAuditEvents(): AuditEvent[] {
  return readDomainBundle().auditEvents.slice().sort((a, b) => b.id - a.id)
}

export function listDenials(): AccessDenial[] {
  return readDomainBundle().accessDenials.slice().sort((a, b) => b.id - a.id)
}

export function listIntake(): TemplateIntakeItem[] {
  return readDomainBundle().templateIntake.slice().sort((a, b) => b.id - a.id)
}

/**
 * 模板编排侧接收准入数据集落点并同步。
 * 站点登记处理失败（upstreamFailed）时沿用上一份确认版本。
 */
export function runTemplateIntake(templateCode: string, siteCode: string, upstreamFailed = false): ActionResult {
  const bundle = readDomainBundle()
  const { item, events } = syncIntake({
    templateCode,
    siteCode,
    records: bundle.admissions,
    existingItems: bundle.templateIntake,
    events: bundle.auditEvents,
    now: nowText(),
    upstreamFailed,
  })
  // syncIntake 只对新增事件给了临时编号，这里按现有审计序列重新编号
  const oldCount = bundle.auditEvents.length
  const reindexedEvents = events.map((e, idx) =>
    idx < oldCount ? e : { ...e, id: nextId(bundle.auditEvents) + (idx - oldCount) },
  )
  saveDomainBundle({
    ...bundle,
    templateIntake: [...bundle.templateIntake, item],
    auditEvents: reindexedEvents,
  })
  return {
    // conflict 属于待复核异常：记录已落待处理清单，但本次同步不算成功
    ok: item.state === 'confirmed',
    message: `落点已处理：${item.state === 'confirmed' ? item.activationBasis : item.conflictNote}`,
  }
}

/** 冲突复核：以「按提交时负责人状态完成激活」为复核依据。 */
export function runConflictResolution(intakeId: number): ActionResult {
  const session = getSession()
  const bundle = readDomainBundle()
  const item = bundle.templateIntake.find((i) => i.id === intakeId)
  if (!item) return { ok: false, message: '没有找到该待处理记录' }
  if (item.state !== 'conflict') return { ok: false, message: '该记录不在冲突待复核状态' }
  if (session.role !== 'admin') {
    const denial = recordDenial(bundle, session, '冲突复核', item.templateCode, '冲突复核仅值班管理员可执行')
    saveDomainBundle({ ...bundle, accessDenials: [...bundle.accessDenials, denial] })
    return { ok: false, message: '越权请求已拒绝并留证：冲突复核仅值班管理员可执行' }
  }
  const { item: resolved, event } = resolveConflict(item, bundle.admissions, session.displayName, nowText())
  const reindexed: AuditEvent = { ...event, id: nextId(bundle.auditEvents) }
  saveDomainBundle({
    ...bundle,
    templateIntake: bundle.templateIntake.map((i) => (i.id === intakeId ? resolved : i)),
    auditEvents: [...bundle.auditEvents, reindexed],
  })
  return { ok: true, message: `冲突已复核，模板编排记录按「${resolved.activationBasis}」判定，准入数据集留痕供回查` }
}

/** 模板预设新版本时的可引用站点候选：仅已准入当前版本。 */
export function listCandidateSites(): AdmissionRecord[] {
  return candidateSites(readDomainBundle().admissions)
}

export function resetAdmissionDomain(): ActionResult {
  resetDomainBundle()
  return { ok: true, message: '准入核验域已回到示例数据' }
}

export { BASIS_CURRENT_RECONFIRM }
