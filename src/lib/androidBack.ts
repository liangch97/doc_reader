/**
 * Android 系统返回 / 边缘右滑手势处理。
 *
 * 背景：Tauri 2 在 Android 上把 webview 的 `history.back()` 当成系统 back，
 * 但默认 webview 没历史时不会自动退出 app —— 用户从屏幕右/左边缘内滑会"卡死"
 * 在白屏或当前页。
 *
 * 策略（参考 readest / Tauri mobile 社区方案）：
 *   1. 启动时插一条 dummy history state（"sentinel"）。
 *   2. 监听 popstate：
 *      - 当前 location 是 `/`（首页 LibraryPage）→ 调 Tauri 关闭 app（退出）。
 *      - 否则用 react-router 后退一步；浏览器自然回退。
 *   3. 每次 navigate 后补一条 sentinel，保证 history 始终至少 2 层，
 *      用户能从任意页右滑一次先回到上一页而不是直接退出。
 *
 * 只在 isAndroidPlatform() 下挂钩；桌面/iOS 不动。
 */
import { isAndroidPlatform } from './fileImport'

const SENTINEL = { __doc_reader_sentinel: true }

let installed = false

export function installAndroidBackHandler() {
  if (installed) return
  if (typeof window === 'undefined') return
  if (!isAndroidPlatform()) return
  installed = true

  // 初始 sentinel：用户第一次右滑时 popstate 把它消耗掉，再走我们的逻辑。
  try {
    window.history.pushState(SENTINEL, '')
  } catch {
    /* ignore */
  }

  const onPop = (_e: PopStateEvent) => {
    // 已经退到首页且无更多历史 → 退出 app
    const atRoot =
      window.location.pathname === '/' || window.location.pathname === '/library'

    if (atRoot) {
      // 没有更多前进/后退可走，直接关闭 Tauri 窗口（Android 上等同于 finish Activity）
      ;(async () => {
        try {
          const mod = await import('@tauri-apps/api/window')
          const win = mod.getCurrentWindow()
          await win.close()
        } catch {
          /* 非 Tauri 环境（浏览器开发），啥也别做 */
        }
      })()
      // 重新补一条 sentinel —— 万一 close 失败用户仍能再触发一次
      try {
        window.history.pushState(SENTINEL, '')
      } catch {
        /* ignore */
      }
      return
    }

    // 非首页：补一条 sentinel，让下一次右滑能继续消耗，不必依赖路由实现 back
    try {
      window.history.pushState(SENTINEL, '')
    } catch {
      /* ignore */
    }
    // 实际后退由 react-router 接管：把当前 SPA 路由后退一格
    // 注：popstate 触发时我们已经被 pop 了一层，需主动再 back 一次让 router 感知。
    try {
      window.history.back()
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('popstate', onPop)
}
