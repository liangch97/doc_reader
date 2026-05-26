import { Highlighter, Bold, Italic, Code as CodeIcon, Strikethrough, ALargeSmall, AArrowUp } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'

export interface BubbleRect {
  left: number
  top: number
  width: number
  height: number
}

export interface BubbleState {
  rect: BubbleRect
  highlight: boolean
  bold: boolean
  italic: boolean
  code: boolean
  strike: boolean
  /** 当前块是否是 H2/H3（“字号加大”表现为块级列表中的现性状态） */
  heading?: 0 | 2 | 3
}

interface Props {
  state: BubbleState | null
  onToggleHighlight: () => void
  onToggleBold: () => void
  onToggleItalic: () => void
  onToggleCode: () => void
  onToggleStrike: () => void
  onLargerSize: () => void
  onSmallerSize: () => void
}

/**
 * 选区悬浮菜单（BubbleMenu）。
 *
 * 选中编辑器内文本后浮在选区上方；空选区或失焦时不渲染。
 * 使用 fixed 定位 + ProseMirror `coordsAtPos()` 给出的视口坐标。
 *
 * 注意：所有按钮使用 `onMouseDown + preventDefault` 来避免触发 blur 导致选区丢失。
 */
export function EditorBubbleMenu({
  state,
  onToggleHighlight,
  onToggleBold,
  onToggleItalic,
  onToggleCode,
  onToggleStrike,
  onLargerSize,
  onSmallerSize,
}: Props) {
  if (!state) return null

  // Anchor above the selection, centered on selection horizontally.
  const top = Math.max(state.rect.top - 44, 8)
  const left = state.rect.left + state.rect.width / 2

  // Render via Portal to document.body so any ancestor with `transform`,
  // `filter`, `will-change` (very common in app shells) cannot break the
  // `position: fixed` viewport anchoring, and so overflow-hidden ancestors
  // can't clip the bubble.
  const bubble = (
    <div
      role="toolbar"
      aria-label="文字格式"
      className="fixed z-[1000] flex items-center gap-0.5 rounded-md border border-border-1 bg-popover px-1 py-1 shadow-2xl ring-1 ring-black/5 backdrop-blur"
      style={{ top, left, transform: 'translateX(-50%)' }}
      onMouseDown={(e) => {
        // Preserve editor selection while interacting with the bubble.
        e.preventDefault()
      }}
    >
      <BubbleBtn icon={Highlighter} title="高亮（==）" active={state.highlight} onClick={onToggleHighlight} accent="yellow" />
      <Divider />
      <BubbleBtn icon={Bold} title="加粗 ⌘B" active={state.bold} onClick={onToggleBold} />
      <BubbleBtn icon={Italic} title="斜体 ⌘I" active={state.italic} onClick={onToggleItalic} />
      <BubbleBtn icon={CodeIcon} title="行内代码" active={state.code} onClick={onToggleCode} />
      <BubbleBtn icon={Strikethrough} title="删除线" active={state.strike} onClick={onToggleStrike} />
      <Divider />
      <BubbleBtn
        icon={AArrowUp}
        title="字号加大（升为标题）"
        active={state.heading === 2 || state.heading === 3}
        onClick={onLargerSize}
      />
      <BubbleBtn icon={ALargeSmall} title="字号还原（恢复为正文）" active={false} onClick={onSmallerSize} />
    </div>
  )
  if (typeof document === 'undefined') return null
  return createPortal(bubble, document.body)
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-border-1" />
}

interface BtnProps {
  icon: LucideIcon
  title: string
  active: boolean
  onClick: () => void
  /** Optional accent: when active, paints differently (e.g. highlight stays yellow). */
  accent?: 'yellow'
}

function BubbleBtn({ icon: Icon, title, active, onClick, accent }: BtnProps) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded transition-colors',
        active
          ? accent === 'yellow'
            ? 'bg-yellow-400/25 text-yellow-300'
            : 'bg-surface-3 text-text-1'
          : 'text-text-2 hover:bg-surface-2 hover:text-text-1'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}
