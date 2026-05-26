import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Highlighter, Sparkles } from 'lucide-react'
import { HIGHLIGHT_COLORS, type HighlightColorKey } from '@/lib/foliate'
import { useLayoutMode } from '@/lib/useLayoutMode'
import { cn } from '@/lib/cn'

interface SelRect {
  left: number
  top: number
  /** 选区底部 y（视口坐标），用于触屏把自定义气泡放到选区下方避开系统气泡 */
  bottom: number
  width: number
}

/**
 * 最小 view 接口：既要能读 contents，也要能 addEventListener 'load'
 * （foliate-view 是 EventTarget；每次新 section iframe 加载都会 emit 'load'）。
 */
interface SelectionView extends EventTarget {
  renderer?: { getContents?: () => Array<{ doc: Document; index: number }> }
}

interface Props {
  /** foliate-view DOM 元素；用于读取 iframe 内的选区 */
  view: SelectionView | null
  /** 触发高亮的回调，由 useAnnotations 提供（内部会读 selection / 创建 cfi / 写库） */
  onAddHighlight: (color: HighlightColorKey) => void | Promise<void>
  /**
   * "AI 解释"入口；接收当前选中文本。
   * 不传则不渲染 AI 按钮（PDF / 桌面想关闭该入口时直接省略即可）。
   */
  onAIExplain?: (selectedText: string) => void
}

/**
 * 阅读区选中文本时弹出的浮动颜色高亮条。
 *
 * 替代旧版工具栏右上角的「高亮」hover popover —— 触点放回到选区上方，更符合直觉。
 *
 * 实现要点：
 * 1. foliate-view 通过 `<iframe>` 渲染图书内容，所以选区监听必须挂在每个 iframe 的 document 上。
 * 2. 通过 view.renderer.getContents() 拿到当前可见 contents 数组（每项含 doc / index）。
 * 3. 选区坐标 → 用 range.getBoundingClientRect()，但需要叠加 iframe 在主窗口的偏移。
 * 4. 颜色按钮点击后调用 onAddHighlight(color)，由 useAnnotations.addFromSelection 拿当前选区
 *    创建 CFI、写库 + 在 view 里 addAnnotation。
 *
 * 注意：调用 onAddHighlight 后，foliate 自身会清除选区；这里也立即 setRect(null) 隐藏自己。
 */
export function ReaderSelectionPopover({ view, onAddHighlight, onAIExplain }: Props) {
  const [rect, setRect] = useState<SelRect | null>(null)
  /** 缓存"当前选中的文本"，AI 按钮按下时直接取——避免 mousedown 触发后 selection 被清空读不到 */
  const selectedTextRef = useRef<string>('')
  // 防抖句柄；selectionchange 高频触发
  const rafRef = useRef<number | null>(null)
  const mode = useLayoutMode()
  const touch = mode !== 'desktop'

  useEffect(() => {
    if (!view) return
    const renderer = view.renderer
    if (!renderer?.getContents) return

    // 1) 拿到所有 iframe document，注册 selection 监听
    const cleanups: Array<() => void> = []

    const refresh = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const contents = renderer.getContents?.() ?? []
        for (const c of contents) {
          const sel = c.doc.defaultView?.getSelection()
          if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
            const range = sel.getRangeAt(0)
            const r = range.getBoundingClientRect()
            // 叠加 iframe 偏移
            const iframe = c.doc.defaultView?.frameElement as HTMLElement | null
            const off = iframe?.getBoundingClientRect()
            if (!off) continue
            const left = off.left + r.left
            const top = off.top + r.top
            const bottom = off.top + r.bottom
            const width = Math.max(r.width, 1)
            // 选区高度太小（光标）→ 不弹
            if (r.height < 4) continue
            selectedTextRef.current = sel.toString()
            setRect({ left, top, bottom, width })
            return
          }
        }
        setRect(null)
      })
    }

    // 已绑定过的 doc 集合，避免重复 addEventListener（每次 'load' 重新 attach
    // 时旧 iframe 的 doc 已被销毁，新 doc 必然是新引用，集合自然过滤）。
    const boundDocs = new WeakSet<Document>()

    const attach = () => {
      const contents = renderer.getContents?.() ?? []
      for (const c of contents) {
        if (boundDocs.has(c.doc)) continue
        boundDocs.add(c.doc)
        const onSelChange = () => refresh()
        const onMouseUp = () => refresh()
        const onTouchEnd = () => refresh()
        c.doc.addEventListener('selectionchange', onSelChange)
        c.doc.addEventListener('mouseup', onMouseUp)
        c.doc.addEventListener('touchend', onTouchEnd)
        cleanups.push(() => {
          c.doc.removeEventListener('selectionchange', onSelChange)
          c.doc.removeEventListener('mouseup', onMouseUp)
          c.doc.removeEventListener('touchend', onTouchEnd)
        })
      }
    }
    attach()
    // 关键修复：view ready 时 contents 经常还没准备好（首屏首 section 是异步 load 的），
    // 必须监听 view 'load' 在每个 section iframe 装载时重新 attach；
    // 翻页（next/prev 切到新 section）也复用这个事件流。
    const onViewLoad = () => {
      // 用 setTimeout 让 paginator 有时间把 doc 注入 contents 数组
      window.setTimeout(attach, 0)
    }
    view.addEventListener('load', onViewLoad)
    // 初始化时 contents 可能还没注入；延迟一两帧再尝试一次（首屏冷启动场景）
    const initTimer1 = window.setTimeout(attach, 50)
    const initTimer2 = window.setTimeout(attach, 300)

    // 滚动 / 缩放时也刷新位置（粗粒度即可）
    const onScroll = () => refresh()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)

    return () => {
      cleanups.forEach((f) => f())
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      view.removeEventListener('load', onViewLoad)
      window.clearTimeout(initTimer1)
      window.clearTimeout(initTimer2)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [view])

  if (!rect) return null

  // 触控布局下 popover 整体更高（colorChip 44px + padding），需要更多顶部空隙
  const popoverH = touch ? 56 : 44
  /**
   * 触屏：放选区下方至少 60px，避开 Android / iPadOS 系统选择气泡（系统气泡
   * 默认锚定在选区上方）；下方空间不足时退到上方更远 (-100px)，再不行夹到视口顶部。
   * 桌面：保持选区正上方紧贴。
   */
  const viewportH = typeof window === 'undefined' ? 800 : window.innerHeight
  let top: number
  if (touch) {
    const below = rect.bottom + 60
    if (below + popoverH < viewportH - 20) top = below
    else top = Math.max(rect.top - popoverH - 80, 8)
  } else {
    top = Math.max(rect.top - popoverH, 8)
  }
  const left = rect.left + rect.width / 2

  const handle = async (color: HighlightColorKey) => {
    setRect(null)
    try {
      await onAddHighlight(color)
    } catch (e) {
      console.warn('[ReaderSelectionPopover] addHighlight failed', e)
    }
  }

  const handleAIExplain = () => {
    const text = selectedTextRef.current.trim()
    setRect(null)
    if (!text || !onAIExplain) return
    try {
      onAIExplain(text)
    } catch (e) {
      console.warn('[ReaderSelectionPopover] aiExplain failed', e)
    }
  }

  // ─── 尺寸 token：触控 44px / 桌面 28px，集中在此处一处定义 ───────────────
  const iconBox = touch ? 'h-11 w-11' : 'h-7 w-7'
  const iconSize = touch ? 'h-5 w-5' : 'h-3.5 w-3.5'
  const colorChip = touch ? 'h-11 w-11' : 'h-5 w-5'
  // 触控时按钮内部颜色块缩一圈，看上去仍然像"小圆点"而非按钮本身
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
      // 阻止 mousedown 默认行为以保留选区，让浏览器在我们调用 onAddHighlight
      // 之前不要因为按钮 focus 抢走 selection。
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => {
        // 触屏同理：阻止默认的 caret 重定位，但仍允许子按钮自己的 onClick / onTouchEnd 触发
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
            handle(k)
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
