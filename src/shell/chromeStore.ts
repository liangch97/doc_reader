import { useSyncExternalStore } from 'react'

/**
 * 应用 chrome（TitleBar / AppSidebar / MobileTabBar）可见性的轻量全局 store。
 *
 * 使用场景：阅读器进入沉浸模式且工具栏已淡出后，把整体 chrome 也隐藏起来，
 * 实现真正的"无干扰"沉浸阅读。
 *
 * 用法：
 *   - 设置：`chromeStore.setHidden(true)`；通常在 ReaderShell 的 useEffect 里调用
 *   - 订阅：`useChromeHidden()` —— 在 App.tsx 顶层读取
 *   - 离开页面 / 退出沉浸 → 必须 `setHidden(false)` 还原
 */
type Listener = () => void

let hidden = false
const listeners = new Set<Listener>()

export const chromeStore = {
  getHidden: () => hidden,
  setHidden(v: boolean) {
    if (hidden === v) return
    hidden = v
    listeners.forEach((l) => l())
  },
  subscribe(l: Listener) {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}

export function useChromeHidden(): boolean {
  return useSyncExternalStore(
    chromeStore.subscribe,
    chromeStore.getHidden,
    () => false
  )
}
