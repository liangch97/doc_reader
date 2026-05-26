import { useEffect, useState } from 'react'
import { isAndroid } from './usePlatform'

/**
 * 三态布局判定 —— 替代旧的 `useIsMobile || useIsAndroid` 组合判定。
 *
 * 设计要点（见 TABLET_DESIGN.md §2）：
 *   - desktop ─ 非触控（无 Android UA 且非 coarse pointer），无关屏宽
 *   - tablet  ─ 触控 + 视口宽 ≥ 768px（含 Android 平板 / iPad）
 *   - phone   ─ 触控 + 视口宽 < 768px（含 7 寸竖屏平板 / 手机）
 *
 * 横竖屏切换时即时切档：监听 window resize + matchMedia(orientation)。
 *
 * **为什么不复用 useIsMobile**：useIsMobile 只看屏宽，Android 平板（>= 768）
 * 会被识别为 desktop；旧代码靠 `mobile || android` 组合补救，新代码统一收敛
 * 在本 hook 中，调用方只关心三种状态。
 *
 * SSR 安全：服务端默认 `'desktop'`，客户端挂载后再判定。
 */
export type LayoutMode = 'desktop' | 'tablet' | 'phone'

function detectTouch(): boolean {
  if (typeof window === 'undefined') return false
  if (isAndroid()) return true
  if (typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return window.matchMedia?.('(pointer: coarse)')?.matches ?? false
}

function compute(): LayoutMode {
  if (typeof window === 'undefined') return 'desktop'
  const touch = detectTouch()
  if (!touch) return 'desktop'
  const w = window.innerWidth
  return w >= 768 ? 'tablet' : 'phone'
}

export function useLayoutMode(): LayoutMode {
  // SSR 阶段返回 desktop；首次 effect 内同步真实值，避免 hydration mismatch。
  const [mode, setMode] = useState<LayoutMode>('desktop')

  useEffect(() => {
    const update = () => setMode(compute())
    update()
    // resize 覆盖横竖屏切换；matchMedia(orientation) 在某些 WebView 上更可靠
    window.addEventListener('resize', update)
    const mql = window.matchMedia?.('(orientation: portrait)')
    mql?.addEventListener?.('change', update)
    return () => {
      window.removeEventListener('resize', update)
      mql?.removeEventListener?.('change', update)
    }
  }, [])

  return mode
}

/** 同步版本，供 hooks 之外（如启动路由初始化）使用 */
export function getLayoutMode(): LayoutMode {
  return compute()
}
