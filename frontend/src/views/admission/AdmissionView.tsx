import { useCallback, useMemo, useState } from 'react'

import {
  listAuditEvents,
  listDenials,
  listIntake,
  readBundle,
  resetAdmissionDomain,
  runBatchVerify,
  runConflictResolution,
  runReconfirm,
  toggleOwner,
} from '@/api/admission-service'
import { ADMISSION_STATE_LABEL, INTAKE_STATE_LABEL } from '@/domain/types'
import type {
  AccessDenial,
  AdmissionRecord,
  AuditEvent,
  OwnerProfile,
  TemplateIntakeItem,
} from '@/domain/types'
import { useAdminSession } from '@/stores/session'

type TabKey = 'dataset' | 'owners' | 'intake' | 'audit' | 'denial'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'dataset', label: '站点底表（准入数据集）' },
  { key: 'owners', label: '站点负责人台账' },
  { key: 'intake', label: '模板编排待处理清单' },
  { key: 'audit', label: '处理轨迹' },
  { key: 'denial', label: '越权只读证据' },
]

const STATE_BADGE: Record<string, string> = {
  admitted: 'badge badge-ok',
  rejected: 'badge badge-bad',
  merged: 'badge badge-warn',
  'reconfirm-pending': 'badge badge-wait',
}

const INTAKE_BADGE: Record<string, string> = {
  pending: 'badge badge-wait',
  confirmed: 'badge badge-ok',
  failed: 'badge badge-bad',
  conflict: 'badge badge-warn',
}

function todayText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function AdmissionView() {
  const session = useAdminSession()
  const [tab, setTab] = useState<TabKey>('dataset')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [stateFilter, setStateFilter] = useState('')

  const refresh = useCallback(() => setTick((n) => n + 1), [])

  const bundle = useMemo(() => readBundle(), [tick])
  const currentRecords = useMemo(
    () => bundle.admissions.filter((r) => r.isCurrent).sort((a, b) => a.siteCode.localeCompare(b.siteCode)),
    [bundle],
  )
  const owners: OwnerProfile[] = bundle.owners
  const intake: TemplateIntakeItem[] = listIntake()
  const events: AuditEvent[] = listAuditEvents()
  const denials: AccessDenial[] = listDenials()

  const filtered = useMemo(() => {
    return currentRecords.filter((r) => {
      const hitKeyword =
        keyword.trim() === '' ||
        r.siteCode.includes(keyword.trim()) ||
        r.canonicalDomain.includes(keyword.trim()) ||
        r.submitOwner.includes(keyword.trim())
      const hitState = stateFilter === '' || r.state === stateFilter
      return hitKeyword && hitState
    })
  }, [currentRecords, keyword, stateFilter])

  const stats = useMemo(
    () => [
      { label: '当前准入版本', value: currentRecords.length },
      { label: '已准入站点', value: currentRecords.filter((r) => r.state === 'admitted').length },
      { label: '待重新确认', value: currentRecords.filter((r) => r.state === 'reconfirm-pending').length },
      { label: '拒绝/归并（原因可回查）', value: currentRecords.filter((r) => r.state === 'rejected' || r.state === 'merged').length },
    ],
    [currentRecords],
  )

  function notify(result: { ok: boolean; message: string }) {
    if (result.ok) {
      setError('')
      setMessage(result.message)
    } else {
      setMessage('')
      setError(result.message)
    }
    refresh()
  }

  function batchVerify(codes: string[] | undefined, forceFail = false) {
    notify(runBatchVerify(codes, forceFail))
    setSelected(new Set())
  }

  function toggleSelect(code: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  function toggleExpand(code: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(code)) next.delete(code)
      else next.add(code)
      return next
    })
  }

  const today = todayText()

  return (
    <section className="page" data-module="siteAdmission">
      <header className="page-head">
        <div>
          <h2>采集站点激活核验 · 准入数据集</h2>
          <p className="page-desc">
            读取站点登记表的域名地址、请求方式、字符编码、请求头模板与站点负责人，核验并归并生成站点底表；
            底表与准入结果原子提交，每个站点只有一个当前准入版本，拒绝原因永久可回查。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => batchVerify(undefined)}>
            批量核验全部待校验站点
          </button>
          <button
            className="btn"
            type="button"
            disabled={selected.size === 0}
            onClick={() => batchVerify([...selected])}
          >
            核验选中（{selected.size}）
          </button>
          <button
            className="btn ghost"
            type="button"
            title="模拟中途保存失败，验证站点底表与准入结果整体退回待校验"
            onClick={() => batchVerify(undefined, true)}
          >
            模拟落盘失败（回滚演示）
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              notify(resetAdmissionDomain())
            }}
          >
            重置核验域
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

      {message && <p className="notice notice-ok">{message}</p>}
      {error && <p className="notice notice-bad">{error}</p>}

      <div className="tabs">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`tab${tab === item.key ? ' tab-active' : ''}`}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            {item.key === 'denial' && denials.length > 0 && <span className="tab-count">{denials.length}</span>}
            {item.key === 'intake' && intake.some((i) => i.state === 'conflict') && (
              <span className="tab-count tab-count-warn">{intake.filter((i) => i.state === 'conflict').length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'dataset' && (
        <>
          <form className="filter-bar" onSubmit={(e) => e.preventDefault()}>
            <label className="filter-item">
              <span>站点编号 / 域名 / 负责人</span>
              <input value={keyword} placeholder="按关键字检索" onChange={(e) => setKeyword(e.target.value)} />
            </label>
            <label className="filter-item">
              <span>准入状态</span>
              <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                <option value="">全部</option>
                {Object.entries(ADMISSION_STATE_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
            </label>
          </form>

          <table className="data-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>站点编号 / 规范域名</th>
                <th>请求方式 / 编码</th>
                <th>请求头模板</th>
                <th>提交时归属</th>
                <th>当前归属</th>
                <th>准入状态 / 版本</th>
                <th>激活依据与生效时间</th>
                <th>拒绝原因（可回查）</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <DatasetRow
                  key={r.id}
                  record={r}
                  allRecords={bundle.admissions}
                  selected={selected.has(r.siteCode)}
                  expanded={expanded.has(r.siteCode)}
                  onToggleSelect={() => toggleSelect(r.siteCode)}
                  onToggleExpand={() => toggleExpand(r.siteCode)}
                  onReconfirm={() => notify(runReconfirm(r.siteCode))}
                  isAdmin={session.role === 'admin'}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td className="empty-state" colSpan={10}>暂无匹配的准入记录，先在站点登记提交校验后执行批量核验</td>
                </tr>
              )}
            </tbody>
          </table>
          <footer className="page-foot">
            <span>数据集版本 v{bundle.datasetVersion}，共 {currentRecords.length} 个当前准入版本（每个站点仅一个）</span>
          </footer>
        </>
      )}

      {tab === 'owners' && <OwnersPanel owners={owners} isAdmin={session.role === 'admin'} onToggle={(name) => notify(toggleOwner(name))} />}

      {tab === 'intake' && (
        <IntakePanel
          items={intake}
          isAdmin={session.role === 'admin'}
          onResolve={(id) => notify(runConflictResolution(id))}
        />
      )}

      {tab === 'audit' && (
        <table className="data-table">
          <thead>
            <tr><th>时间</th><th>操作人</th><th>事件类型</th><th>处理轨迹明细</th></tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td>
                  {e.at}
                  {e.at.startsWith(today) && <span className="badge badge-wait badge-inline">今日</span>}
                </td>
                <td>{e.actor}</td>
                <td>{e.kind}</td>
                <td>{e.detail}</td>
              </tr>
            ))}
            {events.length === 0 && (
              <tr><td className="empty-state" colSpan={4}>暂无处理轨迹</td></tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'denial' && (
        <>
          <p className="page-desc">负责人操作后仍是受控归属，越权请求被拒绝并在此留下只读证据，证据不可编辑或删除。</p>
          <table className="data-table">
            <thead>
              <tr><th>时间</th><th>操作人 / 角色</th><th>尝试动作</th><th>目标</th><th>拒绝原因</th></tr>
            </thead>
            <tbody>
              {denials.map((d) => (
                <tr key={d.id} className="row-denial">
                  <td>{d.at}</td>
                  <td>{d.actor}（{d.actorRole}）</td>
                  <td>{d.attemptedAction}</td>
                  <td>{d.target}</td>
                  <td>{d.reason}</td>
                </tr>
              ))}
              {denials.length === 0 && (
                <tr><td className="empty-state" colSpan={5}>暂无越权证据</td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function DatasetRow(props: {
  record: AdmissionRecord
  allRecords: AdmissionRecord[]
  selected: boolean
  expanded: boolean
  onToggleSelect: () => void
  onToggleExpand: () => void
  onReconfirm: () => void
  isAdmin: boolean
}) {
  const { record: r, allRecords, selected, expanded, onToggleSelect, onToggleExpand, onReconfirm, isAdmin } = props
  const history = allRecords
    .filter((x) => x.siteId === r.siteId)
    .sort((a, b) => b.version - a.version)
  const hasRejection = r.state === 'rejected' || r.state === 'merged'

  return (
    <>
      <tr>
        <td>
          <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`选择 ${r.siteCode}`} />
        </td>
        <td>
          <strong>{r.siteCode}</strong>
          <br />
          <span className="cell-sub">{r.canonicalDomain}</span>
        </td>
        <td>{r.requestMethod} / {r.encoding}</td>
        <td className="cell-mono">{r.headerTemplate || '—'}</td>
        <td>
          {r.submitOwner}
          <br />
          <span className={`cell-sub ${r.submitOwnerStatus === '停用' ? 'text-bad' : ''}`}>提交时：{r.submitOwnerStatus}</span>
        </td>
        <td>
          {r.currentOwner}
          <br />
          <span className={`cell-sub ${r.currentOwnerStatus === '停用' ? 'text-bad' : ''}`}>当前：{r.currentOwnerStatus}</span>
        </td>
        <td>
          <span className={STATE_BADGE[r.state]}>{ADMISSION_STATE_LABEL[r.state]}</span>
          <br />
          <span className="cell-sub">v{r.version}（当前版本）</span>
        </td>
        <td className="cell-sub">
          {r.basis}
          <br />
          提交生效：{r.submitEffectiveAt || '—'}
          <br />
          确认生效：{r.currentEffectiveAt || '—'}
        </td>
        <td>
          {hasRejection ? (
            <>
              <span className="text-bad">{r.rejectionReason}</span>
              <br />
              <span className="cell-sub">来源链 {r.rejectionTraces.length} 条（不随负责人变更丢失）</span>
            </>
          ) : r.rejectionTraces.length > 0 ? (
            <span className="cell-sub">历史拒绝 {r.rejectionTraces.length} 条，展开可回查</span>
          ) : (
            '—'
          )}
        </td>
        <td className="row-actions">
          {r.state === 'reconfirm-pending' && (
            <button className="link" type="button" onClick={onReconfirm}>
              {isAdmin ? '代为重新确认激活' : '当前负责人重新确认'}
            </button>
          )}
          <button className="link" type="button" onClick={onToggleExpand}>
            {expanded ? '收起版本历史' : `回查历史（${history.length} 版）`}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="row-detail">
          <td colSpan={10}>
            <table className="data-table inner-table">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>激活依据</th>
                  <th>拒绝/归并原因</th>
                  <th>提交时归属</th>
                  <th>当前归属</th>
                  <th>提交生效时间</th>
                  <th>确认时间</th>
                  <th>当前版本</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>v{h.version}</td>
                    <td><span className={STATE_BADGE[h.state]}>{ADMISSION_STATE_LABEL[h.state]}</span></td>
                    <td className="cell-sub">{h.basis}</td>
                    <td className="text-bad">{h.rejectionReason || (h.rejectionTraces.length ? '（见来源链）' : '—')}</td>
                    <td>{h.submitOwner} / {h.submitOwnerStatus}</td>
                    <td>{h.currentOwner} / {h.currentOwnerStatus}</td>
                    <td>{h.submitEffectiveAt || '—'}</td>
                    <td>{h.confirmedAt || '—'}</td>
                    <td>{h.isCurrent ? '是' : '否'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.rejectionTraces.length > 0 && (
              <div className="trace-box">
                <strong>拒绝原因来源链（只读留痕）：</strong>
                <ul>
                  {r.rejectionTraces.map((t, idx) => (
                    <li key={idx}>
                      {t.at} · v{t.version} · {ADMISSION_STATE_LABEL[t.state]} · {t.reason} · 依据：{t.basis}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function OwnersPanel(props: { owners: OwnerProfile[]; isAdmin: boolean; onToggle: (name: string) => void }) {
  const { owners, isAdmin, onToggle } = props
  return (
    <>
      {!isAdmin && <p className="notice notice-warn">当前为站点负责人身份：台账只读，维护归属状态请切换到值班管理员。</p>}
      <table className="data-table">
        <thead>
          <tr><th>负责人</th><th>归属状态</th><th>受控归属站点</th><th>更新时间</th>{isAdmin && <th>操作</th>}</tr>
        </thead>
        <tbody>
          {owners.map((o) => (
            <tr key={o.id}>
              <td>{o.ownerName}</td>
              <td>
                <span className={o.ownerStatus === '在职' ? 'badge badge-ok' : 'badge badge-bad'}>{o.ownerStatus}</span>
              </td>
              <td>{o.controlledSites.length ? o.controlledSites.join('、') : '（无受控站点）'}</td>
              <td>{o.updatedAt}</td>
              {isAdmin && (
                <td className="row-actions">
                  <button className="link" type="button" onClick={() => onToggle(o.ownerName)}>
                    {o.ownerStatus === '在职' ? '停用（模拟停用事件同时到达）' : '恢复在职'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function IntakePanel(props: { items: TemplateIntakeItem[]; isAdmin: boolean; onResolve: (id: number) => void }) {
  const { items, isAdmin, onResolve } = props
  return (
    <>
      <p className="page-desc">
        模板编排侧待处理清单接收采集站点准入数据集后再同步；先核对「按提交时负责人状态完成激活」。
        冲突项比较另一套边界「等待当前负责人重新确认后激活」，由值班管理员按业务规定复核，准入数据集供复核。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>模板编号</th>
            <th>站点 / 数据集版本</th>
            <th>边界快照</th>
            <th>处理状态</th>
            <th>激活依据</th>
            <th>上一确认版本</th>
            <th>说明 / 冲突记录</th>
            <th>接收/处理时间</th>
            {isAdmin && <th>操作</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td>{i.templateCode}</td>
              <td>{i.boundarySnapshot.siteCode} / v{i.datasetVersion}</td>
              <td className="cell-sub">
                {ADMISSION_STATE_LABEL[i.boundarySnapshot.state]}
                <br />
                提交时：{i.boundarySnapshot.submitOwnerStatus} ｜ 当前：{i.boundarySnapshot.currentOwnerStatus}
              </td>
              <td><span className={INTAKE_BADGE[i.state]}>{INTAKE_STATE_LABEL[i.state]}</span></td>
              <td className="cell-sub">{i.activationBasis}</td>
              <td>{i.lastConfirmedVersion === null ? '—' : `v${i.lastConfirmedVersion}`}</td>
              <td className="cell-sub">{i.conflictNote || '—'}</td>
              <td className="cell-sub">{i.receivedAt}</td>
              {isAdmin && (
                <td className="row-actions">
                  {i.state === 'conflict' && (
                    <button className="link" type="button" onClick={() => onResolve(i.id)}>
                      按提交时负责人状态复核
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          {items.length === 0 && (
            <tr><td className="empty-state" colSpan={isAdmin ? 9 : 8}>模板编排侧暂无待处理落点，可在模板编排页发起同步</td></tr>
          )}
        </tbody>
      </table>
    </>
  )
}
