import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Plus,
  ArrowLeft,
  Upload,
  Library,
  NotebookPen,
  MoreVertical,
  BookOpen,
  Tag,
  Trash2,
  ExternalLink,
  Check,
  X,
} from 'lucide-react'
import { coursesApi } from '@/lib/api'
import type { Course, CourseResourceLink, CourseResourceCategory } from '@/types/course'
import { ImportDialog } from '@/features/library/ImportDialog'
import { LibraryPickerDialog } from '@/features/courses/LibraryPickerDialog'
import { NotebookPickerDialog } from '@/features/courses/NotebookPickerDialog'
import { ResourceCard } from '@/features/library/ResourceCard'
import { resolveCoverIcon } from '@/features/courses/coverIcon'
import { cn } from '@/lib/cn'

type Status = 'loading' | 'success' | 'error' | 'empty'
type CategoryFilter = 'all' | CourseResourceCategory

const CATEGORY_LABELS: Record<CourseResourceCategory, string> = {
  main: '主资料',
  ref: '参考资料',
  extra: '扩展阅读',
}
const CATEGORY_SHORT: Record<CourseResourceCategory, string> = {
  main: '主',
  ref: '参',
  extra: '拓',
}

export default function CourseWorkspacePage() {
  const { courseId } = useParams()
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [course, setCourse] = useState<Course | null>(null)
  const [links, setLinks] = useState<CourseResourceLink[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [notebookOpen, setNotebookOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const reload = useCallback(async () => {
    if (!courseId) return
    try {
      setStatus('loading')
      const c = await coursesApi.get(courseId)
      if (!c) {
        setStatus('error')
        setError('课程不存在')
        return
      }
      setCourse(c)
      const ls = await coursesApi.listResources(courseId)
      setLinks(ls)
      setStatus('success')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [courseId])

  useEffect(() => {
    reload()
  }, [reload])

  const removeFromCourse = async (resourceId: string) => {
    if (!courseId) return
    if (!confirm('从本课程移除该资料？（不会删除资料本身）')) return
    await coursesApi.detachResource(courseId, resourceId)
    reload()
  }

  const changeCategory = async (resourceId: string, category: CourseResourceCategory) => {
    if (!courseId) return
    setLinks((prev) =>
      prev.map((l) =>
        l.resource.resource_id === resourceId ? { ...l, category } : l
      )
    )
    try {
      await coursesApi.setResourceCategory({ courseId, resourceId, category })
    } catch (err) {
      console.error(err)
      reload()
    }
  }

  const toggleSelect = (resourceId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }

  const visibleLinks = links.filter((l) => filter === 'all' || l.category === filter)
  const allVisibleSelected =
    visibleLinks.length > 0 && visibleLinks.every((l) => selected.has(l.resource.resource_id))

  const selectAllVisible = () => {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev)
        visibleLinks.forEach((l) => next.delete(l.resource.resource_id))
        return next
      })
    } else {
      setSelected((prev) => {
        const next = new Set(prev)
        visibleLinks.forEach((l) => next.add(l.resource.resource_id))
        return next
      })
    }
  }

  const clearSelection = () => setSelected(new Set())

  const bulkChangeCategory = async (category: CourseResourceCategory) => {
    if (!courseId || selected.size === 0) return
    const ids = Array.from(selected)
    setLinks((prev) =>
      prev.map((l) => (selected.has(l.resource.resource_id) ? { ...l, category } : l))
    )
    try {
      await Promise.all(
        ids.map((rid) =>
          coursesApi.setResourceCategory({ courseId, resourceId: rid, category })
        )
      )
    } catch (err) {
      console.error(err)
      reload()
    }
    clearSelection()
  }

  const bulkRemove = async () => {
    if (!courseId || selected.size === 0) return
    if (!confirm(`从本课程移除已选的 ${selected.size} 个资料？（不会删除资料本身）`))
      return
    const ids = Array.from(selected)
    try {
      await Promise.all(ids.map((rid) => coursesApi.detachResource(courseId, rid)))
    } catch (err) {
      console.error(err)
    }
    clearSelection()
    reload()
  }

  if (status === 'loading') {
    return <CenterMsg>加载中…</CenterMsg>
  }
  if (status === 'error' || !course) {
    return <CenterMsg variant="error">{error || '加载失败'}</CenterMsg>
  }

  return (
    <div className="flex h-full flex-col">
      <header
        className="flex h-20 shrink-0 items-center gap-4 border-b border-border-1 px-6"
        style={{
          background: `linear-gradient(95deg, ${course.cover_color || '#7C5CFC'}22 0%, transparent 60%)`,
        }}
      >
        <Link
          to="/courses"
          className="rounded-md p-2 text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <CourseHeaderIcon value={course.cover_emoji} color={course.cover_color || '#7C5CFC'} />
        <div className="min-w-0 flex-1">
          <div className="text-xl font-semibold text-text-1">{course.name}</div>
          {course.description && (
            <div className="line-clamp-1 text-xs text-text-3">{course.description}</div>
          )}
        </div>
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
          >
            <Plus className="h-3.5 w-3.5" /> 添加资料
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-md border border-popover-border bg-popover shadow-2xl">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setImportOpen(true)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-1 hover:bg-surface-2"
              >
                <Upload className="h-3.5 w-3.5 text-text-3" />
                <div>
                  <div>上传新文件</div>
                  <div className="text-[10px] text-text-3">从本地导入 PDF/EPUB 等</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setLibraryOpen(true)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-1 hover:bg-surface-2"
              >
                <Library className="h-3.5 w-3.5 text-text-3" />
                <div>
                  <div>从图书馆选择</div>
                  <div className="text-[10px] text-text-3">从已有资料中多选</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  setNotebookOpen(true)
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-1 hover:bg-surface-2"
              >
                <NotebookPen className="h-3.5 w-3.5 text-text-3" />
                <div>
                  <div>从笔记本导入条目</div>
                  <div className="text-[10px] text-text-3">复制条目到课程笔记本</div>
                </div>
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col overflow-y-auto p-4 md:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {(['all', 'main', 'ref', 'extra'] as CategoryFilter[]).map((f) => {
            const count =
              f === 'all' ? links.length : links.filter((l) => l.category === f).length
            const active = filter === f
            const label = f === 'all' ? '全部' : CATEGORY_LABELS[f]
            return (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  active
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-border-1 bg-surface-1 text-text-2 hover:bg-surface-2'
                )}
              >
                {label}
                <span className="ml-1 text-[10px] text-text-3">{count}</span>
              </button>
            )
          })}
        </div>
        {links.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-border-1 text-xs text-text-3">
            还没有资料，点击右上角「添加资料」开始
          </div>
        ) : (
          <div
            className="grid gap-3 pb-20"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
          >
            {visibleLinks.map((l) => (
              <DraggableResource
                key={l.resource.resource_id}
                link={l}
                selected={selected.has(l.resource.resource_id)}
                selectionActive={selected.size > 0}
                onToggleSelect={toggleSelect}
                onRemove={removeFromCourse}
                onChangeCategory={changeCategory}
              />
            ))}
          </div>
        )}
      </main>

      {selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-popover-border bg-popover px-2 py-1.5 shadow-2xl">
            <span className="px-2 text-xs text-text-2">已选 {selected.size}</span>
            <button
              type="button"
              onClick={selectAllVisible}
              className="rounded-full px-2.5 py-1 text-xs text-text-2 hover:bg-surface-2"
            >
              {allVisibleSelected ? '取消全选' : '全选当前'}
            </button>
            <div className="mx-1 h-4 w-px bg-border-1" />
            <span className="flex items-center gap-1 px-1.5 text-[10px] uppercase tracking-wide text-text-3">
              <Tag className="h-3 w-3" /> 迁移到
            </span>
            {(['main', 'ref', 'extra'] as CourseResourceCategory[]).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => bulkChangeCategory(cat)}
                className="rounded-full px-2.5 py-1 text-xs text-text-1 hover:bg-accent/15 hover:text-accent"
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
            <div className="mx-1 h-4 w-px bg-border-1" />
            <button
              type="button"
              onClick={bulkRemove}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-error hover:bg-error/10"
            >
              <Trash2 className="h-3 w-3" /> 移除
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="ml-1 rounded-full p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
              aria-label="取消选择"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => reload()}
        defaultCourseId={courseId}
      />

      <LibraryPickerDialog
        open={libraryOpen}
        courseId={courseId || ''}
        excludeIds={new Set(links.map((l) => l.resource.resource_id))}
        onClose={() => setLibraryOpen(false)}
        onImported={() => reload()}
      />

      {course && (
        <NotebookPickerDialog
          open={notebookOpen}
          course={course}
          onClose={() => setNotebookOpen(false)}
          onImported={() => reload()}
        />
      )}
    </div>
  )
}

function DraggableResource({
  link,
  selected,
  selectionActive,
  onToggleSelect,
  onRemove,
  onChangeCategory,
}: {
  link: CourseResourceLink
  selected: boolean
  selectionActive: boolean
  onToggleSelect: (resourceId: string) => void
  onRemove: (resourceId: string) => void
  onChangeCategory: (resourceId: string, category: CourseResourceCategory) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])
  const r = link.resource
  return (
    <div className={cn('group relative', selected && 'ring-2 ring-accent rounded-lg')}>
      {/* 选择复选框 */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onToggleSelect(r.resource_id)
        }}
        className={cn(
          'absolute left-1 top-1 z-20 flex h-5 w-5 items-center justify-center rounded border transition-opacity',
          selected
            ? 'border-accent bg-accent text-white opacity-100'
            : 'border-border-1 bg-popover text-transparent shadow-sm',
          selectionActive || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
        aria-label={selected ? '取消选择' : '选择资料'}
      >
        {selected && <Check className="h-3 w-3" />}
      </button>
      {/* 动作菜单触发 */}
      <div ref={menuRef} className="absolute right-1 top-1 z-20">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
          className={cn(
            'rounded-md bg-popover p-1 text-text-3 shadow-sm transition-opacity hover:bg-surface-2 hover:text-text-1',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          aria-label="资料选项"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-md border border-popover-border bg-popover shadow-2xl">
            <Link
              to={`/reader/${r.resource_id}`}
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-1 hover:bg-surface-2"
            >
              <BookOpen className="h-3.5 w-3.5 text-text-3" /> 打开阅读
            </Link>
            <Link
              to="/library"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-1 hover:bg-surface-2"
            >
              <ExternalLink className="h-3.5 w-3.5 text-text-3" /> 在图书馆查看
            </Link>
            <div className="my-1 border-t border-border-1" />
            <div className="flex items-center gap-2 px-3 py-1 text-[10px] uppercase tracking-wide text-text-3">
              <Tag className="h-3 w-3" /> 迁移到
            </div>
            {(['main', 'ref', 'extra'] as CourseResourceCategory[]).map((cat) => {
              const labelMap = { main: '主资料', ref: '参考资料', extra: '扩展阅读' }
              const isCurrent = link.category === cat
              return (
                <button
                  key={cat}
                  type="button"
                  disabled={isCurrent}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setMenuOpen(false)
                    if (!isCurrent) onChangeCategory(r.resource_id, cat)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
                    isCurrent
                      ? 'cursor-default text-text-3'
                      : 'text-text-1 hover:bg-surface-2'
                  )}
                >
                  <span className="w-3.5" />
                  {labelMap[cat]}
                  {isCurrent && (
                    <span className="ml-auto text-[10px] text-text-3">当前</span>
                  )}
                </button>
              )
            })}
            <div className="my-1 border-t border-border-1" />
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMenuOpen(false)
                onRemove(r.resource_id)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-error hover:bg-error/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> 从课程移除
            </button>
          </div>
        )}
      </div>
      <ResourceCard resource={r} />
      {/* 分类徽章 */}
      <div className="pointer-events-none absolute bottom-1 left-1 rounded bg-popover px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-2 shadow-sm">
        {CATEGORY_SHORT[link.category]}
      </div>
    </div>
  )
}

function CenterMsg({
  children,
  variant,
}: {
  children: React.ReactNode
  variant?: 'error'
}) {
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center text-sm',
        variant === 'error' ? 'text-error' : 'text-text-3'
      )}
    >
      {children}
    </div>
  )
}

function CourseHeaderIcon({ value, color }: { value: string | null; color: string }) {
  const Icon = resolveCoverIcon(value)
  return (
    <div
      className="flex h-11 w-11 items-center justify-center rounded-lg"
      style={{ background: `${color}22`, color }}
    >
      <Icon className="h-5 w-5" strokeWidth={1.6} />
    </div>
  )
}
