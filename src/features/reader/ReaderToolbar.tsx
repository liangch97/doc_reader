import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Library,
  Bookmark as BookmarkIcon,
  Search as SearchIcon,
  PanelLeftClose,
  Pencil,
  MoreVertical,
  X,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import type { Resource } from '@/types/resource'
import type { MdTheme } from '@/components/markdown/MarkdownView'
import { ReaderSettingsPopover } from './ReaderSettingsPopover'
import { ReaderSettingsSheet } from './tablet/ReaderSettingsSheet'
import type { ReaderPrefs } from './useReaderPrefs'
import { useLayoutMode } from '@/lib/useLayoutMode'

interface Props {
  resource: Resource
  pageHint?: string
  showLeft: boolean
  showRight: boolean
  prefs?: ReaderPrefs
  onPrefsChange?: (patch: Partial<ReaderPrefs>) => void
  /** 阅读区 Markdown 主题（仅作用于 EPUB / PDF 主区，与右侧笔记主题独立） */
  readerMdTheme?: MdTheme
  onReaderMdThemeChange?: (t: MdTheme) => void
  onToggleLeft: () => void
  onToggleRight: () => void
  /** 沉浸模式收起工具栏（保持 immersive=true，仅折叠 header） */
  onCollapseToolbar?: () => void
  onPrev?: () => void
  onNext?: () => void
  onAddBookmark?: () => void
  /** 全书搜索：仅 EPUB 等 foliate 渲染的资料有效 */
  searchActive?: boolean
  onToggleSearch?: () => void
  // v4 (2026-05): onAiNote / Sparkles AI 笔记入口已移除
  //   - 讲解、问答、训练跨粒度都以 entry 为载体（双向同步），
  //     不再需要独立“AI 生成笔记”按钮。
}

/**
 * 阅读器顶部工具栏 v3 —— 按用户截图重设计：
 *   左群：[TOC 切换 | 返回图书馆 | 书签 | 搜索]
 *   中区：资料标题 · 页提示
 *   右群：[Aa 阅读设置 | 编辑/笔记栏 | ⋯更多 | X 关闭]
 *
 * 设计要点：
 *  - 沉浸式：图标紧凑、仅图标无文字，整条 header 用主题色 (--bg)
 *  - 「返回图书馆」与「关闭」是两个独立动作；目前都跳 /library，未来可分化
 *  - 「更多」装：收起工具栏（沉浸态）+ 上一页/下一页（触控备援）
 *  - v4 (2026-05): “AI 笔记”按钮已移除，讲解同步由学习 Agent 负责
 */
export function ReaderToolbar({
  resource,
  pageHint,
  showLeft,
  showRight,
  prefs,
  onPrefsChange,
  readerMdTheme,
  onReaderMdThemeChange,
  onToggleLeft,
  onToggleRight,
  onCollapseToolbar,
  onPrev,
  onNext,
  onAddBookmark,
  searchActive,
  onToggleSearch,
}: Props) {
  const layoutMode = useLayoutMode()
  const isTouch = layoutMode !== 'desktop'
  const btnSize = isTouch ? 'h-10 w-10' : 'h-8 w-8'
  const iconSize = isTouch ? 'h-[18px] w-[18px]' : 'h-4 w-4'
  const navigate = useNavigate()

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border-1 bg-bg px-2 text-text-1">
      {/* === 左群 === */}
      <ToolButton
        sizeClass={btnSize}
        onClick={onToggleLeft}
        active={showLeft}
        title="目录 / TOC"
      >
        <PanelLeftClose className={iconSize} />
      </ToolButton>
      <ToolButton
        sizeClass={btnSize}
        onClick={() => navigate('/library')}
        title="返回图书馆"
      >
        <Library className={iconSize} />
      </ToolButton>
      <ToolButton
        sizeClass={btnSize}
        onClick={onAddBookmark}
        title="添加书签"
      >
        <BookmarkIcon className={iconSize} />
      </ToolButton>
      {onToggleSearch && (
        <ToolButton
          sizeClass={btnSize}
          onClick={onToggleSearch}
          active={searchActive}
          title="全书搜索 (Ctrl+F)"
        >
          <SearchIcon className={iconSize} />
        </ToolButton>
      )}

      {/* === 中区：书名 === */}
      <div className="mx-3 flex min-w-0 flex-1 items-center justify-center gap-2">
        <span className="truncate text-sm font-medium text-text-1">
          {resource.title}
        </span>
        {pageHint && (
          <span className="shrink-0 text-xs text-text-3">{pageHint}</span>
        )}
      </div>

      {/* === 右群 === */}
      {prefs && onPrefsChange && (
        isTouch ? (
          <ReaderSettingsSheet
            prefs={prefs}
            onChange={onPrefsChange}
            readerMdTheme={readerMdTheme}
            onReaderMdThemeChange={onReaderMdThemeChange}
            resourceKind={resource.kind}
          />
        ) : (
          <ReaderSettingsPopover
            prefs={prefs}
            onChange={onPrefsChange}
            readerMdTheme={readerMdTheme}
            onReaderMdThemeChange={onReaderMdThemeChange}
            resourceKind={resource.kind}
          />
        )
      )}

      <ToolButton
        sizeClass={btnSize}
        onClick={onToggleRight}
        active={showRight}
        title="笔记 / 标注面板"
      >
        <Pencil className={iconSize} />
      </ToolButton>

      <MoreMenu
        sizeClass={btnSize}
        iconSize={iconSize}
        showPager={isTouch}
        onPrev={onPrev}
        onNext={onNext}
        onCollapseToolbar={onCollapseToolbar}
      />

      <ToolButton
        sizeClass={btnSize}
        onClick={() => navigate('/library')}
        title="关闭"
      >
        <X className={iconSize} />
      </ToolButton>
    </header>
  )
}

function ToolButton({
  children,
  onClick,
  active,
  title,
  sizeClass = 'h-8 w-8',
}: {
  children: React.ReactNode
  onClick?: () => void
  active?: boolean
  title?: string
  sizeClass?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center rounded-md text-text-2 transition-colors',
        sizeClass,
        'hover:bg-surface-2 hover:text-text-1',
        active && 'bg-surface-3 text-text-1'
      )}
    >
      {children}
    </button>
  )
}

/**
 * "更多" 菜单：纯色小弹出，不带 backdrop，不挡视线。
 * 触控态装上下页备援；沉浸态装收起工具栏。
 */
function MoreMenu({
  sizeClass,
  iconSize,
  showPager,
  onPrev,
  onNext,
  onCollapseToolbar,
}: {
  sizeClass: string
  iconSize: string
  showPager: boolean
  onPrev?: () => void
  onNext?: () => void
  onCollapseToolbar?: () => void
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const hasContent = showPager || !!onCollapseToolbar
  if (!hasContent) return null

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        title="更多"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center justify-center rounded-md text-text-2 transition-colors',
          sizeClass,
          'hover:bg-surface-2 hover:text-text-1',
          open && 'bg-surface-3 text-text-1'
        )}
      >
        <MoreVertical className={iconSize} />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-full z-50 mt-1 w-40 overflow-hidden rounded-md border border-border-1 bg-popover py-1 shadow-md"
        >
          {showPager && (
            <>
              <MenuItem
                onClick={() => {
                  onPrev?.()
                  setOpen(false)
                }}
                icon={<ChevronLeft className="h-4 w-4" />}
                label="上一页"
              />
              <MenuItem
                onClick={() => {
                  onNext?.()
                  setOpen(false)
                }}
                icon={<ChevronRight className="h-4 w-4" />}
                label="下一页"
              />
            </>
          )}
          {onCollapseToolbar && (
            <MenuItem
              onClick={() => {
                onCollapseToolbar()
                setOpen(false)
              }}
              icon={<ChevronUp className="h-4 w-4" />}
              label="收起工具栏"
            />
          )}
        </div>
      )}
    </div>
  )
}

function MenuItem({
  onClick,
  icon,
  label,
}: {
  onClick?: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-2 hover:bg-surface-2 hover:text-text-1"
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
