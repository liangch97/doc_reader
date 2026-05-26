/**
 * Custom NodeView for fenced code blocks.
 *
 * ⚠️ 2026-05 起废弃：不再接管任何「特殊语言」(`flashcards` / `qa` /
 * `mindmap` / `concept`)。原本会输出带预览的 fence-card，但在 Milkdown
 * 编辑器内被包成「双层嵌套」、视觉上不可用，因此一律走默认 code_block。
 *
 * 为了不破坏现有的 `editorViewOptionsCtx.set({ nodeViews: { code_block: makeFenceNodeView } })`
 * 接线，本入口仍以原签名导出，但始终返回 null —— 让 ProseMirror 退回默认渲染。
 */
import type { NodeView, NodeViewConstructor } from '@milkdown/prose/view'

export const makeFenceNodeView: NodeViewConstructor = () => {
  return null as unknown as NodeView
}
