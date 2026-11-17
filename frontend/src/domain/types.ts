/**
 * 采集站点激活核验领域模型。
 *
 * 数据流：站点登记(site) —— 激活核验引擎(engine) ——> 采集站点准入数据集(siteAdmission)
 *        —— 同步/落点 ——> 模板编排待处理清单(templateIntake) ——> 模板/任务候选站点底表
 *
 * 本文件只有类型与常量，不依赖 DOM / localStorage，可在 Node 下直接被单测引用。
 */

/** 负责人归属状态。 */
export type OwnerStatus = '在职' | '停用'

/** 准入核验结论（准入记录的机读状态）。 */
export type AdmissionState =
  | 'admitted' // 已准入：按提交时负责人状态完成激活
  | 'rejected' // 已拒绝：拒绝原因永久留痕
  | 'merged' // 重复域名归并：同一业务依据只保留一个当前准入版本
  | 'reconfirm-pending' // 等待当前负责人重新确认后激活

export const ADMISSION_STATE_LABEL: Record<AdmissionState, string> = {
  admitted: '已准入',
  rejected: '已拒绝',
  merged: '已归并',
  'reconfirm-pending': '待重新确认',
}

/** 激活依据 / 复核依据：按提交时负责人状态完成激活。 */
export const BASIS_SUBMIT_OWNER = '按提交时负责人状态完成激活'
/** 另一条激活路径：等待当前负责人重新确认后激活。 */
export const BASIS_CURRENT_RECONFIRM = '等待当前负责人重新确认后激活'

/** 模板待处理清单的处理状态。 */
export type IntakeState = 'pending' | 'confirmed' | 'failed' | 'conflict'

export const INTAKE_STATE_LABEL: Record<IntakeState, string> = {
  pending: '待处理',
  confirmed: '已同步',
  failed: '处理失败',
  conflict: '冲突待复核',
}

/** 站点负责人台账（负责人归属的唯一事实来源）。 */
export type OwnerProfile = {
  id: number
  ownerName: string
  ownerStatus: OwnerStatus
  /** 受控归属的站点编号集合，越权核验以此为界。 */
  controlledSites: string[]
  updatedAt: string
}

/** 一次拒绝/归并的历史留痕，新结论不会覆盖旧原因。 */
export type RejectionTrace = {
  at: string
  state: AdmissionState
  reason: string
  basis: string
  version: number
}

/**
 * 采集站点准入记录：站点底表的一行。
 * 每个站点编号在任意时刻只有一条 isCurrent=true 的当前准入版本。
 */
export type AdmissionRecord = {
  id: number
  /** 业务依据：采集站点 + 站点编号，同一登记记录。 */
  siteId: number
  siteCode: string
  /** 域名地址加工后的规范形态，作为去重键。 */
  canonicalDomain: string
  domain: string
  requestMethod: string
  encoding: string
  headerTemplate: string
  /** 提交时归属（核验当时快照）。 */
  submitOwner: string
  submitOwnerStatus: OwnerStatus
  /** 当前归属（核验当时快照）。 */
  currentOwner: string
  currentOwnerStatus: OwnerStatus
  state: AdmissionState
  /** 当前拒绝原因；负责人失去归属后仍保留，不允许被清空。 */
  rejectionReason: string
  /** 拒绝/归并原因的完整来源链，保证「不能只剩一个无来源的状态」。 */
  rejectionTraces: RejectionTrace[]
  basis: string
  version: number
  isCurrent: boolean
  /** 两套站点生效时间：提交时归属生效时间 / 当前归属确认时间。 */
  submitEffectiveAt: string
  currentEffectiveAt: string
  confirmedAt: string
  updatedAt: string
}

/** 采集站点准入数据集：底表整体只有一个完整版本。 */
export type AdmissionDataset = {
  datasetVersion: number
  updatedAt: string
  records: AdmissionRecord[]
}

/** 模板编排侧待处理清单项：记录准入数据集的变更落点。 */
export type TemplateIntakeItem = {
  id: number
  templateCode: string
  /** 接收时的准入数据集版本。 */
  datasetVersion: number
  /** 接收时该模板入口对应站点的准入边界快照。 */
  boundarySnapshot: {
    siteCode: string
    state: AdmissionState
    submitOwnerStatus: OwnerStatus
    currentOwnerStatus: OwnerStatus
    basis: string
  }
  state: IntakeState
  activationBasis: string
  /** 处理失败时沿用的上一份确认版本；首次失败为空。 */
  lastConfirmedVersion: number | null
  conflictNote: string
  receivedAt: string
  processedAt: string
}

/** 当天处理轨迹 / 审计事件。 */
export type AuditEvent = {
  id: number
  at: string
  actor: string
  kind: string
  detail: string
}

/** 越权请求的只读证据。 */
export type AccessDenial = {
  id: number
  at: string
  actor: string
  actorRole: string
  attemptedAction: string
  target: string
  reason: string
}

/** 核验引擎返回的待落盘结果（纯数据，由服务层原子提交）。 */
export type VerifyOutcome = {
  admissions: AdmissionRecord[]
  /** 核验后站点登记应有的状态（已激活 / 仍待校验）。 */
  siteStatusById: Record<number, string>
  events: AuditEvent[]
  summary: {
    scanned: number
    admitted: number
    rejected: number
    merged: number
    reconfirmPending: number
  }
}

/** 核验引擎输入。 */
export type VerifyInput = {
  siteRows: Array<Record<string, string | number | boolean>>
  owners: OwnerProfile[]
  existing: AdmissionRecord[]
  actor: string
  /** 限定可核验的站点编号；负责人角色只传其受控归属，越权由服务层拦截。 */
  allowedSiteCodes?: string[]
  now: string
  /** 仅核验指定站点编号；不传则核验全部「待校验」站点。 */
  siteCodes?: string[]
}
