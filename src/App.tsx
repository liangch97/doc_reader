import { Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { TitleBar } from './shell/TitleBar'
import { AppSidebar, MobileTabBar } from './shell/AppSidebar'
import { GlobalDropZone } from './shell/GlobalDropZone'
import { useLayoutMode } from './lib/useLayoutMode'
import { useChromeHidden } from './shell/chromeStore'

/**
 * App shell — TitleBar + Sidebar + Outlet
 *
 * 三态布局（见 TABLET_DESIGN.md §2）：
 *   - desktop          → TitleBar + 左 rail
 *   - tablet 横屏      → 左 rail（无 TitleBar，Android 无 chrome）
 *   - tablet 竖屏      → 底部 Tab（无 TitleBar）
 *   - phone            → 底部 Tab（无 TitleBar）
 *
 * 横屏判定：`window.innerWidth >= window.innerHeight`，仅在 tablet 模式
 * 生效——desktop 永远 rail，phone 永远 tab。判定值用 state 持有，监听
 * resize / orientation 事件实时同步。
 *
 * 当 `chromeStore.setHidden(true)` 时（如阅读器沉浸模式），TitleBar /
 * AppSidebar / MobileTabBar 全部不渲染，把整张窗口让给 Outlet 内容。
 */
export default function App() {
  const mode = useLayoutMode()
  const chromeHidden = useChromeHidden()
  const [landscape, setLandscape] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= window.innerHeight
  )
  useEffect(() => {
    const update = () => setLandscape(window.innerWidth >= window.innerHeight)
    update()
    window.addEventListener('resize', update)
    const mql = window.matchMedia?.('(orientation: portrait)')
    mql?.addEventListener?.('change', update)
    return () => {
      window.removeEventListener('resize', update)
      mql?.removeEventListener?.('change', update)
    }
  }, [])

  // v5 (2026-05) B5: 「知识点 → 剪贴板」UI 入口已下线，全局 listener 删除。
  // 后端命令 kp_generate_to_clipboard 仍保留但前端不触发，无副作用。

  // tablet 横屏 → rail；竖屏 → tab。desktop/phone 各自固定。
  const showRail = !chromeHidden && (mode === 'desktop' || (mode === 'tablet' && landscape))
  const showTabBar = !chromeHidden && (mode === 'phone' || (mode === 'tablet' && !landscape))
  const showTitleBar = !chromeHidden && mode === 'desktop'

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-text-1">
      {showTitleBar && <TitleBar />}
      <div className="flex min-h-0 flex-1">
        {showRail && <AppSidebar />}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
      {showTabBar && <MobileTabBar />}
      {/* 全局拖拽导入：drop 到窗口任意位置都能触发，不限于 ImportDialog 内部小区域。
          需要 tauri.conf.json 里 `dragDropEnabled: false` 关闭 Tauri 原生 fileDrop，
          才能让 webview 的 HTML5 drop 事件正常触发（否则 dataTransfer.files 为空）。 */}
      <GlobalDropZone />
    </div>
  )
}
