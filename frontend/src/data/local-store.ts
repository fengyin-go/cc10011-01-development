import { SEED_ROWS } from './seed'
import { SEED_DOMAIN_BUNDLE } from './seed-domain'
import type { EntryRow } from './types'
import type {
  AccessDenial,
  AdmissionRecord,
  AuditEvent,
  OwnerProfile,
  TemplateIntakeItem,
} from '@/domain/types'

// 本地持久化：通用模块数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'scraper-strategy-studio:entries'
// 激活核验域的独立存储段：与站点底表同 bundle 提交，保证「像一个整体出现」。
const DOMAIN_STORAGE_KEY = 'scraper-strategy-studio:admission-domain'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * 运行时取 localStorage：用 globalThis 间接访问而不是直接引用 window，
 * 避免打包器把 typeof window 静态替换掉，也让 Node 测试可以注入内存版。
 */
function getStorage(): Storage | null {
  const holder = globalThis as unknown as { window?: { localStorage?: Storage }; localStorage?: Storage }
  return holder.window?.localStorage ?? holder.localStorage ?? null
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const storage = getStorage()
  if (!storage) {
    return fallback
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) {
    storage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    storage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  const storage = getStorage()
  if (storage) {
    storage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---------------------------------------------------------------------------
// 激活核验域存储段
// ---------------------------------------------------------------------------

/** 站点底表与准入结果作为一个整体落盘。 */
export type AdmissionBundle = {
  owners: OwnerProfile[]
  admissions: AdmissionRecord[]
  templateIntake: TemplateIntakeItem[]
  auditEvents: AuditEvent[]
  accessDenials: AccessDenial[]
  datasetVersion: number
}

export const EMPTY_BUNDLE: AdmissionBundle = {
  owners: [],
  admissions: [],
  templateIntake: [],
  auditEvents: [],
  accessDenials: [],
  datasetVersion: 0,
}

let domainCache: AdmissionBundle | null = null

/**
 * 失败注入开关：置 true 后下一次 commitBundle 必然写盘失败，
 * 用于验证「中途保存失败要退回待校验」的原子回滚；写入一次后自动复位。
 */
let failNextCommit = false

export function armCommitFailure(): void {
  failNextCommit = true
}

function seedBundle(): AdmissionBundle {
  return clone(SEED_DOMAIN_BUNDLE)
}

export function readDomainBundle(): AdmissionBundle {
  if (domainCache) return domainCache
  const fallback = seedBundle()
  const storage = getStorage()
  if (!storage) {
    domainCache = fallback
    return fallback
  }
  const raw = storage.getItem(DOMAIN_STORAGE_KEY)
  if (!raw) {
    storage.setItem(DOMAIN_STORAGE_KEY, JSON.stringify(fallback))
    domainCache = fallback
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AdmissionBundle>
    domainCache = { ...EMPTY_BUNDLE, ...fallback, ...parsed }
    return domainCache
  } catch {
    storage.setItem(DOMAIN_STORAGE_KEY, JSON.stringify(fallback))
    domainCache = fallback
    return fallback
  }
}

export function saveDomainBundle(bundle: AdmissionBundle): void {
  domainCache = clone(bundle)
  const storage = getStorage()
  if (storage) {
    storage.setItem(DOMAIN_STORAGE_KEY, JSON.stringify(domainCache))
  }
}

/**
 * 原子提交：站点底表(site)与准入域 bundle 要么一起生效，要么一起不动。
 * 任意一步抛错都回退内存缓存并向上抛出，由服务层把登记状态退回「待校验」。
 */
export function commitBundle(
  nextSiteRows: EntryRow[],
  nextBundle: AdmissionBundle,
): void {
  const snapshotEntries = cache === null ? null : clone(cache)
  const snapshotDomain = domainCache === null ? null : clone(domainCache)
  const shouldFail = failNextCommit
  failNextCommit = false
  try {
    const storage = getStorage()
    if (storage) {
      if (shouldFail) {
        throw new Error('模拟写入失败：localStorage 提交中断')
      }
      const entriesNext = { ...allRows(), site: nextSiteRows }
      // 两个键紧邻写入：任一键抛错都进入 catch，旧值不被半覆盖
      storage.setItem(STORAGE_KEY, JSON.stringify(entriesNext))
      storage.setItem(DOMAIN_STORAGE_KEY, JSON.stringify(nextBundle))
    }
    cache = { ...allRows(), site: nextSiteRows }
    domainCache = clone(nextBundle)
  } catch (error) {
    // 回滚：恢复两个缓存段，磁盘上的旧值保持不变
    cache = snapshotEntries
    domainCache = snapshotDomain
    throw error
  }
}

export function resetDomainBundle(): AdmissionBundle {
  const fresh = seedBundle()
  saveDomainBundle(fresh)
  return fresh
}

export function domainStorageKey(): string {
  return DOMAIN_STORAGE_KEY
}

/** 测试辅助：丢弃内存缓存，下一次读取从持久化层重新加载。 */
export function resetCaches(): void {
  cache = null
  domainCache = null
}

/** 测试辅助：把任意模块的行直接写入存储段（页面代码不使用）。 */
export function seedRowsForTest(key: string, rows: EntryRow[]): void {
  saveRows(key, rows)
}

/** 测试辅助：直接写入准入域 bundle（页面代码不使用）。 */
export function seedDomainBundleForTest(bundle: AdmissionBundle): void {
  saveDomainBundle(bundle)
}
