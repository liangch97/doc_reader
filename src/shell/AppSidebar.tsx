import { NavLink } from 'react-router-dom'
import {
  Home,
  Library,
  GraduationCap,
  NotebookPen,
  Settings,
  Dumbbell,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ComponentType } from 'react'

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

// v4 (2026-05) P5.1：训练 / 技能树作为顶层入口
const TOP_ITEMS: NavItem[] = [
  { to: '/', label: '主页', icon: Home },
  { to: '/library', label: '图书馆', icon: Library },
  { to: '/courses', label: '课程', icon: GraduationCap },
  { to: '/notebook', label: '笔记本', icon: NotebookPen },
  { to: '/training', label: '训练', icon: Dumbbell },
  { to: '/skills', label: '技能树', icon: Sparkles },
]

const BOTTOM_ITEMS: NavItem[] = [{ to: '/settings', label: '设置', icon: Settings }]

export function AppSidebar() {
  return (
    <aside className="flex w-16 shrink-0 flex-col items-center justify-between border-r border-border-1 bg-surface-1 py-3">
      <nav className="flex flex-col items-center gap-1">
        {TOP_ITEMS.map((item) => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </nav>
      <nav className="flex flex-col items-center gap-1">
        {BOTTOM_ITEMS.map((item) => (
          <SidebarLink key={item.to} {...item} />
        ))}
      </nav>
    </aside>
  )
}

function SidebarLink({ to, label, icon: Icon }: NavItem) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={label}
      className={({ isActive }) =>
        cn(
          'group relative flex h-11 w-11 items-center justify-center rounded-md text-text-2 transition-all',
          'hover:bg-surface-2 hover:text-text-1',
          isActive && 'bg-surface-3 text-text-1 shadow-glow'
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute left-0 h-6 w-0.5 -translate-x-1.5 rounded-r-full bg-accent"
            />
          )}
          <Icon className="h-5 w-5" />
        </>
      )}
    </NavLink>
  )
}

/** 移动端底部 Tab 栏 */
export function MobileTabBar() {
  const items = [...TOP_ITEMS, ...BOTTOM_ITEMS]
  return (
    <nav className="flex h-14 shrink-0 items-stretch border-t border-border-1 bg-bg backdrop-blur">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors',
              isActive ? 'text-accent' : 'text-text-3 hover:text-text-1'
            )
          }
        >
          <Icon className="h-5 w-5" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
