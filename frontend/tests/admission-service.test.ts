/**
 * 服务层集成测试：内存 localStorage 驱动，覆盖
 * 原子提交/失败回滚、批量核验、越权拒绝留证、重新确认、模板落点与冲突复核。
 */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

// 内存版 localStorage，必须在导入存储层之前安装
class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }
  setItem(key: string, value: string): void {
    if (key.includes('fail-write')) {
      throw new Error('disk full (simulated)')
    }
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

const storage = new MemoryStorage()
Object.assign(globalThis, { window: { localStorage: storage }, localStorage: storage })

const {
  runBatchVerify,
  runReconfirm,
  runTemplateIntake,
  runConflictResolution,
  readBundle,
} = await import('../src/api/admission-service.ts')
const {
  listRows,
  armCommitFailure,
  domainStorageKey,
  storageKey,
  resetCaches,
  seedRowsForTest,
} = await import('../src/data/local-store.ts')
const { setSession } = await import('../src/stores/session.ts')

beforeEach(() => {
  storage.clear()
  resetCaches()
  setSession({ role: 'admin', ownerName: '', displayName: '值班管理员' })
})

/** 让指定站点重新进入待校验（走正式存储接口，保持缓存与磁盘一致）。 */
function reopenForVerify(codes: string[]): void {
  const scope = new Set(codes)
  seedRowsForTest(
    'site',
    listRows('site').map((r) =>
      scope.has(String(r['站点编号'])) ? { ...r, status: '待校验', pending: true, abnormal: false } : r,
    ),
  )
}

test('批量核验：完整站点准入并与站点底表原子生效', () => {
  const before = listRows('site').filter((r) => r.status === '待校验').length
  assert.ok(before >= 4)
  const result = runBatchVerify()
  assert.equal(result.ok, true, result.message)
  const bundle = readBundle()
  // SITE-0002 完整数据 + 在职受控 -> 准入，登记同步激活
  const s2 = listRows('site').find((r) => r['站点编号'] === 'SITE-0002')
  assert.equal(s2?.status, '已激活')
  const adm2 = bundle.admissions.find((r) => r.siteCode === 'SITE-0002' && r.isCurrent)
  assert.equal(adm2?.state, 'admitted')
  assert.equal(adm2?.basis, '按提交时负责人状态完成激活')
  // 每个站点只有一个当前准入版本
  const currentBySite = new Map<number, number>()
  for (const r of bundle.admissions) {
    if (r.isCurrent) currentBySite.set(r.siteId, (currentBySite.get(r.siteId) ?? 0) + 1)
  }
  assert.ok([...currentBySite.values()].every((n) => n === 1))
})

test('重复域名归并：SITE-0006 与 SITE-0001 同主机，同批核验时仅主记录保留准入版本', () => {
  // SITE-0001 已激活不参与核验，先退回待校验，让两个同域名站点同批评审
  reopenForVerify(['SITE-0001'])
  runBatchVerify(['SITE-0001', 'SITE-0006'])
  const s1 = readBundle().admissions.find((r) => r.siteCode === 'SITE-0001' && r.isCurrent)
  const s6 = readBundle().admissions.find((r) => r.siteCode === 'SITE-0006' && r.isCurrent)
  assert.equal(s1?.state, 'admitted')
  assert.equal(s6?.state, 'merged')
  assert.ok(s6?.rejectionReason.includes('SITE-0001'))
  // 归并站点登记仍退回待校验
  const row = listRows('site').find((r) => r['站点编号'] === 'SITE-0006')
  assert.equal(row?.status, '待校验')
})

test('落盘失败整体回滚：站点底表与准入结果都保持核验前状态', () => {
  const siteBefore = JSON.stringify(listRows('site').map((r) => [r.id, r.status]))
  const bundleBefore = JSON.stringify(readBundle())
  const diskBefore = storage.getItem(domainStorageKey())
  armCommitFailure()
  const result = runBatchVerify()
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('退回待校验'))
  const siteAfter = JSON.stringify(listRows('site').map((r) => [r.id, r.status]))
  assert.equal(siteAfter, siteBefore)
  assert.equal(JSON.stringify(readBundle()), bundleBefore)
  // 磁盘上的域存储保持旧内容，没有半成品
  assert.equal(storage.getItem(domainStorageKey()), diskBefore)
})

test('负责人越权核验被拒绝并写只读证据，受控站点可正常核验', () => {
  setSession({ role: 'owner', ownerName: '李峥', displayName: '站点负责人·李峥' })
  // 李峥只受控 SITE-0002，请求核验 SITE-0005 属越权
  const denied = runBatchVerify(['SITE-0005'])
  assert.equal(denied.ok, false)
  const evidence = readBundle().accessDenials
  assert.equal(evidence.length, 1)
  assert.ok(evidence[0].target.includes('SITE-0005'))
  assert.ok(evidence[0].reason.includes('受控归属'))
  // 核验受控站点成功
  const ok = runBatchVerify(['SITE-0002'])
  assert.equal(ok.ok, true, ok.message)
})

test('停用负责人提交 -> 拒绝且原因留痕；在职但不归属走重新确认并激活', () => {
  // 场景一：陈岚已停用（无归属站点），构造一条以其为负责人的登记 -> 拒绝，原因留痕
  seedRowsForTest(
    'site',
    listRows('site').map((r) =>
      r['站点编号'] === 'SITE-0006'
        ? { ...r, status: '待校验', pending: true, abnormal: false, 站点负责人: '陈岚' }
        : r,
    ),
  )
  runBatchVerify(['SITE-0006'])
  const rejected = readBundle().admissions.find((r) => r.siteCode === 'SITE-0006' && r.isCurrent)
  assert.equal(rejected?.state, 'rejected')
  assert.ok(rejected?.rejectionReason.includes('已停用'))

  // 场景二：周禾在职但已失去 SITE-0005 归属 -> 等待当前负责人重新确认
  runBatchVerify(['SITE-0005'])
  let rec = readBundle().admissions.find((r) => r.siteCode === 'SITE-0005' && r.isCurrent)
  assert.equal(rec?.state, 'reconfirm-pending')
  assert.equal(rec?.basis, '等待当前负责人重新确认后激活')
  // 重新确认
  const confirmed = runReconfirm('SITE-0005')
  assert.equal(confirmed.ok, true, confirmed.message)
  rec = readBundle().admissions.find((r) => r.siteCode === 'SITE-0005' && r.isCurrent)
  assert.equal(rec?.state, 'admitted')
  assert.equal(rec?.basis, '按提交时负责人状态完成激活')
  // 登记同步激活
  const row = listRows('site').find((r) => r['站点编号'] === 'SITE-0005')
  assert.equal(row?.status, '已激活')
})

test('拒绝原因链在多次核验后保留，不会只剩无来源状态', () => {
  runBatchVerify(['SITE-0004'])
  const first = readBundle().admissions.find((r) => r.siteCode === 'SITE-0004' && r.isCurrent)
  assert.equal(first?.state, 'rejected')
  const reasonCount = first?.rejectionTraces.length ?? 0
  assert.ok(reasonCount >= 1)
  // 再次核验仍然拒绝，来源链继续追加而非覆盖
  runBatchVerify(['SITE-0004'])
  const second = readBundle().admissions.find((r) => r.siteCode === 'SITE-0004' && r.isCurrent)
  assert.equal(second?.state, 'rejected')
  assert.ok((second?.rejectionTraces.length ?? 0) > reasonCount)
  assert.ok(second?.rejectionReason.includes('字符编码'))
})

test('模板落点同步、上游失败沿用确认版本、冲突复核闭环', () => {
  runBatchVerify(['SITE-0002'])
  // 正常同步
  const ok = runTemplateIntake('TEMP-0002', 'SITE-0002')
  assert.equal(ok.ok, true)
  // 上游失败：沿用上一份确认版本
  const failover = runTemplateIntake('TEMP-0002', 'SITE-0002', true)
  assert.equal(failover.ok, true)
  const failoverItem = readBundle().templateIntake
    .filter((i) => i.templateCode === 'TEMP-0002')
    .sort((a, b) => b.id - a.id)[0]
  assert.equal(failoverItem.state, 'confirmed')
  assert.ok(failoverItem.conflictNote.includes('沿用上一份确认版本'))
  assert.equal(failoverItem.lastConfirmedVersion, failoverItem.datasetVersion)
  // 边界冲突：周禾在职但不归属 SITE-0005，落点进入冲突待复核
  runBatchVerify(['SITE-0005'])
  const pendingIntake = runTemplateIntake('TEMP-0005', 'SITE-0005')
  assert.equal(pendingIntake.ok, false)
  const intake = readBundle().templateIntake
  const conflictItem = intake.filter((i) => i.state === 'conflict').pop()
  assert.ok(conflictItem, '应产生冲突待复核落点')
  assert.ok(conflictItem.conflictNote.includes('等待当前负责人重新确认后激活'))
  // 负责人角色无权复核
  setSession({ role: 'owner', ownerName: '王敏', displayName: '站点负责人·王敏' })
  const denied = runConflictResolution(conflictItem!.id)
  assert.equal(denied.ok, false)
  // 管理员复核：依据为按提交时负责人状态完成激活
  setSession({ role: 'admin', ownerName: '', displayName: '值班管理员' })
  const resolved = runConflictResolution(conflictItem!.id)
  assert.equal(resolved.ok, true)
  const after = readBundle().templateIntake.find((i) => i.id === conflictItem!.id)
  assert.equal(after?.state, 'confirmed')
  assert.equal(after?.activationBasis, '按提交时负责人状态完成激活')
  assert.ok(after?.conflictNote.includes('已复核'))
})

test('持久化键与种子键符合约定', () => {
  assert.equal(storageKey(), 'scraper-strategy-studio:entries')
  assert.equal(domainStorageKey(), 'scraper-strategy-studio:admission-domain')
})
