/** 资料类型（与 SQLite resources.kind 对齐） */
export type ResourceKind =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'epub'
  | 'mobi'
  | 'azw3'
  | 'cbz'
  | 'txt'
  | 'html'
  | 'unknown'

export interface Resource {
  resource_id: string
  kind: ResourceKind
  title: string
  author: string
  filename: string
  file_path: string
  file_size: number
  cover_path: string
  page_count: number
  has_text: boolean
  doc_session_id: string
  created_at: string
  updated_at: string
}
