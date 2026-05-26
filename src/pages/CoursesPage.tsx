import { useEffect, useState } from 'react'
import { Plus, GraduationCap } from 'lucide-react'
import { coursesApi } from '@/lib/api'
import type { Course } from '@/types/course'
import { CourseCard } from '@/features/courses/CourseCard'
import { CreateCourseDialog } from '@/features/courses/CreateCourseDialog'
import { cn } from '@/lib/cn'

type Status = 'loading' | 'success' | 'error' | 'empty'

export default function CoursesPage() {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [courses, setCourses] = useState<Course[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [createOpen, setCreateOpen] = useState(false)

  const reload = async () => {
    try {
      setStatus('loading')
      const list = await coursesApi.list(false)
      setCourses(list)
      setStatus(list.length === 0 ? 'empty' : 'success')

      const entries = await Promise.all(
        list.map(async (c) => {
          try {
            const links = await coursesApi.listResources(c.course_id)
            return [c.course_id, links.length] as const
          } catch {
            return [c.course_id, 0] as const
          }
        })
      )
      setCounts(Object.fromEntries(entries))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  useEffect(() => {
    reload()
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border-1 px-6">
        <h1 className="text-lg font-semibold text-text-1">我的课程</h1>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
        >
          <Plus className="h-3.5 w-3.5" /> 新建课程
        </button>
      </header>

      <main className="flex-1 overflow-y-auto p-8">
        {status === 'loading' && <CenterMsg>加载中…</CenterMsg>}
        {status === 'error' && <CenterMsg variant="error">{error}</CenterMsg>}
        {status === 'empty' && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2">
              <GraduationCap className="h-8 w-8 text-text-3" />
            </div>
            <div>
              <p className="text-sm text-text-2">还没有课程</p>
              <p className="mt-1 text-xs text-text-3">新建课程，把相关资料分组到一起</p>
            </div>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              <Plus className="h-4 w-4" /> 新建课程
            </button>
          </div>
        )}
        {status === 'success' && (
          <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
            {courses.map((c) => (
              <CourseCard key={c.course_id} course={c} resourceCount={counts[c.course_id] ?? 0} />
            ))}
          </div>
        )}
      </main>

      <CreateCourseDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => reload()}
      />
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
