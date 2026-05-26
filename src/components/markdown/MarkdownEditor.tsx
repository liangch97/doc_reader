import { Crepe } from '@milkdown/crepe'
import { prosePluginsCtx, editorViewCtx } from '@milkdown/core'
import type { EditorView } from '@milkdown/prose/view'
import type { MarkType, NodeType } from '@milkdown/prose/model'
import { toggleMark } from '@milkdown/prose/commands'
import { TextSelection } from '@milkdown/prose/state'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { highlightDecorationPlugin, toggleHighlight } from './milkdownHighlight'
import { EditorBubbleMenu, type BubbleState } from './EditorBubbleMenu'
import { renumberOrderedLists } from './preprocessor'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
// markdown.css must load AFTER crepe so our padding / typography overrides win
import './markdown.css'

interface Props {
  /** Initial markdown content (uncontrolled — editor owns state after mount) */
  defaultValue: string
  /** Called with latest markdown after each edit (debounced upstream if needed) */
  onChange?: (markdown: string) => void
  /** Read-only mode */
  readOnly?: boolean
  /** Optional class on the wrapper div */
  className?: string
}

export interface MarkdownEditorHandle {
  /** Toggle `==text==` highlight on the current selection */
  toggleHighlight: () => void
  /** Focus the editor */
  focus: () => void
}

const HL_RE = /==([^=\n][^=\n]*?[^=\n]|[^=\n])==/g

/**
 * 检测当前选区所在块的 heading level（0=非标题；2/3=H2/H3 等）。
 * 用于 BubbleMenu 高亮"字号加大"按钮的现态。
 */
function detectHeadingLevel(view: EditorView): 0 | 2 | 3 {
  const { state } = view
  const { $from } = state.selection
  const node = $from.node($from.depth)
  if (!node) return 0
  if (node.type.name !== 'heading') return 0
  const lvl = Number((node.attrs as Record<string, unknown>).level ?? 0)
  if (lvl === 2) return 2
  if (lvl === 3) return 3
  return 0
}

/**
 * Detect whether the current selection is fully inside an `==…==` highlight span.
 * 与 `milkdownHighlight.ts` 中 `buildDecorations` 同款 textblock 扫描，可正确处理
 * 高亮内文本被其他 mark（bold/italic/...）切成多段的情况。
 */
function detectHighlightActive(view: EditorView): boolean {
  const { state } = view
  const { from, to, empty } = state.selection
  if (empty) return false
  let active = false
  state.doc.descendants((block, blockPos) => {
    if (active) return false
    if (!block.isTextblock) return true
    const blockStart = blockPos + 1
    const blockEnd = blockPos + 1 + block.content.size
    if (to < blockStart || from > blockEnd) return false
    let combined = ''
    const offsets: { start: number; end: number; docPos: number }[] = []
    block.forEach((child, childOffset) => {
      if (!child.isText || !child.text) return
      const start = combined.length
      combined += child.text
      offsets.push({ start, end: combined.length, docPos: blockPos + 1 + childOffset })
    })
    if (!combined) return false
    const mapToDocPos = (charIdx: number): number => {
      for (const seg of offsets) {
        if (charIdx >= seg.start && charIdx <= seg.end) {
          return seg.docPos + (charIdx - seg.start)
        }
      }
      const last = offsets[offsets.length - 1]
      return last ? last.docPos + (last.end - last.start) : blockStart
    }
    HL_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HL_RE.exec(combined)) !== null) {
      const innerStart = mapToDocPos(m.index + 2)
      const innerEnd = mapToDocPos(m.index + 2 + m[1].length)
      if (from >= innerStart && to <= innerEnd) {
        active = true
        return false
      }
    }
    return false
  })
  return active
}

/**
 * WYSIWYG Markdown editor powered by Milkdown Crepe.
 *
 * - Block-handle (+/drag) feature disabled to avoid conflicts with our
 *   custom fenced-block NodeViews.
 * - Custom NodeView for 5 fenced kinds (flashcards/qa/cornell/mindmap/concept).
 * - Decoration-based `==xxx==` highlight via `highlightDecorationPlugin`.
 * - Selection bubble menu with highlight / bold / italic / code / strike.
 * - Imperative `toggleHighlight()` exposed via ref (kept for legacy callers).
 *
 * Uncontrolled by design: parent passes `defaultValue` once; subsequent
 * markdown is reported via `onChange`. Re-mounting (key prop) is the way
 * to switch between different documents.
 */
export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor(
  { defaultValue, onChange, readOnly, className },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [bubble, setBubble] = useState<BubbleState | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ left: number; top: number } | null>(null)
  const [initError, setInitError] = useState<string>('')
  // Imperative handle from the effect for triggering bubble refresh after
  // mark toggles where the selection itself does not change.
  const refreshBubbleRef = useRef<() => void>(() => {})
  // 缓存"上一次非空 selection"的端点。bubble 工具栏按钮触发的 dispatch
  // 过程中可能瞬时把 selection 塌缩，setBlockType(from,to) 拿到的 from===to
  // 就什么都不会做。stash 让 bumpHeading/resetHeading 永远有合理的端点。
  const lastRangeRef = useRef<{ from: number; to: number } | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    // 初次打开编辑器时，把传入的 markdown 过一遍编号重写：
    // 让被空行 / 段落打断的多段有序列表跨段连续编号（"单个笔记内编号有序"）。
    // Milkdown / ProseMirror 自身只在单段 ol 内规范化编号；多段 ol 之间不连号
    // —— 所以必须在 defaultValue 阶段就把内容洗一次，让用户看到的初始内容
    // 与只读视图（MarkdownView）保持一致。
    const initial = renumberOrderedLists(defaultValue || '')
    const crepe = new Crepe({
      root: hostRef.current,
      defaultValue: initial,
      features: {
        // Disable Crepe's built-in slash/+ block menu — we do our own.
        [Crepe.Feature.BlockEdit]: false,
        // Disable Crepe's built-in selection toolbar (B / I / S / code / latex / link)
        // because it has no highlight button and clashes with our EditorBubbleMenu.
        [Crepe.Feature.Toolbar]: false,
        // 注：以前曾尝试 `[Crepe.Feature.CodeMirror]: false`（让代码块走原生 <pre>）
        // 以修复 ASCII 框线图列错位问题。但禁用 CodeMirror 会牵连 Latex 特性
        // （"You need to enable CodeMirror to use LaTeX feature"）→ Crepe init
        // 抛错 → 笔记区整页空白；进一步同时禁用 Latex 又触发了上下文初始化
        // 链路里的一些副作用，导致 PDF / 整个应用渲染卡死。
        // 折中方案：保留两者，通过 markdown.css 给 CodeMirror code area 强制
        // 等宽 + tabular-nums，让 ASCII 图至少不再错位。
      },
    })
    crepeRef.current = crepe

    crepe.editor.config((ctx) => {
      // 注意：不再覆盖 code_block NodeView —— Crepe 的 CodeMirror 特性会接管，
      // 给代码块带语法高亮 / 语言切换器 / 行号等富交互。
      const prevPlugins = ctx.get(prosePluginsCtx)
      ctx.set(prosePluginsCtx, [...prevPlugins, highlightDecorationPlugin])
    })

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        onChangeRef.current?.(markdown)
      })
    })

    // ── Selection-driven bubble menu ──────────────────────────────────────
    // Compute current selection rect + active marks and update React state.
    // Triggered by browser-level selection / mouse / keyboard events for
    // maximum reliability across mouse drag, double-click, keyboard select,
    // and IME-driven changes.
    const refreshBubble = () => {
      const view = viewRef.current
      if (!view) return
      const { state } = view
      const { selection } = state
      if (selection.empty) {
        // 关键：当 selection 暂时塌缩（例如 setBlockType 调度过程中，
        // ProseMirror 重建当前块 DOM 导致瞬时 selectionchange），
        // 如果焦点仍在 bubble 工具栏内，**不要**把 bubble 拆掉，
        // 否则用户连点第二次"字号加大"时按钮已经不在了。
        const active = document.activeElement as HTMLElement | null
        if (active && active.closest('[role="toolbar"]')) return
        setBubble(null)
        return
      }
      // If the user clicked something outside the editor that isn't our
      // bubble menu, hide. The bubble itself uses role="toolbar".
      const active = document.activeElement as HTMLElement | null
      if (
        active &&
        !view.dom.contains(active) &&
        active.closest('[role="toolbar"]') == null
      ) {
        setBubble(null)
        return
      }
      const { from, to } = selection
      lastRangeRef.current = { from, to }
      let start: { left: number; right: number; top: number; bottom: number }
      let end: { left: number; right: number; top: number; bottom: number }
      try {
        start = view.coordsAtPos(from)
        end = view.coordsAtPos(to)
      } catch {
        setBubble(null)
        return
      }
      const left = Math.min(start.left, end.left)
      const right = Math.max(start.right, end.right)
      const top = Math.min(start.top, end.top)
      const bottom = Math.max(start.bottom, end.bottom)
      const rect = {
        left,
        top,
        width: Math.max(right - left, 1),
        height: Math.max(bottom - top, 18),
      }
      const has = (name: string): boolean => {
        const type: MarkType | undefined = state.schema.marks[name]
        if (!type) return false
        return state.doc.rangeHasMark(from, to, type)
      }
      setBubble({
        rect,
        highlight: detectHighlightActive(view),
        bold: has('strong'),
        // Milkdown 7.x 不同预设下斜体 mark 可能名为 'em' 或 'emphasis'。
        italic: has('em') || has('emphasis'),
        code: has('code'),
        // gfm strikethrough mark name varies by package version
        strike: has('strike_through') || has('strikethrough'),
        heading: detectHeadingLevel(view),
      })
    }
    // Debounce via rAF so we read the post-update state, not the in-flight one.
    let pendingRaf = 0
    const schedule = () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = 0
        refreshBubble()
      })
    }
    // Expose to component scope so imperative handlers (toggle*) can
    // re-evaluate the bubble after dispatching a mark transaction.
    refreshBubbleRef.current = schedule

    const host = hostRef.current
    document.addEventListener('selectionchange', schedule)
    host?.addEventListener('mouseup', schedule)
    host?.addEventListener('keyup', schedule)

    // Hide bubble on outside scroll/resize so it doesn't drift.
    const onScroll = () => setBubble(null)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)

    // Now that schedule/refreshBubble are defined, kick off Crepe and
    // capture the EditorView via Milkdown's editorViewCtx — the most
    // reliable path that bypasses any quirks with prose plugin loading.
    crepe
      .create()
      .then(() => {
        try {
          crepe.editor.action((ctx) => {
            viewRef.current = ctx.get(editorViewCtx)
            schedule()
          })
        } catch (err) {
          const msg = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
          console.error('[MarkdownEditor] post-create action failed:', err)
          setInitError(`post-create: ${msg}`)
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err)
        console.error('[MarkdownEditor] crepe.create() failed:', err)
        setInitError(`crepe.create(): ${msg}`)
      })

    return () => {
      if (pendingRaf) cancelAnimationFrame(pendingRaf)
      document.removeEventListener('selectionchange', schedule)
      host?.removeEventListener('mouseup', schedule)
      host?.removeEventListener('keyup', schedule)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      try {
        crepe.destroy()
      } catch {
        /* ignore */
      }
      crepeRef.current = null
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const crepe = crepeRef.current
    if (!crepe) return
    crepe.setReadonly(!!readOnly)
  }, [readOnly])

  const runOnView = (fn: (view: EditorView) => void) => {
    const view = viewRef.current
    if (!view) return
    fn(view)
  }

  const toggleSchemaMark = (names: string[]) => {
    runOnView((view) => {
      const type = names.map((n) => view.state.schema.marks[n]).find(Boolean) as MarkType | undefined
      if (!type) return
      toggleMark(type)(view.state, view.dispatch)
      view.focus()
    })
    // Selection range usually doesn't change on mark toggles, so the
    // selectionchange event won't refresh the bubble — do it manually.
    refreshBubbleRef.current()
  }

  const doToggleHighlight = () => {
    runOnView((view) => toggleHighlight(view))
    refreshBubbleRef.current()
  }

  /**
   * 「字号加大 / 还原」实现思路：Markdown 本身没有 font-size 语义，给满“能复制为纯md”的前提下，
   * 用 heading 代替：选中段落 → 提升为 h3 （不明显过大），再点一次提升为 h2。
   * 「字号还原」则把当前块转回普通段落。这是 WYSIWYG 中常见的“字号」交互近似。
   */
  /**
   * 字号加大：para → h3 → h2 → para（循环），且支持跨行选区一并转换。
   * 选区跨多块时，把覆盖到的每一块都转成同一目标层级，避免之前"只生效首块"
   * 的异常体验。
   */
  const bumpHeading = () => {
    runOnView((view) => {
      const { state, dispatch } = view
      const heading = state.schema.nodes.heading
      const paragraph = state.schema.nodes.paragraph
      if (!heading || !paragraph) return
      // 优先用 stash 的最后一次非空 selection，回退到当前 state.selection。
      // 这样即使 bubble click 把 DOM selection 弄塌缩了，也能命中用户**真正**选中的区域。
      const stash = lastRangeRef.current
      const fromPos = stash ? stash.from : state.selection.from
      const toPos = stash ? stash.to : state.selection.to
      const $from = state.doc.resolve(fromPos)
      const blockNode = $from.node($from.depth)
      // 决定下一级：基于当前块（光标所在块）来推
      // 循环顺序：paragraph → h3 → h2 → h1 → paragraph
      // h1 是 1.65em，相比 h2(1.35em) 进一步放大，匹配用户"希望更大"的诉求。
      let nextType = heading
      let nextAttrs: { level?: number } = { level: 3 }
      if (blockNode.type === heading) {
        const cur = Number((blockNode.attrs as Record<string, unknown>).level ?? 3)
        if (cur <= 1) {
          // 已到顶（h1）→ 循环回 paragraph
          nextType = paragraph
          nextAttrs = {}
        } else {
          // h3 / h2 → 上一级（h2 / h1）
          nextAttrs = { level: cur - 1 }
        }
      }
      let tr = state.tr
      try {
        tr = tr.setBlockType(fromPos, toPos, nextType, nextAttrs)
      } catch (err) {
        console.warn('[bumpHeading] setBlockType failed:', err)
        return
      }
      dispatch(tr.scrollIntoView())
      view.focus()
    })
    refreshBubbleRef.current()
  }

  const resetHeading = () => {
    runOnView((view) => {
      const { state, dispatch } = view
      const paragraph = state.schema.nodes.paragraph
      if (!paragraph) return
      const stash = lastRangeRef.current
      const fromPos = stash ? stash.from : state.selection.from
      const toPos = stash ? stash.to : state.selection.to
      let tr = state.tr
      try {
        tr = tr.setBlockType(fromPos, toPos, paragraph)
      } catch (err) {
        console.warn('[resetHeading] setBlockType failed:', err)
        return
      }
      dispatch(tr.scrollIntoView())
      view.focus()
    })
    refreshBubbleRef.current()
  }

  /** 在当前位置插入一个空代码块（独占一行）。 */
  const insertCodeBlock = () => {
    runOnView((view) => {
      const { state, dispatch } = view
      const codeBlock: NodeType | undefined = state.schema.nodes.code_block
      if (!codeBlock) return
      const node = codeBlock.create({ language: '' })
      const { $from } = state.selection
      let tr = state.tr
      // 在 textblock 中间插入时，在当前块口后面插入新块，
      // 避免裂块引起的语义错位。
      if ($from.parent.isTextblock && $from.parent.content.size > 0) {
        const insertPos = $from.after($from.depth)
        tr = tr.insert(insertPos, node)
        const $pos = tr.doc.resolve(insertPos + 1)
        tr = tr.setSelection(TextSelection.near($pos))
      } else {
        tr = tr.replaceSelectionWith(node)
        const pos = tr.selection.from - 1
        if (pos > 0) {
          const $pos = tr.doc.resolve(pos)
          tr = tr.setSelection(TextSelection.near($pos))
        }
      }
      dispatch(tr.scrollIntoView())
      view.focus()
    })
    setCtxMenu(null)
  }

  const insertHorizontalRule = () => {
    runOnView((view) => {
      const { state, dispatch } = view
      const hr = state.schema.nodes.hr || state.schema.nodes.horizontal_rule
      if (!hr) return
      dispatch(state.tr.replaceSelectionWith(hr.create()).scrollIntoView())
      view.focus()
    })
    setCtxMenu(null)
  }

  const onHostContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    // 只接管发生在编辑器 ProseMirror 区域内的右键
    const view = viewRef.current
    if (!view) return
    if (!view.dom.contains(e.target as Node)) return
    e.preventDefault()
    setCtxMenu({ left: e.clientX, top: e.clientY })
  }

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      toggleHighlight: doToggleHighlight,
      focus: () => runOnView((view) => view.focus()),
    }),
    []
  )

  return (
    <>
      <div ref={hostRef} className={className} onContextMenu={onHostContextMenu} />
      {initError && (
        <pre
          style={{
            margin: '8px',
            padding: '8px',
            background: 'rgba(255, 80, 80, 0.1)',
            color: '#c33',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderRadius: 4,
            border: '1px solid rgba(255, 80, 80, 0.35)',
          }}
        >
          [MarkdownEditor init error]
          {'\n'}
          {initError}
        </pre>
      )}
      <EditorBubbleMenu
        state={bubble}
        onToggleHighlight={doToggleHighlight}
        onToggleBold={() => toggleSchemaMark(['strong'])}
        onToggleItalic={() => toggleSchemaMark(['em', 'emphasis'])}
        onToggleCode={() => toggleSchemaMark(['code'])}
        onToggleStrike={() => toggleSchemaMark(['strike_through', 'strikethrough'])}
        onLargerSize={bumpHeading}
        onSmallerSize={resetHeading}
      />
      {ctxMenu && (
        <EditorContextMenu
          left={ctxMenu.left}
          top={ctxMenu.top}
          onClose={() => setCtxMenu(null)}
          actions={[
            { label: '插入代码块', shortcut: '```', onClick: insertCodeBlock },
            { label: '插入行内代码', shortcut: '⌘E', onClick: () => { toggleSchemaMark(['code']); setCtxMenu(null) } },
            { label: '插入分隔线', shortcut: '---', onClick: insertHorizontalRule },
            { label: '转为高亮', shortcut: '==', onClick: () => { doToggleHighlight(); setCtxMenu(null) } },
          ]}
        />
      )}
    </>
  )
})

interface CtxAction {
  label: string
  shortcut?: string
  onClick: () => void
}

function EditorContextMenu({
  left,
  top,
  actions,
  onClose,
}: {
  left: number
  top: number
  actions: CtxAction[]
  onClose: () => void
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('[data-editor-ctx-menu]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  // clamp inside viewport
  const W = 200
  const adjLeft = Math.min(left, window.innerWidth - W - 8)
  const adjTop = Math.min(top, window.innerHeight - actions.length * 32 - 16)
  return (
    <div
      data-editor-ctx-menu
      role="menu"
      className="fixed z-[1000] min-w-[200px] overflow-hidden rounded-md border border-border-1 bg-popover py-1 text-xs text-text-1 shadow-2xl"
      style={{ left: adjLeft, top: adjTop }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          role="menuitem"
          onClick={a.onClick}
          className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-surface-2"
        >
          <span>{a.label}</span>
          {a.shortcut && <span className="text-[10px] text-text-3">{a.shortcut}</span>}
        </button>
      ))}
    </div>
  )
}
