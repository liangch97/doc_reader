export interface Notebook {
  notebook_id: string
  name: string
  description: string
  color: string
  teacher: string
  created_at: string
  updated_at: string
  entry_count?: number
}

export interface NotebookEntry {
  entry_id: string
  notebook_id: string
  title: string
  content: string
  entry_type: string
  source_info: string
  created_at: string
  updated_at: string
}

export interface NotebookDetail {
  notebook: Notebook
  entries: NotebookEntry[]
}
