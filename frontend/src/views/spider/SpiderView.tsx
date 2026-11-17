import { useCallback, useEffect, useMemo, useState } from 'react'

import { listCandidateSites } from '@/api/admission-service'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('spider')
const columns = [
  "作业编号",
  "目标站点",
  "抽取模板",
  "起始地址",
  "并发线程数",
  "请求间隔秒",
  "每日上限条数",
  "超时秒数"
]
const actions = [
  "提交执行",
  "启动采集",
  "终止采集",
  "归档结果"
]
const statuses = [
  "草稿",
  "待执行",
  "运行中",
  "已完成",
  "已失败"
]
const stats = [
  {
    "label": "采集作业总数",
    "value": 0
  },
  {
    "label": "运行中作业",
    "value": 0
  },
  {
    "label": "已完成作业",
    "value": 0
  }
]

export default function SpiderView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '任务编排列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 任务编排获得可执行的站点底表：仅已准入站点可作为目标站点
  const candidateSites = useMemo(() => listCandidateSites(), [])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="spider">
      <header className="page-head">
        <div>
          <h2>任务编排管理</h2>
          <p className="page-desc">维护采集作业的输入、执行约束与结果记录，为任务编排提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('采集作业登记入口尚未接入审批流')}>
            登记采集作业
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出任务编排清单
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

      <div className="panel">
        <h3>可执行站点底表（只读，来自采集站点准入数据集）</h3>
        <p className="page-desc">任务编排只能引用已准入的当前版本；被拒绝、归并或等待重新确认的站点不会出现在目标站点候选中。</p>
        <table className="data-table">
          <thead>
            <tr><th>站点编号</th><th>规范域名</th><th>请求方式</th><th>字符编码</th><th>准入版本</th><th>激活依据</th><th>站点负责人</th></tr>
          </thead>
          <tbody>
            {candidateSites.map((r) => (
              <tr key={r.id}>
                <td>{r.siteCode}</td>
                <td>{r.canonicalDomain}</td>
                <td>{r.requestMethod}</td>
                <td>{r.encoding}</td>
                <td>v{r.version}</td>
                <td className="cell-sub">{r.basis}</td>
                <td>{r.currentOwner}（当前{r.currentOwnerStatus}）</td>
              </tr>
            ))}
            {candidateSites.length === 0 && (
              <tr><td className="empty-state" colSpan={7}>暂无可执行站点，请先完成站点激活核验</td></tr>
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
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无任务编排数据，可先登记采集作业</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条任务编排记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
