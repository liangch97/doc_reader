/**
 * Tauri invoke wrapper + 类型化命令
 * 后续 P1 会按 DESIGN.md §6 持续扩展。
 */
import { invoke as rawInvoke } from '@tauri-apps/api/core'

export const invoke = rawInvoke

/** 是否运行在 Tauri 容器内（区分纯浏览器调试） */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 安全 invoke：浏览器调试模式下不抛错，返回 fallback */
export async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>, fallback?: T): Promise<T | undefined> {
  if (!isTauri()) return fallback
  try {
    return (await rawInvoke<T>(cmd, args)) as T
  } catch (e) {
    console.warn('[invoke]', cmd, e)
    return fallback
  }
}

// ─── RAG 知识库相关类型 ────────────────────────────────────────────────────
//
// 后端命令：rag_index_session / rag_index_status / rag_clear_session / rag_chat
// 事件：    rag-build-progress / rag-build-done

/** 检索得到的来源段落（rag_chat 返回的 sources[]） */
export interface RagSource {
  chunk_id: string
  /** 0-based 页码起 */
  page_start: number
  /** 0-based 页码止（含） */
  page_end: number
  /** 段落前 ~160 字符摘要 */
  snippet: string
  /** cosine 相似度，0..1，越大越相关 */
  score: number
}

/** rag_chat 命令返回 */
export interface RagAnswer {
  answer: string
  sources: RagSource[]
  retrieved_count: number
  /** 'no_index' 表示后端因索引未就绪走了单页 chat fallback */
  fallback?: 'no_index'
  page_index?: number | null
}

/** rag_index_status 命令返回 */
export interface RagIndexStatus {
  session_id?: string
  status: 'none' | 'pending' | 'building' | 'ready' | 'failed'
  chunk_count: number
  model: string
  dim: number
  error: string
  updated_at: string
}

/** rag-build-progress 事件 payload */
export interface RagBuildProgressEvent {
  session_id: string
  completed: number
  total: number
}

/** rag-build-done 事件 payload */
export interface RagBuildDoneEvent {
  session_id: string
  success: boolean
  total_chunks?: number
  dim?: number
  error?: string
  /** true 表示是 doc_reader_open 自动触发的，前端可静默 toast */
  auto?: boolean
}

// ─── 知识点（Knowledge Points）相关类型 ──────────────────────────────────
//
// 后端命令：kp_detect / kp_refine_titles / kp_list /
//          notebook_generate_from_kp / notebook_generate_from_kps_all
// 事件：   kp-detect-done / kp-titles-progress / kp-titles-done /
//          kp-notes-progress / kp-notes-done

/** 单条知识点（与 db::KpRow 对齐） */
export interface KnowledgePoint {
  kp_id: string
  session_id: string
  /** 文档内序号，从 0 起 */
  kp_index: number
  /** LLM 标题；status='detected' 时是占位串"知识点 N (Pa-Pb)" */
  title: string
  /** LLM 一句话摘要；可能为空 */
  summary: string
  /** 0-based 页码起 */
  page_start: number
  /** 0-based 页码止（含） */
  page_end: number
  /** JSON 字符串，元素为 chunk_index（非 chunk_id）。前端通常无需解析 */
  chunk_ids: string
  char_count: number
  /** 'detected' = 仅切好；'titled' = 已生成标题；'note_generated' = 已写入笔记本 */
  status: 'detected' | 'titled' | 'note_generated'
  /** 已生成笔记后回填的 entry_id；空字符串 = 未生成 */
  notebook_entry_id: string
  updated_at: string
}

/** kp-detect-done 事件 payload */
export interface KpDetectDoneEvent {
  session_id: string
  total: number
}

/** kp-titles-progress 事件 payload */
export interface KpTitlesProgressEvent {
  session_id: string
  completed: number
  total: number
}

/** kp-titles-done 事件 payload */
export interface KpTitlesDoneEvent {
  session_id: string
  success: boolean
  total?: number
  error?: string
}

/** kp-notes-progress 事件 payload */
export interface KpNotesProgressEvent {
  session_id: string
  notebook_id: string
  completed: number
  total: number
  kp_id?: string
  /** 单条 KP 失败时挂 error，不会中断整批 */
  error?: string
}

/** kp-notes-done 事件 payload */
export interface KpNotesDoneEvent {
  session_id: string
  notebook_id: string
  completed: number
  total: number
}

/**
 * kp-clipboard-progress 事件 payload
 * 后端编排命令 `kp_generate_to_clipboard` 的多阶段进度。
 */
export interface KpClipboardProgressEvent {
  session_id: string
  /** 当前阶段：preparing / detecting / titling / generating */
  stage: 'preparing' | 'detecting' | 'titling' | 'generating'
  completed: number
  total: number
  message: string
}

/**
 * kp-clipboard-done 事件 payload
 * - success=true：携带完整 markdown，前端写剪贴板
 * - success=false：携带 error，前端 toast 显示
 */
export interface KpClipboardDoneEvent {
  session_id: string
  success: boolean
  total?: number
  completed?: number
  /** 全部知识点拼接而成的 markdown；前端写入系统剪贴板 */
  markdown?: string
  error?: string
}
