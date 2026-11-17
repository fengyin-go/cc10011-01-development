import { useCallback, useEffect, useMemo, useState } from 'react'

import { readBundle, runBatchVerify } from '@/api/admission-service'
import { ADMISSION_STATE_LABEL, type AdmissionRecord } from '@/domain/types'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { ActionResult, EntryRow } from '@/data/types'
import { useAdminSession } from '@/stores/session'

const meta = moduleMeta('site')
const columns = [
  "站点编号",
  "域名地址",
  "站点类型",
  "请求方式",
  "字符编码",
  "请求头模板",
  "Cookie配置",
  "站点负责人"
]
const actions = [
  "提交校验",
  "激活站点",
  "暂停站点"
]
const statuses = [
  "草稿",
  "待校验",
  "已激活",
  "已暂停"
]

export default function SiteView() {
  const session = useAdminSession()
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [notice, setNotice] = useState<ActionResult | null>(null)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [tick, setTick] = useState(0)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setNotice(null)
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setNotice({ ok: false, message: error instanceof Error ? error.message : '站点登记列表读取失败' })
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload, tick])

  // 准入数据集当前版本：与站点登记按站点编号关联展示核验结局
  const admissions = useMemo(() => {
    return readBundle().admissions
      .filter((r) => r.isCurrent)
      .reduce<Map<string, AdmissionRecord>>((map, r) => {
        map.set(r.siteCode, r)
        return map
      }, new Map())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const stats = useMemo(() => [
    { label: '采集站点总数', value: rows.length },
    { label: '已激活站点', value: rows.filter((r) => r.status === '已激活').length },
    { label: '待校验站点', value: rows.filter((r) => r.status === '待校验').length },
  ], [rows])

  function runRowAction(action: string, row: EntryRow) {
    const result = applyAction(meta.key, Number(row.id), action)
    setNotice(result)
    if (result.ok) setTick((n) => n + 1)
  }

  function verify(codes?: string[]) {
    setNotice(runBatchVerify(codes))
    setTick((n) => n + 1)
  }

  const pendingRows = rows.filter((r) => r.status === '待校验')

  return (
    <section className="page" data-module="site">
      <header className="page-head">
        <div>
          <h2>站点登记管理</h2>
          <p className="page-desc">
            站点登记为主对象，采集站点与站点编号是同一记录的业务依据；通过域名加工进入采集站点准入数据集，
            站点编号保留查询入口。当前身份：{session.displayName}
            {session.role === 'owner' && '（仅可核验受控归属站点）'}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => verify()}>
            批量激活核验（{pendingRows.length} 个待校验）
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出站点登记清单
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

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      {notice && (
        <p className={`notice ${notice.ok ? 'notice-ok' : 'notice-bad'}`}>{notice.message}</p>
      )}

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
            <th>核验结局（准入数据集）</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const code = String(row['站点编号'] ?? '')
            const admission = admissions.get(code)
            return (
              <tr key={String(row.id)}>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>{row.status}</td>
                <td>
                  {admission ? (
                    <>
                      <span className={`badge ${admission.state === 'admitted' ? 'badge-ok' : admission.state === 'reconfirm-pending' ? 'badge-wait' : 'badge-warn'}`}>
                        {ADMISSION_STATE_LABEL[admission.state]}
                      </span>
                      <span className="cell-sub"> v{admission.version} · {admission.basis}</span>
                      {(admission.state === 'rejected' || admission.state === 'merged') && (
                        <>
                          <br />
                          <span className="text-bad" title={admission.rejectionTraces.map((t) => `${t.at} ${t.reason}`).join('\n')}>
                            {admission.rejectionReason}
                          </span>
                        </>
                      )}
                    </>
                  ) : (
                    <span className="cell-sub">未进入核验</span>
                  )}
                </td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runRowAction(action, row)}>
                      {action}
                    </button>
                  ))}
                  {row.status === '待校验' && (
                    <button className="link" type="button" onClick={() => verify([code])}>
                      激活核验
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 3}>暂无站点登记数据</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条站点登记记录；核验通过才会激活，未通过退回待校验且拒绝原因留存在准入数据集</span>
      </footer>
    </section>
  )
}
