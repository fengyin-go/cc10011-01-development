/**
 * 核验引擎行为测试：node --test --experimental-strip-types（Node 22 直接跑 TS）。
 * 只引用 domain 下的纯函数与类型，不碰 DOM / localStorage。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeDomain, validateAdmissionInput, verifySites, reconfirmAdmission, assertSingleCurrentVersion } from '../src/domain/engine.ts'
import { syncIntake, candidateSites, resolveConflict } from '../src/domain/intake.ts'
import { BASIS_CURRENT_RECONFIRM, BASIS_SUBMIT_OWNER } from '../src/domain/types.ts'

type Row = Record<string, string | number | boolean>

const owners = [
  { id: 1, ownerName: '王敏', ownerStatus: '在职' as const, controlledSites: ['S1', 'S2', 'S3'], updatedAt: 't' },
  { id: 2, ownerName: '陈岚', ownerStatus: '停用' as const, controlledSites: [], updatedAt: 't' },
  { id: 3, ownerName: '李峥', ownerStatus: '在职' as const, controlledSites: ['S4'], updatedAt: 't' },
]

function site(id: number, code: string, patch: Partial<Row> = {}): Row {
  return {
    id,
    status: '待校验',
    pending: true,
    abnormal: false,
    站点编号: code,
    域名地址: `https://${code.toLowerCase()}.example.com/path`,
    站点类型: '资讯',
    请求方式: 'GET',
    字符编码: 'UTF-8',
    请求头模板: 'Accept: text/html',
    Cookie配置: '无',
    站点负责人: '王敏',
    ...patch,
  }
}

test('normalizeDomain 剥离协议/路径/端口/锚点并小写', () => {
  assert.equal(normalizeDomain('HTTPS://News.Example.com:8443/a?b=1#c'), 'news.example.com')
  assert.equal(normalizeDomain('  http://blog.example.com/  '), 'blog.example.com')
  assert.equal(normalizeDomain(''), '')
})

test('validateAdmissionInput 拦截缺失字段与非法请求方式', () => {
  assert.deepEqual(validateAdmissionInput(site(1, 'S1'), 's1.example.com'), [])
  const bad = site(2, 'S2', { 请求方式: 'WS', 字符编码: '' })
  const reasons = validateAdmissionInput(bad, 's2.example.com')
  assert.ok(reasons.some((r) => r.includes('字符编码缺失')))
  assert.ok(reasons.some((r) => r.includes('WS')))
})

test('完整数据 + 在职受控负责人 -> admitted 且登记激活', () => {
  const out = verifySites({ siteRows: [site(1, 'S1')], owners, existing: [], actor: 'tester', now: '2026-11-17 10:00' })
  assert.equal(out.summary.admitted, 1)
  const rec = out.admissions[0]
  assert.equal(rec.state, 'admitted')
  assert.equal(rec.basis, BASIS_SUBMIT_OWNER)
  assert.equal(rec.isCurrent, true)
  assert.equal(out.siteStatusById[1], '已激活')
  assert.equal(rec.submitOwnerStatus, '在职')
})

test('重复域名去重归并：仅最小 id 保留当前准入版本', () => {
  const rows = [
    site(1, 'S1', { 域名地址: 'https://dup.example.com/a' }),
    site(2, 'S2', { 域名地址: 'http://DUP.example.com:80/b?x=1' }),
  ]
  const out = verifySites({ siteRows: rows, owners, existing: [], actor: 't', now: 'now' })
  const [a, b] = out.admissions
  assert.equal(a.state, 'admitted')
  assert.equal(b.state, 'merged')
  assert.equal(a.canonicalDomain, b.canonicalDomain)
  assert.ok(b.rejectionReason.includes('S1'))
  assert.equal(out.siteStatusById[2], '待校验')
  assertSingleCurrentVersion(out.admissions)
})

test('提交时负责人停用 -> rejected，原因留痕；不在台账也拒绝', () => {
  const rows = [
    site(1, 'S1', { 站点负责人: '陈岚' }),
    site(2, 'S2', { 站点负责人: '不存在的人' }),
  ]
  const out = verifySites({ siteRows: rows, owners, existing: [], actor: 't', now: 'now' })
  assert.equal(out.summary.rejected, 2)
  assert.ok(out.admissions[0].rejectionReason.includes('已停用'))
  assert.ok(out.admissions[1].rejectionReason.includes('不在负责人台账'))
  assert.equal(out.siteStatusById[1], '待校验')
})

test('在职但不归属该站点 -> reconfirm-pending，依据为等待当前负责人重新确认', () => {
  const rows = [site(1, 'S9', { 站点负责人: '李峥' })] // 李峥只受控 S4
  const out = verifySites({ siteRows: rows, owners, existing: [], actor: 't', now: 'now' })
  const rec = out.admissions[0]
  assert.equal(rec.state, 'reconfirm-pending')
  assert.equal(rec.basis, BASIS_CURRENT_RECONFIRM)
  assert.equal(out.siteStatusById[1], '待校验')
})

test('重新确认后激活：版本递增、旧版非当前、拒绝链保留', () => {
  const first = verifySites({
    siteRows: [site(1, 'S1', { 字符编码: '' })],
    owners,
    existing: [],
    actor: 't',
    now: 't1',
  })
  assert.equal(first.admissions[0].state, 'rejected')
  const fixed = verifySites({ siteRows: [site(1, 'S1')], owners, existing: first.admissions, actor: 't', now: 't2' })
  const versions = fixed.admissions.filter((r) => r.siteId === 1).sort((a, b) => a.version - b.version)
  assert.equal(versions.length, 2)
  assert.equal(versions[0].isCurrent, false)
  assert.equal(versions[1].isCurrent, true)
  assert.equal(versions[1].state, 'admitted')
  // 历史拒绝原因仍在链上，不会只剩无来源状态
  assert.equal(versions[1].rejectionTraces.length, 1)
  assert.ok(versions[1].rejectionTraces[0].reason.includes('字符编码缺失'))

  const pending = verifySites({
    siteRows: [site(2, 'S9', { 站点负责人: '李峥' })],
    owners,
    existing: [],
    actor: 't',
    now: 't3',
  })
  const rec = pending.admissions[0]
  const done = reconfirmAdmission(pending.admissions, rec.siteId, '李峥', 't4')
  assert.equal(done.ok, true)
  const current = done.records.find((r) => r.siteId === rec.siteId && r.isCurrent)
  assert.equal(current?.state, 'admitted')
  assert.equal(current?.basis, BASIS_SUBMIT_OWNER)
  assertSingleCurrentVersion(done.records)
})

test('负责人受控范围之外的站点不会被该负责人核验', () => {
  const out = verifySites({
    siteRows: [site(1, 'S1'), site(2, 'S2')],
    owners,
    existing: [],
    actor: '李峥',
    allowedSiteCodes: ['S4'],
    now: 'now',
  })
  assert.equal(out.summary.scanned, 0)
})

test('模板落点：admitted -> confirmed；reconfirm-pending -> conflict；失败沿用上一确认版本', () => {
  const admitted = verifySites({ siteRows: [site(1, 'S1')], owners, existing: [], actor: 't', now: 'n' }).admissions
  const ok = syncIntake({ templateCode: 'T1', siteCode: 'S1', records: admitted, existingItems: [], events: [], now: 'n' })
  assert.equal(ok.item.state, 'confirmed')
  assert.equal(ok.item.activationBasis, BASIS_SUBMIT_OWNER)

  const pending = verifySites({
    siteRows: [site(2, 'S9', { 站点负责人: '李峥' })],
    owners,
    existing: [],
    actor: 't',
    now: 'n',
  }).admissions
  const conflict = syncIntake({ templateCode: 'T2', siteCode: 'S9', records: pending, existingItems: [], events: [], now: 'n' })
  assert.equal(conflict.item.state, 'conflict')
  assert.ok(conflict.item.conflictNote.includes(BASIS_CURRENT_RECONFIRM))
  assert.ok(conflict.item.conflictNote.includes(BASIS_SUBMIT_OWNER))

  const review = resolveConflict(conflict.item, pending, '值班管理员', 'n2')
  assert.equal(review.item.state, 'confirmed')
  assert.equal(review.item.activationBasis, BASIS_SUBMIT_OWNER)
  assert.ok(review.item.conflictNote.includes('已复核'))

  // 上游失败：沿用上一份确认版本
  const failover = syncIntake({
    templateCode: 'T1',
    siteCode: 'S1',
    records: admitted,
    existingItems: [ok.item],
    events: [],
    now: 'n3',
    upstreamFailed: true,
  })
  assert.equal(failover.item.state, 'confirmed')
  assert.equal(failover.item.lastConfirmedVersion, ok.item.datasetVersion)
  assert.ok(failover.item.conflictNote.includes('沿用上一份确认版本'))
})

test('候选站点只包含 admitted 当前版本，拒绝/待确认站点不进入', () => {
  const rows = [
    site(1, 'S1'),
    site(2, 'S2', { 字符编码: '' }),
    site(3, 'S9', { 站点负责人: '李峥' }),
  ]
  const out = verifySites({ siteRows: rows, owners, existing: [], actor: 't', now: 'n' })
  const candidates = candidateSites(out.admissions).map((r) => r.siteCode)
  assert.deepEqual(candidates, ['S1'])
})
