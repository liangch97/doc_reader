import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, ArrowRight } from 'lucide-react'

/**
 * 脚注 / 尾注 / 词条 弹层。
 *
 * 数据来源：foliate-js 自带 `FootnoteHandler`（vendor/foliate-js/footnotes.js）
 *  - 当用户点击 epub 内的脚注链接时，handler 会创建一个 detached `<foliate-view>`，
 *    把目标 footnote 内容片段渲染进去（替换 body），然后 dispatch `'render'` 事件。
 *  - 我们把那个 detached view 元素接管过来挂到 popover 里展示。
 *
 * 设计：
 *  - 锚点在 anchorEl（通常是 epub 内的 <a> 标签或 anchor rect），但 anchorEl 在
 *    foliate iframe 内，DOMRect 用 `getBoundingClientRect` 时是相对 iframe 的，
 *    必须叠加 iframe 的 offset 才是 viewport 坐标 → 用 `clientRect`（已传入 viewport 坐标）
 *  - popover 显示脚注内容；提供「跳到原文」按钮（goToHref）
 *  - 点击外部 / Esc 关闭；翻页（relocate 事件） / 资源切换 也关闭
 */

export interface FootnotePopoverData {
  /** detached `<foliate-view>` 元素，已渲染脚注内容 */
  view: HTMLElement
  /** 原始 href（含锚点），点「跳到原文」用 */
  href: string
  /** 类型：footnote / endnote / biblioentry / definition / note / null */
  type?: string | null
  /** 唤起点的视口坐标矩形 */
  clientRect: { left: number; top: number; right: number; bottom: number }
}

interface Props {
  data: FootnotePopoverData | null
  onClose: () => void
  /** 点击「跳到原文」时调用，外部应执行 view.goTo(href) */
  onJumpToSource?: (href: string) => void
}

const POPOVER_W = 360
const POPOVER_MAX_H = 280
const MARGIN = 8

export function FootnotePopover({ data, onClose, onJumpToSource }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // 把 detached foliate-view 元素挂到 contentRef
  useEffect(() => {
    const host = contentRef.current
    if (!host || !data) return
    host.replaceChildren(data.view)
    // 让脚注 view 适应容器：宽度跟 popover，高度自动
    const v = data.view as HTMLElement
    v.style.width = '100%'
    v.style.height = `${POPOVER_MAX_H - 60}px`
    v.style.display = 'block'
    return () => {
      // 卸载时把脚注 view detach（让 GC），但不 remove，因为 handler 仍持有引用
      try {
        host.replaceChildren()
      } catch {
        /* ignore */
      }
    }
  }, [data])

  // 计算位置：默认锚点下方居中；越界时自动翻到上方 / 贴边
  useLayoutEffect(() => {
    if (!data) {
      setPos(null)
      return
    }
    const r = data.clientRect
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = (r.left + r.right) / 2 - POPOVER_W / 2
    if (left < MARGIN) left = MARGIN
    if (left + POPOVER_W > vw - MARGIN) left = vw - MARGIN - POPOVER_W
    let top = r.bottom + MARGIN
    if (top + POPOVER_MAX_H > vh - MARGIN) {
      // 下方放不下 → 翻到上方
      top = r.top - MARGIN - POPOVER_MAX_H
      if (top < MARGIN) top = MARGIN
    }
    setPos({ top, left })
  }, [data])

  // 点外 / Esc 关闭
  useEffect(() => {
    if (!data) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [data, onClose])

  if (!data || !pos) return null

  const typeLabel = data.type ? translateType(data.type) : '注'

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="脚注内容"
      className="fixed z-[1000] flex flex-col rounded-md border border-border-1 bg-bg shadow-2xl ring-1 ring-black/5"
      style={{
        top: pos.top,
        left: pos.left,
        width: POPOVER_W,
        maxHeight: POPOVER_MAX_H,
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border-1 px-3 py-1.5">
        <span className="text-[11px] font-medium text-text-2">{typeLabel}</span>
        <button
          type="button"
          onClick={() => onJumpToSource?.(data.href)}
          title="跳转到原文"
          className="ml-auto flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          原文 <ArrowRight className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="flex h-6 w-6 items-center justify-center rounded text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-hidden" />
    </div>,
    document.body
  )
}

function translateType(t: string): string {
  switch (t) {
    case 'footnote':
      return '脚注'
    case 'endnote':
      return '尾注'
    case 'biblioentry':
      return '参考文献'
    case 'definition':
      return '词条'
    case 'note':
      return '注释'
    default:
      return '注'
  }
}
