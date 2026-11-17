import { useSyncExternalStore } from 'react'

/**
 * 会话上下文：当前操作人及其角色。
 * - admin 值班管理员：可批量核验全部站点、处理模板冲突；
 * - owner 站点负责人：操作后仍是受控归属，只能核验自己受控的站点，
 *   越权请求被拒绝并在准入域留下只读证据（accessDenials）。
 */
export type OperatorRole = 'admin' | 'owner'

export type Session = {
  role: OperatorRole
  /** owner 角色时对应负责人台账里的负责人姓名；admin 为固定值班管理员。 */
  ownerName: string
  displayName: string
}

const ADMIN_SESSION: Session = { role: 'admin', ownerName: '', displayName: '值班管理员' }

let current: Session = ADMIN_SESSION
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((fn) => fn())
}

export function getSession(): Session {
  return current
}

export function setSession(next: Session): void {
  current = next
  emit()
}

export function useAdminSession(): Session {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => current,
    () => current,
  )
}

export function adminSession(): Session {
  return ADMIN_SESSION
}
