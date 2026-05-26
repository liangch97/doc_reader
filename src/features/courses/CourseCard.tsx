import { Link } from 'react-router-dom'
import type { Course } from '@/types/course'
import { cn } from '@/lib/cn'
import {
  useCoverStyles,
  paperHashIdx,
  COVER_TITLE_FONT,
} from '@/features/library/coverPalette'
import { resolveCoverIcon } from './coverIcon'

interface Props {
  course: Course
  resourceCount?: number
  progress?: number
}

export function CourseCard({ course, resourceCount, progress }: Props) {
  const Icon = resolveCoverIcon(course.cover_emoji)
  const pct = typeof progress === 'number' ? Math.round(progress * 100) : null
  const styles = useCoverStyles()
  const style = styles[paperHashIdx(course.name || course.course_id)]

  return (
    <Link
      to={`/courses/${course.course_id}`}
      className={cn(
        'group relative flex h-44 flex-col justify-between overflow-hidden rounded-lg p-5',
        'transition-transform hover:-translate-y-0.5'
      )}
      style={{
        background: style.bg,
        color: style.ink,
        boxShadow:
          '0 3px 10px -2px rgba(60,50,30,0.22), inset 0 0 0 1px rgba(255,255,255,0.4)',
      }}
    >
      {/* GoodNotes 内描边 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-2 rounded-[5px]"
        style={{ border: `1px solid ${style.frame}`, opacity: 0.65 }}
      />

      <div className="relative">
        <Icon className="h-7 w-7" strokeWidth={1.5} style={{ color: style.accent }} />
      </div>

      <div className="relative space-y-1">
        <div
          className="line-clamp-2 text-[18px] leading-[1.35]"
          title={course.name}
          style={{
            fontFamily: COVER_TITLE_FONT,
            fontWeight: 500,
            letterSpacing: '0.04em',
          }}
        >
          {course.name}
        </div>
        <div className="text-[11px]" style={{ color: style.ink, opacity: 0.65 }}>
          {resourceCount ?? 0} 份资料{pct !== null ? ` · ${pct}%` : ''}
        </div>
      </div>

      {course.archived && (
        <span
          className="absolute right-3 top-3 rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: 'rgba(0,0,0,0.08)', color: style.ink, opacity: 0.7 }}
        >
          归档
        </span>
      )}

      {pct !== null && (
        <div className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: 'rgba(0,0,0,0.08)' }}>
          <div className="h-full" style={{ width: `${pct}%`, background: style.accent }} />
        </div>
      )}
    </Link>
  )
}
