/**
 * 键盘焦点路由：决定方向键 / PageUp/Down / Space 翻什么。
 *
 * 背景：
 *   ReaderShell 监听 window keydown 翻 PDF；AgentTab 监听 window keydown(capture)
 *   翻"学习屏"。两个 handler 共存时必须有一个仲裁机制告诉系统"键盘当前属于谁"，
 *   不能两个一起翻、也不能完全靠 tab 激活态（因为用户切到 agent tab 后还可能
 *   想用方向键翻 PDF —— 鼠标在 PDF 区上方就该翻 PDF）。
 *
 * 仲裁规则：
 *   - 默认值 = 'pdf'
 *   - 鼠标 mouseenter PDF 区 → 'pdf'
 *   - 鼠标 mouseenter Agent 区 → 'agent'
 *   - right-pane mode 切换时 reset：mode === 'agent' 默认 'agent'，否则 'pdf'
 *
 * 用 mutable ref + 订阅模式（不是 React state），因为这个值变化频繁、
 * 不需要触发 re-render —— 它只在键盘事件 callback 里被读。
 */

export type KeyboardOwner = 'pdf' | 'agent'

let current: KeyboardOwner = 'pdf'
const listeners = new Set<(o: KeyboardOwner) => void>()

export function setKeyboardOwner(o: KeyboardOwner): void {
  if (current === o) return
  current = o
  for (const l of listeners) l(o)
}

export function getKeyboardOwner(): KeyboardOwner {
  return current
}

/** 订阅 owner 变化（用于调试 / 状态指示器；普通 keydown handler 直接 get 即可） */
export function subscribeKeyboardOwner(cb: (o: KeyboardOwner) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
