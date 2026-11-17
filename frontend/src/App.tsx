import { useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'

import { listOwners } from './api/admission-service'
import Overview from './views/Overview'
import SiteView from './views/site'
import AdmissionView from './views/admission'
import TemplateView from './views/template'
import ProxyView from './views/proxy'
import SpiderView from './views/spider'
import ScheduleView from './views/schedule'
import AntibotView from './views/antibot'
import RatelimitView from './views/ratelimit'
import RetryView from './views/retry'
import ExtractorView from './views/extractor'
import PipelineView from './views/pipeline'
import ValidatorView from './views/validator'
import StorageView from './views/storage'
import MonitorView from './views/monitor'
import CleanseView from './views/cleanse'
import DeltaView from './views/delta'
import ExportView from './views/export'
import RpaflowView from './views/rpaflow'
import AuthView from './views/auth'
import { setSession, useAdminSession } from './stores/session'

const navItems = [
  { label: '运营概览', path: '/' },
  { label: '站点登记', path: '/site' },
  { label: '站点准入数据集', path: '/admission' },
  { label: '模板编排', path: '/template' },
  { label: '代理轮换', path: '/proxy' },
  { label: '任务编排', path: '/spider' },
  { label: '调度编排', path: '/schedule' },
  { label: '反爬策略', path: '/antibot' },
  { label: '限速调节', path: '/ratelimit' },
  { label: '重试机制', path: '/retry' },
  { label: '字段映射', path: '/extractor' },
  { label: '采集流水线', path: '/pipeline' },
  { label: '结果校验', path: '/validator' },
  { label: '数据落盘', path: '/storage' },
  { label: '采集监控', path: '/monitor' },
  { label: '数据清洗', path: '/cleanse' },
  { label: '增量水位', path: '/delta' },
  { label: '数据分发', path: '/export' },
  { label: 'RPA流程', path: '/rpaflow' },
  { label: '登录凭证', path: '/auth' },
]

export default function App() {
  const session = useAdminSession()
  // 负责人台账在模块加载时已播种，直接读取用于角色切换
  const [owners] = useState(() => listOwners())

  function switchRole(value: string) {
    if (value === 'admin') {
      setSession({ role: 'admin', ownerName: '', displayName: '值班管理员' })
    } else {
      const owner = owners.find((o) => o.ownerName === value)
      if (owner) {
        setSession({ role: 'owner', ownerName: owner.ownerName, displayName: `站点负责人·${owner.ownerName}` })
      }
    }
  }

  return (
    <div className="app-shell">
      <aside className="app-side">
        <h1 className="app-title">采集调度策略管理工具</h1>
        <nav className="nav-list">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `nav-item${isActive ? ' router-link-active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="app-main">
        <header className="app-head">
          <span className="head-desc">离线版采集调度策略配置工具，站点激活核验生成采集站点准入数据集，供模板编排与任务编排引用，所有配置持久化到浏览器本地存储。</span>
          <label className="role-switch">
            当前身份
            <select
              value={session.role === 'admin' ? 'admin' : session.ownerName}
              onChange={(event) => switchRole(event.target.value)}
            >
              <option value="admin">值班管理员（全量）</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.ownerName}>
                  站点负责人·{owner.ownerName}（{owner.ownerStatus}）
                </option>
              ))}
            </select>
          </label>
        </header>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/site" element={<SiteView />} />
          <Route path="/admission" element={<AdmissionView />} />
          <Route path="/template" element={<TemplateView />} />
          <Route path="/proxy" element={<ProxyView />} />
          <Route path="/spider" element={<SpiderView />} />
          <Route path="/schedule" element={<ScheduleView />} />
          <Route path="/antibot" element={<AntibotView />} />
          <Route path="/ratelimit" element={<RatelimitView />} />
          <Route path="/retry" element={<RetryView />} />
          <Route path="/extractor" element={<ExtractorView />} />
          <Route path="/pipeline" element={<PipelineView />} />
          <Route path="/validator" element={<ValidatorView />} />
          <Route path="/storage" element={<StorageView />} />
          <Route path="/monitor" element={<MonitorView />} />
          <Route path="/cleanse" element={<CleanseView />} />
          <Route path="/delta" element={<DeltaView />} />
          <Route path="/export" element={<ExportView />} />
          <Route path="/rpaflow" element={<RpaflowView />} />
          <Route path="/auth" element={<AuthView />} />
        </Routes>
      </main>
    </div>
  )
}
