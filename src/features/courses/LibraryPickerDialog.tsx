import { useEffect, useMemo, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  Search,
  X,
  Check,
  CheckSquare,
  Square,
  Filter,
  ArrowUpDown,
  FileText,
  BookOpen,
  FileType2,
} from 'lucide-react'
import { coursesApi, resourcesApi } from '@/lib/api'
import type { Resource, ResourceKind } from '@/types/resource'
import type { Course, CourseResourceCategory } from '@/types/course'
import {
  useCoverStyles,
  paperHashIdx,
  COVER_TITLE_FONT,
} from '@/features/library/coverPalette'
import { cn } from '@/lib/cn'

interface Props {
  open: boolean
  courseId: string
  /** 已挂在该课程的 resource_id */
  excludeIds: Set<string>
  onClose: () => void
  onImported?: () => void
}

const CATEGORIES: Array<{ value: CourseResourceCategory; label: string }> = [
  { value: 'main', label: '主资料' },
  { value: 'ref', label: '参考资料' },
  { value: 'extra', label: '扩展阅读' },
]

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  pdf: FileType2,
  epub: BookOpen,
  mobi: BookOpen,
  azw3: BookOpen,
  txt: FileText,
  html: FileText,
  docx: FileText,
  pptx: FileText,
  cbz: BookOpen,
}

type Sort = 'recent' | 'title' | 'size'
type CourseFilter = 'all' | 'orphan' | string // 'all' | 'orphan' | specific course_id

export function LibraryPickerDialog({
  open,
  courseId,
  excludeIds,
  onClose,
  onImported,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<Resource[]>([])
  const [courses, setCourses] = useState<Course[]>([])
  /** resource_id → set of course_ids it belongs to */
  const [resourceCourses, setResourceCourses] = useState<Map<string, Set<string>>>(
    new Map()
  )
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<ResourceKind | 'all'>('all')
  const [courseFilter, setCourseFilter] = useState<CourseFilter>('all')
  const [sort, setSort] = useState<Sort>('recent')
  /** 选中态 + 每条独立分类 */
  const [selected, setSelected] = useState<Map<string, CourseResourceCategory>>(
    new Map()
  )
  const [defaultCategory, setDefaultCategory] = useState<CourseResourceCategory>('main')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)

  const styles = useCoverStyles()

  useEffect(() => {
    if (!open) return
    setSelected(new Map())
    setQuery('')
    setError('')
    setPreviewId(null)
    ;(async () => {
      try {
        setLoading(true)
        const [list, courseList] = await Promise.all([
          resourcesApi.list({ limit: 1000 }),
          coursesApi.list(false),
        ])
        setItems(list)
        setCourses(courseList)
        // 构建 resource → courseIds 映射
        const map = new Map<string, Set<string>>()
        await Promise.all(
          courseList.map(async (c) => {
            try {
              const links = await coursesApi.listResources(c.course_id)
              for (const l of links) {
                const set = map.get(l.resource.resource_id) ?? new Set()
                set.add(c.course_id)
                map.set(l.resource.resource_id, set)
              }
            } catch {
              /* ignore */
            }
          })
        )
        setResourceCourses(map)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = items.filter((r) => {
      if (excludeIds.has(r.resource_id)) return false
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false
      if (q) {
        const hay =
          r.title.toLowerCase() + r.author.toLowerCase() + r.filename.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (courseFilter === 'orphan') {
        const inCourses = resourceCourses.get(r.resource_id)
        if (inCourses && inCourses.size > 0) return false
      } else if (courseFilter !== 'all') {
        const inCourses = resourceCourses.get(r.resource_id)
        if (!inCourses || !inCourses.has(courseFilter)) return false
      }
      return true
    })
    // 排序
    list = [...list]
    if (sort === 'recent') {
      list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    } else if (sort === 'title') {
      list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
    } else if (sort === 'size') {
      list.sort((a, b) => (b.file_size || 0) - (a.file_size || 0))
    }
    return list
  }, [items, query, kindFilter, courseFilter, sort, excludeIds, resourceCourses])

  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.resource_id))

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, defaultCategory)
      return next
    })
  }

  const setItemCategory = (id: string, cat: CourseResourceCategory) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.set(id, cat)
      return next
    })
  }

  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Map(prev)
        for (const r of filtered) next.delete(r.resource_id)
        return next
      } else {
        const next = new Map(prev)
        for (const r of filtered) {
          if (!next.has(r.resource_id)) next.set(r.resource_id, defaultCategory)
        }
        return next
      }
    })
  }

  const invertSelection = () => {
    setSelected((prev) => {
      const next = new Map<string, CourseResourceCategory>()
      for (const r of filtered) {
        if (!prev.has(r.resource_id)) next.set(r.resource_id, defaultCategory)
      }
      // 保留过滤外的已选
      for (const [k, v] of prev) {
        if (!filtered.find((r) => r.resource_id === k)) next.set(k, v)
      }
      return next
    })
  }

  const submitAll = async (entries: Array<[string, CourseResourceCategory]>) => {
    if (entries.length === 0) return
    try {
      setSubmitting(true)
      setError('')
      for (const [resourceId, category] of entries) {
        await coursesApi.attachResource({ courseId, resourceId, category })
      }
      onImported?.()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const submit = () => submitAll([...selected.entries()])

  const quickImport = (r: Resource) => {
    submitAll([[r.resource_id, defaultCategory]])
  }

  if (!open) return null

  const allKinds: Array<ResourceKind | 'all'> = [
    'all',
    'pdf',
    'epub',
    'mobi',
    'azw3',
    'docx',
    'pptx',
    'txt',
    'html',
    'cbz',
  ]

  const previewItem = previewId ? items.find((r) => r.resource_id === previewId) : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-8">
      <div className="flex h-full max-h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border-1 bg-bg shadow-2xl">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border-1 px-5 py-3">
          <div className="text-sm font-semibold text-text-1">从图书馆选择资料</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border-1 px-5 py-2.5">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题 / 作者 / 文件名"
              className="w-full rounded-md border border-border-1 bg-surface-1 py-1.5 pl-7 pr-2 text-xs text-text-1 outline-none focus:border-accent"
            />
          </div>

          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as ResourceKind | 'all')}
            className="rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs text-text-1 outline-none focus:border-accent"
          >
            {allKinds.map((k) => (
              <option key={k} value={k}>
                {k === 'all' ? '全部类型' : k.toUpperCase()}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs">
            <Filter className="h-3.5 w-3.5 text-text-3" />
            <select
              value={courseFilter}
              onChange={(e) => setCourseFilter(e.target.value as CourseFilter)}
              className="bg-transparent text-text-1 outline-none"
            >
              <option value="all">全部课程</option>
              <option value="orphan">未挂任何课程</option>
              <optgroup label="仅显示属于">
                {courses
                  .filter((c) => c.course_id !== courseId)
                  .map((c) => (
                    <option key={c.course_id} value={c.course_id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          </div>

          <div className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1.5 text-xs">
            <ArrowUpDown className="h-3.5 w-3.5 text-text-3" />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="bg-transparent text-text-1 outline-none"
            >
              <option value="recent">最近添加</option>
              <option value="title">标题 A-Z</option>
              <option value="size">文件大小</option>
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

        {/* Body: Grid + Preview */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-full items-center justify-center text-xs text-text-3">
                加载中…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-text-3">
                {items.length === 0 ? '图书馆暂无资料' : '没有匹配的资料'}
              </div>
            ) : (
              <div
                className="grid gap-4"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
              >
                {filtered.map((r) => (
                  <ResourceTile
                    key={r.resource_id}
                    resource={r}
                    selected={selected.has(r.resource_id)}
                    category={selected.get(r.resource_id) ?? defaultCategory}
                    onToggle={() => toggle(r.resource_id)}
                    onDoubleClick={() => quickImport(r)}
                    onSetCategory={(c) => setItemCategory(r.resource_id, c)}
                    onPreview={() => setPreviewId(r.resource_id)}
                    paletteIdx={paperHashIdx(r.title || r.resource_id)}
                    style={styles[paperHashIdx(r.title || r.resource_id)]}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Preview Panel */}
          {previewItem && (
            <aside className="hidden w-72 shrink-0 flex-col border-l border-border-1 bg-surface-1 lg:flex">
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
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
                <PreviewCover
                  resource={previewItem}
                  style={styles[paperHashIdx(previewItem.title || previewItem.resource_id)]}
                />
                <div>
                  <div className="text-sm font-semibold text-text-1">{previewItem.title}</div>
                  {previewItem.author && (
                    <div className="text-xs text-text-3">{previewItem.author}</div>
                  )}
                </div>
                <dl className="space-y-1.5 text-[11px]">
                  <Field label="类型" value={previewItem.kind.toUpperCase()} />
                  <Field label="文件" value={previewItem.filename} />
                  <Field label="大小" value={formatSize(previewItem.file_size)} />
                  {previewItem.page_count > 0 && (
                    <Field label="页数" value={String(previewItem.page_count)} />
                  )}
                  <Field
                    label="所属课程"
                    value={
                      Array.from(resourceCourses.get(previewItem.resource_id) ?? [])
                        .map((cid) => courses.find((c) => c.course_id === cid)?.name)
                        .filter(Boolean)
                        .join('、') || '—'
                    }
                  />
                  <Field
                    label="添加于"
                    value={previewItem.created_at?.slice(0, 10) || '—'}
                  />
                </dl>
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
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border-1 px-5 py-3">
          <div className="flex items-center gap-3 text-xs text-text-3">
            <span>
              已选 <span className="font-medium text-text-1">{selected.size}</span> /{' '}
              {filtered.length}
            </span>
            <span className="text-text-4">·</span>
            <span>默认分类</span>
            <select
              value={defaultCategory}
              onChange={(e) => setDefaultCategory(e.target.value as CourseResourceCategory)}
              className="rounded-md border border-border-1 bg-surface-1 px-2 py-1 text-xs text-text-1 outline-none focus:border-accent"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <span className="hidden text-text-4 md:inline">·</span>
            <span className="hidden text-text-4 md:inline">双击卡片可快速导入</span>
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
              {submitting ? '导入中…' : `导入 (${selected.size})`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/* ────────── 卡片 ────────── */
function ResourceTile({
  resource,
  selected,
  category,
  onToggle,
  onDoubleClick,
  onSetCategory,
  onPreview,
  style,
}: {
  resource: Resource
  selected: boolean
  category: CourseResourceCategory
  onToggle: () => void
  onDoubleClick: () => void
  onSetCategory: (c: CourseResourceCategory) => void
  onPreview: () => void
  paletteIdx: number
  style: ReturnType<typeof useCoverStyles>[number]
}) {
  const Icon = KIND_ICON[resource.kind] ?? FileText
  const rawCover = resource.cover_path?.trim() || ''
  const hasCover = rawCover.length > 0
  const coverSrc = !hasCover
    ? ''
    : rawCover.startsWith('http') || rawCover.startsWith('data:')
      ? rawCover
      : convertFileSrc(rawCover)
  const firstChar = (resource.title || '?').trim().charAt(0).toUpperCase()
  return (
    <div
      onClick={onToggle}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onPreview()
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-1.5 rounded-md p-1.5 transition-colors',
        selected ? 'bg-accent/15 ring-1 ring-accent' : 'hover:bg-surface-1'
      )}
      title="单击选中 · 双击快速导入 · 右键预览"
    >
      {/* Cover */}
      <div
        className="relative h-44 w-full overflow-hidden rounded"
        style={
          hasCover
            ? { background: '#1a1a1f' }
            : { background: style.bg }
        }
      >
        {hasCover ? (
          <img
            src={coverSrc}
            alt={resource.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-3">
            <span
              className="line-clamp-4 text-center"
              style={{
                fontFamily: COVER_TITLE_FONT,
                fontWeight: 600,
                fontSize: '15px',
                color: style.ink,
                lineHeight: 1.2,
              }}
            >
              {resource.title || firstChar}
            </span>
          </div>
        )}

        {/* Selected overlay */}
        <div
          className={cn(
            'absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded border transition-all',
            selected
              ? 'border-accent bg-accent text-white'
              : 'border-white/80 bg-black/65 text-white opacity-0 group-hover:opacity-100'
          )}
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </div>

        {/* Kind badge */}
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[9px] font-medium uppercase text-white">
          <Icon className="h-2.5 w-2.5" />
          {resource.kind}
        </div>
      </div>

      {/* Title */}
      <div
        className="line-clamp-2 text-[11px] font-medium leading-snug text-text-1"
        title={resource.title}
      >
        {resource.title}
      </div>

      {/* Per-tile category (only when selected) */}
      {selected && (
        <select
          value={category}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onSetCategory(e.target.value as CourseResourceCategory)}
          className="w-full rounded border border-accent/50 bg-surface-1 px-1 py-0.5 text-[10px] text-text-1 outline-none"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

function PreviewCover({
  resource,
  style,
}: {
  resource: Resource
  style: ReturnType<typeof useCoverStyles>[number]
}) {
  const rawCover = resource.cover_path?.trim() || ''
  const hasCover = rawCover.length > 0
  const coverSrc = !hasCover
    ? ''
    : rawCover.startsWith('http') || rawCover.startsWith('data:')
      ? rawCover
      : convertFileSrc(rawCover)
  return (
    <div
      className="aspect-[3/4] w-full overflow-hidden rounded"
      style={hasCover ? { background: '#1a1a1f' } : { background: style.bg }}
    >
      {hasCover ? (
        <img src={coverSrc} alt={resource.title} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-4">
          <span
            className="line-clamp-6 text-center"
            style={{
              fontFamily: COVER_TITLE_FONT,
              fontWeight: 600,
              fontSize: '18px',
              color: style.ink,
              lineHeight: 1.25,
            }}
          >
            {resource.title}
          </span>
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-text-3">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-text-1">{value}</dd>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
