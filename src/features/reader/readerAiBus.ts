/**
 * 选区 → AI 解释入口的轻量事件总线。
 *
 * 之所以走 window CustomEvent 而不是 React Context：
 * - 选区 popover、RightPane、ChatTab 三个组件分散在 ReaderShell 的不同子树里
 * - ChatTab 内部维护 input 状态，且只在 chat tab 激活时挂载；要 prefill 必须能在挂载后 *再次*消费
 *   事件 → 用一个 module-level 的「待消费 payload」缓冲，监听器 mount 时也能拿到刚送达的 payload
 *
 * 流向：
 *   ReaderSelectionPopover / PdfSelectionPopover (用户点 AI)
 *     → emitAiExplain(text)
 *       → RightPane 监听：切到 'chat' tab
 *       → ChatTab 监听：把 text 写入 input；focus
 */

export interface AiExplainPayload {
  /** 用户选中的原文（已 trim） */
  text: string
  /** 触发来源；目前 EPUB / PDF 两种，仅做日志，不影响处理 */
  source: 'epub' | 'pdf'
  /** 单调递增的序号，便于消费者识别"是否处理过该次事件" */
  seq: number
}

const EVENT_NAME = 'reader:ai-explain'

let lastPayload: AiExplainPayload | null = null
let seqCounter = 0

export function emitAiExplain(text: string, source: 'epub' | 'pdf' = 'epub'): void {
  const trimmed = text.trim()
  if (!trimmed) return
  seqCounter += 1
  const payload: AiExplainPayload = { text: trimmed, source, seq: seqCounter }
  lastPayload = payload
  try {
    window.dispatchEvent(new CustomEvent<AiExplainPayload>(EVENT_NAME, { detail: payload }))
  } catch (e) {
    console.warn('[readerAiBus] dispatch failed', e)
  }
}

/**
 * 注册监听。返回 unsubscribe。
 *
 * `consumePending` = true 时，在订阅那一刻若存在尚未处理的 payload（seq > lastSeenSeq），
 * 立刻同步触发 handler 一次。
 */
export function onAiExplain(
  handler: (payload: AiExplainPayload) => void,
  opts?: { consumePending?: boolean; lastSeenSeq?: number }
): () => void {
  const listener = (e: Event) => {
    const ce = e as CustomEvent<AiExplainPayload>
    if (ce.detail) handler(ce.detail)
  }
  window.addEventListener(EVENT_NAME, listener as EventListener)
  if (opts?.consumePending && lastPayload && lastPayload.seq > (opts.lastSeenSeq ?? 0)) {
    // 微任务里触发，避免在订阅者还在初始化 state 时同步回调
    queueMicrotask(() => handler(lastPayload!))
  }
  return () => window.removeEventListener(EVENT_NAME, listener as EventListener)
}

/** 拿当前最后一次 payload（用于初始化时回放） */
export function peekLastAiExplain(): AiExplainPayload | null {
  return lastPayload
}
