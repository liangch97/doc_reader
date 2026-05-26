/**
 * Decoration-based `==text==` highlight for Milkdown.
 *
 * 不修改 Markdown 结构（不引入新 mark/schema），仅在编辑器视图中
 * 给匹配 `==xxx==` 的文本范围打上 inline decoration，配合 CSS 的
 * `.md-highlight-deco` 显示黄色高亮。
 *
 * 序列化时 Milkdown 仍把内容当作普通文本，`==` 字符原样保留，
 * read-only `MarkdownView` 走 `applyHighlight` 转 `<mark>` 渲染。
 */
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'
import type { EditorView } from '@milkdown/prose/view'
import type { Node as PMNode } from '@milkdown/prose/model'

const RE = /==([^=\n][^=\n]*?[^=\n]|[^=\n])==/g

const key = new PluginKey('doc-reader-highlight')

/**
 * 按 textblock（段落 / 标题 / 列表项 等）扫描内容：
 *  - 把所有子文本节点的 text 拼成单串字符串（保留 doc 中的 ProseMirror position 映射）
 *  - 在拼接串上跑正则，可跨越 mark 边界（如 `==hello==` 中 `hello` 被 bold 切成 3 段也能匹配）
 *  - 把 match 的字符 index 映射回 doc position 后下发 Decoration
 *
 * 之前的实现按 text-node 单独扫描，遇到 `==<bold>x</bold>==` 这种被 mark 切开的串
 * 永远匹配不到 → 用户看到裸 `==`。
 */
function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return
    // 收集本块中所有 text node 的位置映射
    let combined = ''
    const offsets: { start: number; end: number; docPos: number }[] = []
    block.forEach((child, childOffset) => {
      if (!child.isText || !child.text) return
      const start = combined.length
      combined += child.text
      offsets.push({
        start,
        end: combined.length,
        // child 在 doc 中的起始位置：blockPos + 1（进入 textblock）+ childOffset
        docPos: blockPos + 1 + childOffset,
      })
    })
    if (!combined) return
    const mapToDocPos = (charIdx: number): number => {
      // 找到包含该字符的 child，取其 docPos + (charIdx - start)
      for (const seg of offsets) {
        if (charIdx >= seg.start && charIdx <= seg.end) {
          return seg.docPos + (charIdx - seg.start)
        }
      }
      // 兜底：返回最后一个 segment 末尾
      const last = offsets[offsets.length - 1]
      return last ? last.docPos + (last.end - last.start) : blockPos + 1
    }
    RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = RE.exec(combined)) !== null) {
      const startIdx = m.index
      const innerStartIdx = startIdx + 2
      const innerEndIdx = innerStartIdx + m[1].length
      const endIdx = innerEndIdx + 2
      const start = mapToDocPos(startIdx)
      const innerStart = mapToDocPos(innerStartIdx)
      const innerEnd = mapToDocPos(innerEndIdx)
      const end = mapToDocPos(endIdx)
      // 开头 == 标记
      decos.push(Decoration.inline(start, innerStart, { class: 'md-hl-marker' }))
      // 中间内容黄底
      decos.push(Decoration.inline(innerStart, innerEnd, { class: 'md-hl-text' }))
      // 结尾 == 标记
      decos.push(Decoration.inline(innerEnd, end, { class: 'md-hl-marker' }))
    }
  })
  return DecorationSet.create(doc, decos)
}

export const highlightDecorationPlugin = new Plugin<DecorationSet>({
  key,
  state: {
    init: (_config, instance) => buildDecorations(instance.doc),
    apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
  },
  props: {
    decorations(state) {
      return key.getState(state)
    },
  },
})

/**
 * 给当前选区前后包裹 `==`。若选区为空则插入 `====` 并把光标放中间。
 * 若选区已被 `==…==` 包裹，则去掉外层（toggle）。
 */
export function toggleHighlight(view: EditorView): boolean {
  const { state, dispatch } = view
  const { from, to, empty } = state.selection
  if (empty) {
    let tr = state.tr.insertText('====', from)
    const $pos = tr.doc.resolve(from + 2)
    tr = tr.setSelection(TextSelection.near($pos))
    dispatch(tr)
    view.focus()
    return true
  }
  const text = state.doc.textBetween(from, to, '\n', '\n')
  const before = state.doc.textBetween(Math.max(0, from - 2), from, '\n', '\n')
  const after = state.doc.textBetween(to, Math.min(state.doc.content.size, to + 2), '\n', '\n')
  if (before === '==' && after === '==') {
    const tr = state.tr
      .delete(to, to + 2)
      .delete(from - 2, from)
    dispatch(tr)
    view.focus()
    return true
  }
  const tr = state.tr.insertText('==' + text + '==', from, to)
  dispatch(tr)
  view.focus()
  return true
}
