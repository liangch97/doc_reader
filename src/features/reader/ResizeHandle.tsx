import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/cn'

interface Props {
  /** 当前宽度（px） */
  width: number
  /** 范围 */
  min?: number
  max?: number
  /** 改动哪一边：'left' = 拖右把手向左收，'right' = 拖左把手向左扩 */
  side: 'left' | 'right'
  onChange: (width: number) => void
  className?: string
  /**
   * 可选折叠回调。传入后 hover 分隔条会在中部浮现一枚圆形折叠按钮，
   * 点击触发 onCollapse。不传 = 无折叠按钮，handle 仅用于拖拽。
   *
   * 视觉设计：和拖拽条合体，不再占据侧栏内部空间 —— 比原来悬浮 pill 更优雅：
   *  - 默认不可见（opacity 0）
   *  - hover 分隔条才浮现
   *  - 拖拽期间隐藏（避免误点）
   */
  onCollapse?: () => void
  /** 折叠按钮 aria-label / title */
  collapseLabel?: string
}

/**
 * 1px 宽的可拖拽分隔条；放在面板的内/外边缘。
 *
 * foliate-js 用 iframe 渲染 PDF/EPUB；当鼠标拖到 iframe 上时
 * mousemove 会被 iframe 内的 document 接收，外层 document 收不到，
 * 导致拖拽"卡住"。解决：拖拽期间渲染一个全屏 overlay 屏蔽 iframe，
 * 让 mousemove/mouseup 始终被外层 document 接收。
 */
export function ResizeHandle({
  width,
  min = 200,
  max = 600,
  side,
  onChange,
  className,
  onCollapse,
  collapseLabel,
}: Props) {
  const startRef = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // 折叠图标方向：左栏（side='right'）折叠时视觉上是"向左收"→ ChevronLeft；
  // 右栏（side='left'）折叠是"向右收"→ ChevronRight
  const CollapseIcon = side === 'right' ? ChevronLeft : ChevronRight

  useEffect(() => {
    if (!dragging) return
    function move(e: MouseEvent) {
      if (!startRef.current) return
      const dx = e.clientX - startRef.current.x
      const next = side === 'left' ? startRef.current.w - dx : startRef.current.w + dx
      const clamped = Math.max(min, Math.min(max, next))
      onChange(clamped)
    }
    function up() {
      startRef.current = null
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
  }, [dragging, side, min, max, onChange])

  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(e) => {
          startRef.current = { x: e.clientX, w: width }
          setDragging(true)
          document.body.style.cursor = 'col-resize'
          document.body.style.userSelect = 'none'
          e.preventDefault()
        }}
        className={cn(
          'group absolute top-0 z-10 h-full w-1.5 cursor-col-resize select-none',
          side === 'left' ? '-left-0.5' : '-right-0.5',
          className
        )}
      >
        <div className="mx-auto h-full w-px bg-border-1 transition-colors group-hover:w-0.5 group-hover:bg-accent" />
        {onCollapse && !dragging && (
          <button
            type="button"
            aria-label={collapseLabel ?? '折叠侧栏'}
            title={collapseLabel ?? '折叠侧栏'}
            onMouseDown={(e) => {
              // 拦截 mousedown 避免触发外层 handle 的拖拽
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.stopPropagation()
              onCollapse()
            }}
            className={cn(
              // 居中定位：top-1/2 + -translate-y-1/2；水平贴到分隔条中线
              'absolute top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full',
              'border border-border-1 bg-bg text-text-2 shadow-md cursor-pointer',
              // 默认隐藏，hover 分隔条或按钮自身时才浮现；focus-visible 时也显示（键盘无障碍）
              'opacity-0 transition-opacity duration-150',
              'group-hover:opacity-100 hover:!opacity-100 focus-visible:opacity-100',
              'hover:text-text-1 hover:border-accent',
              // 水平定位：side='right' 按钮悬浮在分隔条外侧（栏的内侧），
              // side='left' 对偶。用 calc 让按钮中心对齐分隔条中线。
              side === 'right' ? '-left-3' : '-right-3'
            )}
          >
            <CollapseIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {dragging && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            cursor: 'col-resize',
            background: 'transparent',
          }}
        />
      )}
    </>
  )
}
