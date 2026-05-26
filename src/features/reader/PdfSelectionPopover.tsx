import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Highlighter, Sparkles } from 'lucide-react'
import { HIGHLIGHT_COLORS, type HighlightColorKey } from '@/lib/foliate'
import type { PdfNormRect } from '@/types/annotation'
import { mergePdfRectsByLine } from '@/types/annotation'
import { useLayoutMode } from '@/lib/useLayoutMode'
import { cn } from '@/lib/cn'

interface SelInfo {
  /** 选区上方 popover 锚点（视口坐标） */
  popoverLeft: number
  popoverTop: number
  /** 选区底部 y（视口坐标），触屏把气泡放下方避开系统气泡用 */
  popoverBottom: number
  /** 锁定的 selection 信息：颜色按钮按下时直接 commit，不再读 window.getSelection */
  pageIndex: number
  rects: PdfNormRect[]
  selectedText: string
}

interface Props {
  /**
   * 滚动容器 ref（PdfCanvasView 的 `<div data-pdf-scroll-root>`）。
   * Popover 只对这个容器内的选区做出响应。
   */
  scrollRootRef: React.RefObject<HTMLElement>
  /** 用户点颜色后提交的回调 —— ReaderShell 绑到 useAnnotations.addPdfHighlight */
  onConfirm: (args: {
    pageIndex: number
    rects: PdfNormRect[]
    selectedText: string
    color: HighlightColorKey
  }) => void | Promise<void>
  /** "AI 解释"入口；接收当前 PDF 选中文本。不传则不渲染入口。 */
  onAIExplain?: (selectedText: string) => void
}

/**
 * PDF selection → 颜色 popover。和 `ReaderSelectionPopover`（EPUB 用）同款交互：
 *
 * 1. `selectionchange` + `mouseup` + `touchend` 触发 refresh（rAF 防抖）
 * 2. 选区 range 必须**完全落在** `<div data-page-index="N">` 一个容器内，否则忽略
 *    （跨页选择暂不支持；和归一化坐标不兼容）
 * 3. 计算 `range.getClientRects()` → 相对 page 容器归一化为 [0..1]
 * 4. popover 位置 = 选区顶部 - 44px，颜色按钮 onMouseDown preventDefault 保留 selection
 * 5. 点颜色按钮 → 调 onConfirm → 清选区、隐藏 popover
 *
 * 注意：和 EPUB 的 popover 不同，PDF 不走 iframe，选中事件直接挂在主 document 上。
 */
export function PdfSelectionPopover({ scrollRootRef, onConfirm, onAIExplain }: Props) {
  const [info, setInfo] = useState<SelInfo | null>(null)
  const rafRef = useRef<number | null>(null)
  const mode = useLayoutMode()
  const touch = mode !== 'desktop'

  useEffect(() => {
    const refresh = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const root = scrollRootRef.current
        if (!root) {
          setInfo(null)
          return
        }
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setInfo(null)
          return
        }
        const range = sel.getRangeAt(0)
        // 起点 & 终点都必须在 scrollRoot 内（排除 toolbar / 侧栏）
        if (
          !root.contains(range.startContainer) ||
          !root.contains(range.endContainer)
        ) {
          setInfo(null)
          return
        }
        // 找到承载选区的页容器：起点向上找最近的 [data-page-index]
        const startEl =
          range.startContainer.nodeType === Node.ELEMENT_NODE
            ? (range.startContainer as Element)
            : range.startContainer.parentElement
        const pageEl = startEl?.closest<HTMLElement>('[data-page-index]')
        if (!pageEl) {
          setInfo(null)
          return
        }
        // 跨页选择不支持
        const endEl =
          range.endContainer.nodeType === Node.ELEMENT_NODE
            ? (range.endContainer as Element)
            : range.endContainer.parentElement
        const endPageEl = endEl?.closest<HTMLElement>('[data-page-index]')
        if (endPageEl !== pageEl) {
          setInfo(null)
          return
        }
        const pageIndex = Number(pageEl.dataset.pageIndex)
        if (!Number.isFinite(pageIndex)) {
          setInfo(null)
          return
        }
        const pageRect = pageEl.getBoundingClientRect()
        if (pageRect.width <= 0 || pageRect.height <= 0) {
          setInfo(null)
          return
        }
        const clientRects = Array.from(range.getClientRects()).filter(
          (r) => r.width > 1 && r.height > 1
        )
        if (clientRects.length === 0) {
          setInfo(null)
          return
        }
        const rawRects: PdfNormRect[] = clientRects.map((r) => ({
          x: (r.left - pageRect.left) / pageRect.width,
          y: (r.top - pageRect.top) / pageRect.height,
          w: r.width / pageRect.width,
          h: r.height / pageRect.height,
        }))
        // 合并同行碎片化 rect，消除 textLayer span 之间的 1-2px 视觉缝隙
        const rects = mergePdfRectsByLine(rawRects)
        const selectedText = sel.toString().trim()
        if (!selectedText) {
          setInfo(null)
          return
        }
        // popover 锚定到选区第一行（最上面 rect）的中心顶端
        const top = clientRects[0].top
        const bottom = clientRects[clientRects.length - 1].bottom
        const center =
          (Math.min(...clientRects.map((r) => r.left)) +
            Math.max(...clientRects.map((r) => r.right))) /
          2
        setInfo({
          popoverTop: top,
          popoverBottom: bottom,
          popoverLeft: center,
          pageIndex,
          rects,
          selectedText,
        })
      })
    }

    document.addEventListener('selectionchange', refresh)
    // mouseup/touchend：兼容 selectionchange 在某些浏览器对 keyboard selection 不发的场景
    const root = scrollRootRef.current
    root?.addEventListener('mouseup', refresh)
    root?.addEventListener('touchend', refresh)
    // 滚动 / 缩放时刷新位置（选区还在但容器移动了）
    const onScroll = () => refresh()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('selectionchange', refresh)
      root?.removeEventListener('mouseup', refresh)
      root?.removeEventListener('touchend', refresh)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [scrollRootRef])

  if (!info) return null

  const popoverH = touch ? 56 : 44
  // 触屏放选区下方避开 Android 系统选择气泡（同 ReaderSelectionPopover 策略）
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight
  let top: number
  if (touch) {
    const below = info.popoverBottom + 60
    if (below + popoverH < viewportH - 20) top = below
    else top = Math.max(info.popoverTop - popoverH - 80, 8)
  } else {
    top = Math.max(info.popoverTop - popoverH, 8)
  }
  const left = info.popoverLeft

  const commit = async (color: HighlightColorKey) => {
    const snapshot = info
    setInfo(null)
    // 清掉浏览器选区，避免视觉上残留（高亮 overlay 会立刻补上）
    window.getSelection()?.removeAllRanges()
    try {
      await onConfirm({
        pageIndex: snapshot.pageIndex,
        rects: snapshot.rects,
        selectedText: snapshot.selectedText,
        color,
      })
    } catch (e) {
      console.warn('[PdfSelectionPopover] commit failed', e)
    }
  }

  const handleAIExplain = () => {
    const text = info.selectedText
    setInfo(null)
    window.getSelection()?.removeAllRanges()
    if (!text || !onAIExplain) return
    try {
      onAIExplain(text)
    } catch (e) {
      console.warn('[PdfSelectionPopover] aiExplain failed', e)
    }
  }

  const iconBox = touch ? 'h-11 w-11' : 'h-7 w-7'
  const iconSize = touch ? 'h-5 w-5' : 'h-3.5 w-3.5'
  const colorChip = touch ? 'h-11 w-11' : 'h-5 w-5'
  const chipInner = touch
    ? 'mx-auto h-7 w-7 rounded-full border border-black/10'
    : 'h-full w-full rounded-full border border-black/10'

  return createPortal(
    <div
      role="toolbar"
      aria-label="选区操作"
      className={cn(
        'fixed z-[1000] flex items-center rounded-lg border border-border-1 bg-popover shadow-2xl ring-1 ring-black/5 backdrop-blur',
        touch ? 'gap-1 px-2 py-1.5' : 'gap-1 px-1.5 py-1'
      )}
      style={{ top, left, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => {
        if (e.target === e.currentTarget) e.preventDefault()
      }}
    >
      <span
        className={cn('flex items-center justify-center text-text-3', iconBox)}
        title="高亮颜色"
        aria-hidden
      >
        <Highlighter className={iconSize} />
      </span>
      {(Object.keys(HIGHLIGHT_COLORS) as HighlightColorKey[]).map((k) => (
        <button
          key={k}
          type="button"
          title={`${k} 高亮`}
          onMouseDown={(e) => {
            e.preventDefault()
            commit(k)
          }}
          className={cn(
            'flex items-center justify-center rounded-full transition-transform hover:scale-110 active:scale-95',
            colorChip
          )}
          style={touch ? undefined : { background: HIGHLIGHT_COLORS[k] }}
        >
          {touch ? (
            <span
              className={chipInner}
              style={{ background: HIGHLIGHT_COLORS[k] }}
              aria-hidden
            />
          ) : null}
        </button>
      ))}
      {onAIExplain && (
        <>
          <span
            className={cn('mx-0.5 w-px self-stretch bg-border-1', touch ? 'my-1' : 'my-0.5')}
            aria-hidden
          />
          <button
            type="button"
            title="AI 解释选区"
            onMouseDown={(e) => {
              e.preventDefault()
              handleAIExplain()
            }}
            className={cn(
              'flex items-center justify-center gap-1 rounded-md text-text-1 transition-colors hover:bg-surface-2 active:bg-surface-3',
              touch ? 'h-11 px-3 text-sm' : 'h-7 px-2 text-xs'
            )}
          >
            <Sparkles className={iconSize} />
            <span>AI</span>
          </button>
        </>
      )}
    </div>,
    document.body
  )
}
