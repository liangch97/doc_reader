import { useEffect, useRef, useState } from 'react'
import { Download, MoreVertical, Trash2, Loader2 } from 'lucide-react'
import { resourcesApi } from '@/lib/api'
import type { Resource } from '@/types/resource'
import { cn } from '@/lib/cn'
import { useLayoutMode } from '@/lib/useLayoutMode'

interface Props {
  resource: Resource
  /** 删除 / 导出后通知父组件刷新列表 */
  onChanged?: () => void
  className?: string
}

/**
 * 资源卡片右上角的"操作菜单"。
 *
 * 设计要点：
 *  - hover 卡片时浮现，移开 / 点外部关闭，不打扰常态浏览
 *  - 拦截 mousedown / click，避免冒泡到 ResourceCard 外层 `<Link>` 触发跳转
 *  - 导出走 `resource_read_file` 后端命令拿 base64 → Blob → `<a download>` 触发系统下载，
 *    Tauri 2 的 wry webview 会把它作为文件下载到系统默认下载目录
 *  - 删除走 `resourcesApi.remove`，删完调 `onChanged` 让父组件 reload
 */
export function ResourceCardMenu({ resource, onChanged, className }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const mode = useLayoutMode()
  const touch = mode !== 'desktop'

  // 点外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** 把 base64 → Uint8Array（避免 atob 大字符串导致的 stack 溢出，分块处理） */
  const base64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64)
    const len = bin.length
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  const exportFile = async () => {
    if (busy) return
    setBusy('export')
    setErr(null)
    try {
      const { file_data, file_name } = await resourcesApi.readFile(resource.resource_id)
      const bytes = base64ToBytes(file_data)
      // 用 octet-stream 保险触发下载；TS 5 + lib.dom 的 BlobPart 拒绝 Uint8Array<ArrayBufferLike>，
      // 改传底层 ArrayBuffer 以满足 BufferSource 类型
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file_name || resource.filename || `${resource.title}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // 释放内存：下一帧再 revoke 给浏览器时间触发下载
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const deleteResource = async () => {
    if (busy) return
    if (!window.confirm(`确认删除《${resource.title}》？\n该操作会移除阅读记录、批注、笔记，且不可撤销。`)) return
    setBusy('delete')
    setErr(null)
    try {
      await resourcesApi.remove(resource.resource_id)
      setOpen(false)
      onChanged?.()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  /** 阻止任何子元素的 click / mousedown 冒泡到外层 Link */
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()
  }

  return (
    <div
      ref={wrapRef}
      className={cn('z-20', className)}
      onMouseDown={stop}
      onClick={stop}
    >
      <button
        type="button"
        aria-label="更多操作"
        title="更多操作"
        onClick={(e) => {
          stop(e)
          setOpen((v) => !v)
        }}
        className={cn(
          'flex items-center justify-center rounded-full',
          // 触控 44×44 满足平板最小可点击；桌面保留 28×28（h-7 w-7）紧凑视觉
          touch ? 'h-11 w-11' : 'h-7 w-7',
          'border border-border-1 bg-bg/90 text-text-2 shadow-sm backdrop-blur',
          'hover:text-text-1 hover:border-accent transition-colors',
          open && 'border-accent text-text-1'
        )}
      >
        <MoreVertical className={touch ? 'h-5 w-5' : 'h-3.5 w-3.5'} />
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-popover-border bg-popover shadow-2xl',
            touch ? 'w-44' : 'w-36'
          )}
          onMouseDown={stop}
          onClick={stop}
        >
          <MenuItem
            onClick={exportFile}
            icon={busy === 'export' ? <Loader2 className={touch ? 'h-4 w-4 animate-spin' : 'h-3 w-3 animate-spin'} /> : <Download className={touch ? 'h-4 w-4' : 'h-3 w-3'} />}
            label="导出文件"
            disabled={!!busy}
            touch={touch}
          />
          <div className="h-px bg-border-1/60" />
          <MenuItem
            onClick={deleteResource}
            icon={busy === 'delete' ? <Loader2 className={touch ? 'h-4 w-4 animate-spin' : 'h-3 w-3 animate-spin'} /> : <Trash2 className={touch ? 'h-4 w-4' : 'h-3 w-3'} />}
            label="删除资料"
            disabled={!!busy}
            danger
            touch={touch}
          />
          {err && (
            <div className="border-t border-border-1/60 px-2 py-1.5 text-[10px] text-error">
              {err}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
  touch,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  touch?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 text-left transition-colors disabled:opacity-50',
        // 触控行高 ≥ 44px，桌面保留紧凑 28px
        touch ? 'min-h-[44px] px-3 py-2.5 text-sm' : 'px-3 py-2 text-xs',
        danger
          ? 'text-error hover:bg-error/10'
          : 'text-text-1 hover:bg-surface-2'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
