import { useEffect, useState } from 'react'
import { isTauri } from '@/lib/tauri'
import { Minus, Square, X, Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useTheme } from '@/lib/useTheme'

/**
 * TitleBar — 32px 拖拽栏 + Windows 风格窗口控制
 * 仅在 Tauri 容器内显示窗口按钮；纯浏览器 dev 时仅显示 logo。
 */
export function TitleBar() {
  const [tauri, setTauri] = useState(false)
  const { theme, toggle } = useTheme()
  useEffect(() => setTauri(isTauri()), [])

  const onMin = async () => {
    if (!tauri) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().minimize()
  }
  const onMax = async () => {
    if (!tauri) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const w = getCurrentWindow()
    ;(await w.isMaximized()) ? w.unmaximize() : w.maximize()
  }
  const onClose = async () => {
    if (!tauri) return
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().close()
  }

  return (
    <div
      className="flex h-8 shrink-0 select-none items-center justify-between border-b border-border-1 bg-bg/95 backdrop-blur"
      data-tauri-drag-region
    >
      <div className="flex items-center gap-2 px-3 text-xs text-text-2" data-tauri-drag-region>
        <span
          className="inline-block h-3 w-3 rounded-sm"
          style={{ background: 'linear-gradient(135deg,var(--accent),var(--accent-3))' }}
        />
        <span className="select-none">Doc Reader</span>
      </div>
      {tauri && (
        <div className="flex h-full">
          <TitleBarButton onClick={toggle} aria-label="切换主题">
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </TitleBarButton>
          <TitleBarButton onClick={onMin} aria-label="最小化">
            <Minus className="h-3.5 w-3.5" />
          </TitleBarButton>
          <TitleBarButton onClick={onMax} aria-label="最大化">
            <Square className="h-3 w-3" />
          </TitleBarButton>
          <TitleBarButton onClick={onClose} aria-label="关闭" danger>
            <X className="h-3.5 w-3.5" />
          </TitleBarButton>
        </div>
      )}
      {!tauri && (
        <TitleBarButton onClick={toggle} aria-label="切换主题">
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </TitleBarButton>
      )}
    </div>
  )
}

function TitleBarButton({
  children,
  onClick,
  danger,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-full w-11 items-center justify-center text-text-2 transition-colors',
        danger ? 'hover:bg-error hover:text-white' : 'hover:bg-surface-2 hover:text-text-1'
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
