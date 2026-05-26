import { useEffect, useState } from 'react'

/**
 * 平台检测 —— 与 `useIsMobile`（看屏幕宽度）正交：本 hook 看的是**运行环境**。
 *
 * 为什么单独再做一层平台检测？
 * - `useIsMobile` 只看视口宽度 (< 768px)，**Android 平板**通常 > 768，会被误判为
 *   "桌面"，导致渲染桌面版 TitleBar / 侧边栏，触控体验割裂。
 * - 真正的判定来自 UA：Tauri Android WebView 的 UA 带 `Android`，能精准命中平板。
 *
 * 用法：
 *   const android = useIsAndroid()
 *   if (android) ... // 走移动 / 触控优先布局，无视屏宽
 */
function detectAndroid(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Android/i.test(navigator.userAgent)
}

/** 同步读取（hooks 之外的代码也能用，例如启动时初始化路由） */
export function isAndroid(): boolean {
  return detectAndroid()
}

/** React hook 版本，SSR 安全：服务端默认 false，客户端挂载后再判定 */
export function useIsAndroid(): boolean {
  const [v, setV] = useState(false)
  useEffect(() => {
    setV(detectAndroid())
  }, [])
  return v
}

/** 触控设备（Android / iOS / 平板）。桌面 + 鼠标 → false */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false
  return (
    detectAndroid() ||
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (window.matchMedia?.('(pointer: coarse)')?.matches ?? false)
  )
}
