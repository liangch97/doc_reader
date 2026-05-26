import { useEffect, useMemo, useState } from 'react'
import {
  Search,
  X,
  Check,
  CheckSquare,
  Square,
  ArrowLeft,
  ArrowUpDown,
  Filter,
  NotebookPen,
  FileText,
} from 'lucide-react'
import { coursesApi, notebooksApi } from '@/lib/api'
import type { Notebook, NotebookEntry } from '@/types/notebook'
import type { Course } from '@/types/course'
import { cn } from '@/lib/cn'

interface Props {
  open: boolean
  course: Course
  onClose: () => void
  onImported?: () => void
}

type Sort = 'recent' | 'title' | 'type'

export function NotebookPickerDialog({ open, course, onClose, onImported }: Props) {
  const [step, setStep] = useState<'pick-notebook' | 'pick-entries'>('pick-notebook')
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [activeNotebook, setActiveNotebook] = useState<Notebook | null>(null)
  const [entries, setEntries] = useState<NotebookEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [sort, setSort] = useState<Sort>('recent')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setStep('pick-notebook')
    setActiveNotebook(null)
    setSelected(new Set())
    setQuery('')
    setTypeFilter('all')
    setError('')
    setPreviewId(null)
    ;(async () => {
      try {
        setLoading(true)
        const list = await notebooksApi.list()
        setNotebooks(list)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  const openNotebook = async (nb: Notebook) => {
    try {
      setLoading(true)
      setActiveNotebook(nb)
      const detail = await notebooksApi.get(nb.notebook_id)
      setEntries(detail.entries || [])
      setStep('pick-entries')
      setSelected(new Set())
      setQuery('')
      setPreviewId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const filteredEntries = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = entries.filter((e) => {
      if (typeFilter !== 'all' && (e.entry_type || 'note') !== typeFilter) return false
      if (!q) return true
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q)
    })
    list = [...list]
    if (sort === 'recent') {
      list.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    } else if (sort === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    } else if (sort === 'type') {
      list.sort((a, b) =>
        (a.entry_type || 'note').localeCompare(b.entry_type || 'note')
      )
    }
    return list
  }, [entries, query, typeFilter, sort])

  const allSelected =
    filteredEntries.length > 0 && filteredEntries.every((e) => selected.has(e.entry_id))

  const entryTypes = useMemo(() => {
    const set = new Set<string>()
    for (const e of entries) set.add(e.entry_type || 'note')
    return Array.from(set).sort()
  }, [entries])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        for (const e of filteredEntries) next.delete(e.entry_id)
      } else {
        for (const e of filteredEntries) next.add(e.entry_id)
      }
      return next
    })
  }

  const invertSelection = () => {
    setSelected((prev) => {
      const next = new Set<string>()
      for (const e of filteredEntries) {
        if (!prev.has(e.entry_id)) next.add(e.entry_id)
      }
      for (const id of prev) {
        if (!filteredEntries.find((e) => e.entry_id === id)) next.add(id)
      }
      return next
    })
  }

  const ensureCourseNotebook = async (): Promise<string> => {
    if (course.notebook_id) return course.notebook_id
    const created = await notebooksApi.create({
      name: `${course.name} 的笔记`,
      description: '课程关联笔记本',
      color: course.cover_color || '#7C5CFC',
    })
    await coursesApi.update(course.course_id, { notebook_id: created.notebook_id })
    return created.notebook_id
  }

  const importEntries = async (ids: string[]) => {
    if (ids.length === 0 || !activeNotebook) return
    try {
      setSubmitting(true)
      setError('')
      const targetNbId = await ensureCourseNotebook()
      for (const entryId of ids) {
        const src = entries.find((e) => e.entry_id === entryId)
        if (!src) continue
        await notebooksApi.addEntry({
          notebookId: targetNbId,
          title: src.title,
          content: src.content,
          entryType: src.entry_type || 'note',
          sourceInfo: `imported_from:${activeNotebook.notebook_id}:${src.entry_id}`,
        })
      }
      onImported?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const submit = () => importEntries([...selected])
  const quickImport = (e: NotebookEntry) => importEntries([e.entry_id])

  if (!open) return null

  const previewEntry = previewId ? entries.find((e) => e.entry_id === previewId) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-8">
      <div className="flex h-full max-h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border-1 bg-bg shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border-1 px-5 py-3">
          <div className="flex items-center gap-2">
            {step === 'pick-entries' && (
              <button
                type="button"
                onClick={() => {
                  setStep('pick-notebook')
                  setActiveNotebook(null)
                  setPreviewId(null)
                }}
                className="rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div className="text-sm font-semibold text-text-1">
              {step === 'pick-notebook'
                ? '选择笔记本'
                : `${activeNotebook?.name} · 选择要导入的条目`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Toolbar (entries only) */}
        {step === 'pick-entries' && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border-1 px-5 py-2.5">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索标题 / 正文"
                className="w-full rounded-md border border-border-1 bg-surface-1 py-1.5 pl-7 pr-2 text-xs text-text-1 outline-none focus:border-accent"
              />
            </div>

            <div className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs">
              <Filter className="h-3.5 w-3.5 text-text-3" />
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="bg-transparent text-text-1 outline-none"
              >
                <option value="all">全部类型</option>
                {entryTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs">
              <ArrowUpDown className="h-3.5 w-3.5 text-text-3" />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="bg-transparent text-text-1 outline-none"
              >
                <option value="recent">最近更新</option>
                <option value="title">标题 A-Z</option>
                <option value="type">按类型</option>
              </select>
            </div>

            <button
              type="button"
              onClick={toggleSelectAll}
              className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs text-text-1 hover:bg-surface-2"
            >
              {allSelected ? (
                <CheckSquare className="h-3.5 w-3.5" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {allSelected ? '取消全选' : '全选'}
            </button>
            <button
              type="button"
              onClick={invertSelection}
              className="rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs text-text-1 hover:bg-surface-2"
            >
              反选
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-full items-center justify-center text-xs text-text-3">
                加载中…
              </div>
            ) : step === 'pick-notebook' ? (
              notebooks.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-text-3">
                  还没有笔记本
                </div>
              ) : (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
                >
                  {notebooks.map((nb) => (
                    <button
                      key={nb.notebook_id}
                      type="button"
                      onClick={() => openNotebook(nb)}
                      className="group flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-border-2 hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-2.5">
                        <div
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white"
                          style={{ background: nb.color || '#7C5CFC' }}
                        >
                          <NotebookPen className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-text-1">
                            {nb.name}
                          </div>
                          {typeof nb.entry_count === 'number' && (
                            <div className="text-[11px] text-text-3">
                              {nb.entry_count} 条
                            </div>
                          )}
                        </div>
                      </div>
                      {nb.description && (
                        <div className="line-clamp-2 text-[11px] text-text-3">
                          {nb.description}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )
            ) : filteredEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-text-3">
                {entries.length === 0 ? '该笔记本暂无条目' : '没有匹配的条目'}
              </div>
            ) : (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}
              >
                {filteredEntries.map((e) => {
                  const checked = selected.has(e.entry_id)
                  return (
                    <div
                      key={e.entry_id}
                      onClick={() => toggle(e.entry_id)}
                      onDoubleClick={() => quickImport(e)}
                      onContextMenu={(ev) => {
                        ev.preventDefault()
                        setPreviewId(e.entry_id)
                      }}
                      className={cn(
                        'group relative flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-all',
                        checked
                          ? 'border-accent bg-accent/10 ring-1 ring-accent'
                          : 'border-border-1 bg-surface-1 hover:bg-surface-2'
                      )}
                      title="单击选中 · 双击快速导入 · 右键预览"
                    >
                      <div className="flex items-start gap-2">
                        <div
                          className={cn(
                            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                            checked
                              ? 'border-accent bg-accent text-white'
                              : 'border-border-1 bg-bg group-hover:border-text-3'
                          )}
                        >
                          {checked && <Check className="h-3 w-3" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-text-1">
                            {e.title || '(无标题)'}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-3">
                            <span className="rounded bg-surface-2 px-1 py-0.5">
                              {e.entry_type || 'note'}
                            </span>
                            <span>{(e.updated_at || '').slice(0, 10)}</span>
                          </div>
                        </div>
                      </div>
                      {e.content && (
                        <div className="line-clamp-3 text-[11px] leading-snug text-text-2">
                          {e.content.slice(0, 220)}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Preview Panel */}
          {previewEntry && step === 'pick-entries' && (
            <aside className="hidden w-80 shrink-0 flex-col border-l border-border-1 bg-surface-1 lg:flex">
              <div className="flex items-center justify-between border-b border-border-1 px-3 py-2">
                <div className="text-xs font-semibold text-text-1">预览</div>
                <button
                  type="button"
                  onClick={() => setPreviewId(null)}
                  className="rounded p-1 text-text-3 hover:bg-surface-2"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                <div>
                  <div className="text-sm font-semibold text-text-1">
                    {previewEntry.title || '(无标题)'}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-text-3">
                    <span className="rounded bg-surface-2 px-1.5 py-0.5">
                      {previewEntry.entry_type || 'note'}
                    </span>
                    <span>{(previewEntry.updated_at || '').slice(0, 16).replace('T', ' ')}</span>
                  </div>
                </div>
                {previewEntry.source_info && (
                  <div className="rounded-md border border-border-1 bg-bg p-2 text-[10px] text-text-3">
                    <div className="mb-0.5 flex items-center gap-1 text-text-2">
                      <FileText className="h-3 w-3" /> 来源
                    </div>
                    <div className="break-all">{previewEntry.source_info}</div>
                  </div>
                )}
                <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-text-1">
                  {previewEntry.content || '(无内容)'}
                </div>
              </div>
            </aside>
          )}
        </div>

        {/* Footer */}
        {error && (
          <div className="border-t border-error/30 bg-error/10 px-5 py-2 text-xs text-error">
            {error}
          </div>
        )}
        {step === 'pick-entries' && (
          <footer className="flex items-center justify-between gap-3 border-t border-border-1 px-5 py-3">
            <div className="flex items-center gap-3 text-xs text-text-3">
              <span>
                已选 <span className="font-medium text-text-1">{selected.size}</span> /{' '}
                {filteredEntries.length}
              </span>
              <span className="hidden text-text-4 md:inline">·</span>
              <span className="hidden text-text-4 md:inline">双击条目可快速导入 · 右键预览</span>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border-1 px-3 py-1.5 text-xs text-text-2 hover:bg-surface-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={selected.size === 0 || submitting}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2 disabled:opacity-50"
              >
                {submitting ? '导入中…' : `导入到课程笔记本 (${selected.size})`}
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}
