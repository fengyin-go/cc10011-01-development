/**
 * 采集站点激活核验引擎（纯函数，无副作用）。
 *
 * 业务规则集中在这里，服务层只负责原子落盘与权限：
 * 1. 读取站点登记表的域名地址、请求方式、字符编码、请求头模板、站点负责人；
 * 2. 数据准入：必填项 + 域名规范加工；
 * 3. 去重归并：规范域名相同只保留一个当前准入版本，其余标 merged 并保留来源；
 * 4. 负责人快照：同时记录提交时归属与当前归属；提交时停用 -> 拒绝；
 *    提交时在职但当前停用 -> 待重新确认（两套生效时间并存，但底表只留一个完整版本）；
 * 5. 历史拒绝原因链不覆盖：负责人失去站点归属后，原拒绝原因仍留在准入记录里。
 */

import {
  BASIS_CURRENT_RECONFIRM,
  BASIS_SUBMIT_OWNER,
  type AdmissionRecord,
  type AdmissionState,
  type AuditEvent,
  type OwnerProfile,
  type RejectionTrace,
  type VerifyInput,
  type VerifyOutcome,
} from './types.ts'

let eventSeq = 0
let admissionSeq = 0

/** 域名加工：去协议、端口、路径、锚点与首尾空白，统一小写主机名。 */
export function normalizeDomain(raw: string): string {
  const value = String(raw ?? '').trim().toLowerCase()
  if (!value) return ''
  let host = value
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  host = host.split('/')[0] ?? ''
  host = host.split('?')[0] ?? ''
  host = host.split('#')[0] ?? ''
  // userinfo 与端口剔除
  host = host.split('@').pop() ?? ''
  host = host.split(':')[0] ?? ''
  return host.trim()
}

const REQUIRED_FIELDS: Array<{ field: string; label: string }> = [
  { field: '域名地址', label: '域名地址缺失' },
  { field: '请求方式', label: '请求方式缺失' },
  { field: '字符编码', label: '字符编码缺失' },
  { field: '请求头模板', label: '请求头模板缺失' },
  { field: '站点负责人', label: '站点负责人缺失' },
]

function nextAdmissionId(existing: AdmissionRecord[]): number {
  admissionSeq = Math.max(admissionSeq, ...existing.map((r) => r.id), 0)
  admissionSeq += 1
  return admissionSeq
}

function nextEventId(): number {
  eventSeq += 1
  return eventSeq
}

function findOwner(owners: OwnerProfile[], name: string): OwnerProfile | undefined {
  return owners.find((o) => o.ownerName === name)
}

/** 校验一条站点登记的数据准入条件，返回拒绝原因（空数组表示通过）。 */
export function validateAdmissionInput(
  row: Record<string, string | number | boolean>,
  canonicalDomain: string,
): string[] {
  const reasons: string[] = []
  for (const { field, label } of REQUIRED_FIELDS) {
    if (String(row[field] ?? '').trim() === '') {
      reasons.push(label)
    }
  }
  if (String(row['域名地址'] ?? '').trim() !== '' && !canonicalDomain) {
    reasons.push('域名地址无法加工为有效主机名')
  }
  const method = String(row['请求方式'] ?? '').toUpperCase()
  if (method && !['GET', 'POST', 'PUT', 'HEAD', 'DELETE'].includes(method)) {
    reasons.push(`请求方式 ${method} 不在允许范围(GET/POST/PUT/HEAD/DELETE)`)
  }
  return reasons
}

/** 取某站点编号的上一版本记录（用于版本号递增与拒绝链继承）。 */
function previousVersion(
  existing: AdmissionRecord[],
  siteId: number,
): AdmissionRecord | undefined {
  const history = existing
    .filter((r) => r.siteId === siteId)
    .sort((a, b) => b.version - a.version)
  return history[0]
}

/**
 * 核心入口：批量核验并归并采集站点准入记录。
 * 只产出结果，不写存储；落盘原子性由服务层 commitBundle 保证。
 */
export function verifySites(input: VerifyInput): VerifyOutcome {
  const { siteRows, owners, existing, actor, now } = input
  const allowed = input.allowedSiteCodes
    ? new Set(input.allowedSiteCodes)
    : null
  const only = input.siteCodes ? new Set(input.siteCodes) : null

  const candidates = siteRows.filter((row) => {
    const code = String(row['站点编号'] ?? '')
    if (only && !only.has(code)) return false
    // 只核验处于待校验的登记；已激活/草稿不重复核验
    if (String(row.status) !== '待校验') return false
    if (allowed && !allowed.has(code)) return false
    return true
  })

  const events: AuditEvent[] = []
  const newRecords: AdmissionRecord[] = []
  const siteStatusById: Record<number, string> = {}
  const summary = { scanned: candidates.length, admitted: 0, rejected: 0, merged: 0, reconfirmPending: 0 }

  // 域名 -> 本批次首个站点编号（最小 id 胜出，作为主记录）
  const domainWinner = new Map<string, number>()
  candidates
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .forEach((row) => {
      const canonical = normalizeDomain(String(row['域名地址'] ?? ''))
      if (canonical && !domainWinner.has(canonical)) {
        domainWinner.set(canonical, Number(row.id))
      }
    })

  for (const row of candidates) {
    const siteId = Number(row.id)
    const siteCode = String(row['站点编号'] ?? '')
    const domain = String(row['域名地址'] ?? '').trim()
    const canonical = normalizeDomain(domain)
    const ownerName = String(row['站点负责人'] ?? '').trim()
    const owner = findOwner(owners, ownerName)
    const prev = previousVersion(existing, siteId)
    const version = (prev?.version ?? 0) + 1

    const base = {
      id: nextAdmissionId([...existing, ...newRecords]),
      siteId,
      siteCode,
      canonicalDomain: canonical,
      domain,
      requestMethod: String(row['请求方式'] ?? ''),
      encoding: String(row['字符编码'] ?? ''),
      headerTemplate: String(row['请求头模板'] ?? ''),
      submitOwner: ownerName,
      // 提交时归属与当前归属都做快照：负责人停用事件与核验同时到达时两者可能不同
      submitOwnerStatus: owner?.ownerStatus ?? '停用',
      currentOwner: ownerName,
      currentOwnerStatus: owner?.ownerStatus ?? '停用',
      version,
      isCurrent: true,
      submitEffectiveAt: now,
      currentEffectiveAt: now,
      updatedAt: now,
    } satisfies Omit<AdmissionRecord, 'state' | 'rejectionReason' | 'rejectionTraces' | 'basis' | 'confirmedAt'>

    const inheritedTraces: RejectionTrace[] = prev ? prev.rejectionTraces.map((t) => ({ ...t })) : []
    let state: AdmissionState
    let reason = ''
    let basis = BASIS_SUBMIT_OWNER
    let confirmedAt = ''

    // 规则 1：数据准入
    const inputReasons = validateAdmissionInput(row, canonical)

    // 规则 2：域名去重归并（本批次同域名非主记录 -> merged）
    const winnerId = canonical ? domainWinner.get(canonical) : undefined
    const isDuplicate = winnerId !== undefined && winnerId !== siteId
    if (isDuplicate) {
      state = 'merged'
      reason = `域名 ${canonical} 与站点编号 ${candidates.find((r) => Number(r.id) === winnerId)?.['站点编号'] ?? ''} 重复，归并到主记录，仅保留一个当前准入版本`
    } else if (inputReasons.length > 0) {
      state = 'rejected'
      reason = inputReasons.join('；')
    } else if (!owner) {
      state = 'rejected'
      reason = `站点负责人「${ownerName || '空'}」不在负责人台账中，归属不可核验`
    } else if (owner.ownerStatus === '停用') {
      // 提交时负责人已停用：按提交时负责人状态完成激活的边界不满足 -> 拒绝
      state = 'rejected'
      reason = `提交时站点负责人「${ownerName}」已停用，按提交时负责人状态核验不满足激活条件`
    } else if (
      owner.ownerStatus === '在职' &&
      !owner.controlledSites.includes(siteCode)
    ) {
      // 受控归属边界：负责人在职但已不归属该站点
      state = 'reconfirm-pending'
      reason = `负责人「${ownerName}」当前不归属站点 ${siteCode}，等待当前负责人重新确认后激活`
      basis = BASIS_CURRENT_RECONFIRM
    } else {
      state = 'admitted'
      basis = BASIS_SUBMIT_OWNER
      confirmedAt = now
    }

    // 拒绝/归并原因追加到历史链；旧原因原样保留（负责人失去归属后仍可回查）
    const traces = [...inheritedTraces]
    if (state === 'rejected' || state === 'merged') {
      traces.push({ at: now, state, reason, basis, version })
    }
    // 重新确认通过后：清空当前拒绝原因展示位，但历史链仍在
    const rejectionReason =
      state === 'rejected' || state === 'merged'
        ? reason
        : prev && (prev.state === 'rejected' || prev.state === 'merged')
          ? ''
          : prev?.rejectionReason ?? ''

    const record: AdmissionRecord = {
      ...base,
      state,
      rejectionReason,
      rejectionTraces: traces,
      basis,
      confirmedAt,
    }
    newRecords.push(record)

    if (state === 'admitted') {
      summary.admitted += 1
      siteStatusById[siteId] = '已激活'
      events.push({
        id: nextEventId(),
        at: now,
        actor,
        kind: '站点激活核验',
        detail: `${siteCode} 按提交时负责人状态完成激活，准入版本 v${version}`,
      })
    } else if (state === 'reconfirm-pending') {
      summary.reconfirmPending += 1
      // 底表未形成完整激活版本：登记退回待校验
      siteStatusById[siteId] = '待校验'
      events.push({
        id: nextEventId(),
        at: now,
        actor,
        kind: '站点激活核验',
        detail: `${siteCode} 提交时在职但当前归属已变，${BASIS_CURRENT_RECONFIRM}`,
      })
    } else if (state === 'merged') {
      summary.merged += 1
      siteStatusById[siteId] = '待校验'
      events.push({
        id: nextEventId(),
        at: now,
        actor,
        kind: '站点激活核验',
        detail: `${siteCode} ${reason}`,
      })
    } else {
      summary.rejected += 1
      // 核验未通过：登记退回待校验，拒绝原因留在准入记录
      siteStatusById[siteId] = '待校验'
      events.push({
        id: nextEventId(),
        at: now,
        actor,
        kind: '站点激活核验',
        detail: `${siteCode} 拒绝准入：${reason}（拒绝原因已留痕，共 ${traces.length} 条来源）`,
      })
    }
  }

  // 旧版本全部置为非当前，保证每个站点只有一个当前准入版本
  const touchedSiteIds = new Set(newRecords.map((r) => r.siteId))
  const retired = existing
    .filter((r) => touchedSiteIds.has(r.siteId))
    .map((r) => ({ ...r, isCurrent: false }))
  const untouched = existing.filter((r) => !touchedSiteIds.has(r.siteId))
  const admissions = [...untouched, ...retired, ...newRecords].sort((a, b) => a.id - b.id)

  return { admissions, siteStatusById, events, summary }
}

/** 当前负责人重新确认：仅对 reconfirm-pending 当前版本生效。 */
export function reconfirmAdmission(
  existing: AdmissionRecord[],
  siteId: number,
  actor: string,
  now: string,
): { records: AdmissionRecord[]; event: AuditEvent | null; ok: boolean; message: string } {
  const current = existing.find((r) => r.siteId === siteId && r.isCurrent)
  if (!current) {
    return { records: existing, event: null, ok: false, message: '该站点没有当前准入版本，无法重新确认' }
  }
  if (current.state !== 'reconfirm-pending') {
    return { records: existing, event: null, ok: false, message: `当前版本状态为「${current.state}」，不在等待重新确认` }
  }
  const next: AdmissionRecord = {
    ...current,
    id: nextAdmissionId(existing),
    state: 'admitted',
    basis: BASIS_SUBMIT_OWNER,
    currentEffectiveAt: now,
    confirmedAt: now,
    updatedAt: now,
    version: current.version + 1,
    isCurrent: true,
    rejectionReason: '',
    // 拒绝链保留，不删除历史来源
  }
  const records = [...existing.map((r) => (r.id === current.id ? { ...r, isCurrent: false } : r)), next]
  return {
    records,
    ok: true,
    message: `${current.siteCode} 已由当前负责人重新确认并激活（v${next.version}）`,
    event: {
      id: nextEventId(),
      at: now,
      actor,
      kind: '负责人重新确认',
      detail: `${current.siteCode} ${BASIS_CURRENT_RECONFIRM} -> ${BASIS_SUBMIT_OWNER}，新版本 v${next.version}`,
    },
  }
}

/** 不变量自检：每个站点编号最多只有一个当前准入版本。 */
export function assertSingleCurrentVersion(records: AdmissionRecord[]): void {
  const countBySite = new Map<number, number>()
  for (const r of records) {
    if (r.isCurrent) countBySite.set(r.siteId, (countBySite.get(r.siteId) ?? 0) + 1)
  }
  for (const [siteId, count] of countBySite) {
    if (count > 1) throw new Error(`站点 ${siteId} 存在 ${count} 个当前准入版本，违反单一当前版本不变量`)
  }
}
