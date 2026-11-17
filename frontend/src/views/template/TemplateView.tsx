import { useCallback, useEffect, useMemo, useState } from 'react'

import { listCandidateSites, listIntake, runTemplateIntake } from '@/api/admission-service'
import { ADMISSION_STATE_LABEL, INTAKE_STATE_LABEL, type AdmissionRecord, type TemplateIntakeItem } from '@/domain/types'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('template')
const columns = [
  "模板编号",
  "入口地址",
  "列表选择器",
  "详情选择器",
  "分页规则",
  "字段映射",
  "数据格式",
  "模板版本"
]
const actions = [
  "提交校验",
  "启用模板",
  "废弃模板"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已废弃"
]

export default function TemplateView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [tick, setTick] = useState(0)
  const [templateCode, setTemplateCode] = useState('')
  const [siteCode, setSiteCode] = useState('')
  const [upstreamFailed, setUpstreamFailed] = useState(false)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setNotice(null)
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setNotice({ ok: false, message: error instanceof Error ? error.message : '模板编排列表读取失败' })
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload, tick])

  const candidates: AdmissionRecord[] = useMemo(() => listCandidateSites(), [tick])
  const intake: TemplateIntakeItem[] = useMemo(() => listIntake(), [tick])

  const stats = useMemo(() => [
    { label: '抽取模板总数', value: rows.length },
    { label: '已启用模板', value: rows.filter((r) => r.status === '已启用').length },
    { label: '待校验模板', value: rows.filter((r) => r.status === '待校验').length },
    { label: '可引用站点候选', value: candidates.length },
  ], [rows, candidates])

  function runRowAction(action: string, row: EntryRow) {
    const result = applyAction(meta.key, Number(row.id), action)
    setNotice(result)
    if (result.ok) setTick((n) => n + 1)
  }

  function sync() {
    if (!templateCode || !siteCode) {
      setNotice({ ok: false, message: '请选择模板编号与要接收的站点（来自准入数据集）' })
      return
    }
    setNotice(runTemplateIntake(templateCode, siteCode, upstreamFailed))
    setTick((n) => n + 1)
  }

  return (
    <section className="page" data-module="template">
      <header className="page-head">
        <div>
          <h2>模板编排管理</h2>
          <p className="page-desc">
            沿数据流接收采集站点准入数据集的变更落点：先核对「按提交时负责人状态完成激活」再同步；
            预设新版本时只可引用已准入站点，未被准入的站点不进入候选。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出模板编排清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {notice && <p className={`notice ${notice.ok ? 'notice-ok' : 'notice-bad'}`}>{notice.message}</p>}

      <div className="panel">
        <h3>接收采集站点准入数据集 · 待处理清单同步</h3>
        <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); sync() }}>
          <label className="filter-item">
            <span>模板编号</span>
            <select value={templateCode} onChange={(e) => setTemplateCode(e.target.value)}>
              <option value="">请选择</option>
              {rows.map((r) => <option key={r.id} value={String(r['模板编号'])}>{String(r['模板编号'])}</option>)}
            </select>
          </label>
          <label className="filter-item">
            <span>接收站点（仅已准入当前版本）</span>
            <select value={siteCode} onChange={(e) => setSiteCode(e.target.value)}>
              <option value="">请选择</option>
              {candidates.map((r) => (
                <option key={r.id} value={r.siteCode}>
                  {r.siteCode}（{r.canonicalDomain} · v{r.version}）
                </option>
              ))}
            </select>
          </label>
          <label className="filter-item filter-check">
            <input type="checkbox" checked={upstreamFailed} onChange={(e) => setUpstreamFailed(e.target.checked)} />
            <span>站点登记处理失败（沿用上一份确认版本，先记录激活依据，轨迹留存）</span>
          </label>
          <button className="btn primary" type="submit">接收并同步落点</button>
        </form>
        <p className="page-desc">
          冲突场景（负责人停用事件与核验同时到达）会落入「冲突待复核」，请在「站点准入数据集 → 模板编排待处理清单」页由值班管理员复核。
        </p>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>模板编号</th>
            <th>关联站点</th>
            <th>数据集版本</th>
            <th>处理状态</th>
            <th>激活依据</th>
            <th>边界 / 冲突说明</th>
          </tr>
        </thead>
        <tbody>
          {intake.map((i) => (
            <tr key={i.id}>
              <td>{i.templateCode}</td>
              <td>{i.boundarySnapshot.siteCode}（{ADMISSION_STATE_LABEL[i.boundarySnapshot.state]}）</td>
              <td>v{i.datasetVersion}</td>
              <td><span className={`badge ${i.state === 'confirmed' ? 'badge-ok' : i.state === 'conflict' ? 'badge-warn' : i.state === 'failed' ? 'badge-bad' : 'badge-wait'}`}>{INTAKE_STATE_LABEL[i.state]}</span></td>
              <td className="cell-sub">{i.activationBasis}</td>
              <td className="cell-sub">{i.conflictNote || '—'}</td>
            </tr>
          ))}
          {intake.length === 0 && (
            <tr><td className="empty-state" colSpan={6}>待处理清单尚未接收准入数据集落点</td></tr>
          )}
        </tbody>
      </table>

      <div className="panel">
        <h3>预设新版本可引用的站点候选（站点底表）</h3>
        <table className="data-table">
          <thead>
            <tr><th>站点编号</th><th>规范域名</th><th>请求方式</th><th>编码</th><th>准入版本</th><th>激活依据</th><th>提交时/当前归属</th></tr>
          </thead>
          <tbody>
            {candidates.map((r) => (
              <tr key={r.id}>
                <td>{r.siteCode}</td>
                <td>{r.canonicalDomain}</td>
                <td>{r.requestMethod}</td>
                <td>{r.encoding}</td>
                <td>v{r.version}</td>
                <td className="cell-sub">{r.basis}</td>
                <td className="cell-sub">{r.submitOwnerStatus} / {r.currentOwnerStatus}</td>
              </tr>
            ))}
            {candidates.length === 0 && (
              <tr><td className="empty-state" colSpan={7}>没有已准入站点，未被准入的站点不会进入可引用候选</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runRowAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无模板编排数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条模板编排记录</span>
      </footer>
    </section>
  )
}
