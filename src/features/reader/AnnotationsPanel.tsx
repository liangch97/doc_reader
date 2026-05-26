import { Bookmark as BookmarkIcon, Trash2, NotebookPen } from 'lucide-react'
import type { Annotation, Bookmark } from '@/types/annotation'
import { HIGHLIGHT_COLORS, type HighlightColorKey } from '@/lib/foliate'
import { useLayoutMode } from '@/lib/useLayoutMode'
import { cn } from '@/lib/cn'

interface Props {
  /**
   * 受控显示模式：'notes' = 高亮列表，'bookmarks' = 书签列表。
   * 由 RightPane 顶层 tab 决定，不再在面板内部再开一层 tab。
   */
  view: 'notes' | 'bookmarks'
  annotations: Annotation[]
  bookmarks: Bookmark[]
  onJumpAnnotation: (a: Annotation) => void
  onDeleteAnnotation: (a: Annotation) => void
  onJumpBookmark: (b: Bookmark) => void
  onDeleteBookmark: (b: Bookmark) => void
}

// 直接复用 lib/foliate 中的 HIGHLIGHT_COLORS（已统一为 solid hex），避免两处维护。

export function AnnotationsPanel({
  view,
  annotations,
  bookmarks,
  onJumpAnnotation,
  onDeleteAnnotation,
  onJumpBookmark,
  onDeleteBookmark,
}: Props) {
  const mode = useLayoutMode()
  const touch = mode !== 'desktop'

  // 触控模式下，删除按钮要可见且 ≥ 44px；行高度 ≥ 56px。
  const itemPad = touch ? 'p-3' : 'p-2.5'
  const textSize = touch ? 'text-sm' : 'text-xs'
  const noteTextSize = touch ? 'text-xs' : 'text-[11px]'
  const dateSize = touch ? 'text-[11px]' : 'text-[10px]'
  const deleteBtn = touch
    ? 'flex h-11 w-11 items-center justify-center text-text-3 hover:text-error'
    : 'text-text-3 opacity-0 transition-opacity hover:text-error group-hover:opacity-100'
  const deleteIcon = touch ? 'h-5 w-5' : 'h-3 w-3'
  const colorDot = touch ? 'mt-1 h-3 w-3 shrink-0 rounded-full' : 'mt-1 h-2 w-2 shrink-0 rounded-full'
  const bookmarkBtnH = touch ? 'min-h-[44px]' : ''

  return (
    <div className={cn('flex h-full flex-col', touch ? 'p-3' : 'p-3')}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === 'notes' && (
          <ul className={cn('flex flex-col', touch ? 'gap-2.5' : 'gap-2')}>
            {annotations.length === 0 && (
              <li className="rounded-md border border-dashed border-border-1 p-4 text-center text-xs text-text-3">
                选中文本后点工具栏「高亮」可添加
              </li>
            )}
            {annotations.map((a) => (
              <li
                key={a.annotation_id}
                className={cn(
                  'group flex flex-col gap-1.5 rounded-md border border-border-1 bg-surface-1 hover:border-border-2',
                  itemPad
                )}
              >
                <button
                  type="button"
                  onClick={() => onJumpAnnotation(a)}
                  className={cn(
                    'flex items-start gap-2 text-left',
                    touch && 'min-h-[44px]'
                  )}
                >
                  <span
                    className={colorDot}
                    style={{ background: HIGHLIGHT_COLORS[a.color as HighlightColorKey] ?? HIGHLIGHT_COLORS.yellow }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className={cn('line-clamp-3 text-text-2', textSize)}>
                      "{a.selected_text || '(无文本)'}"
                    </div>
                    {a.note_content && (
                      <div className={cn('mt-1.5 flex items-start gap-1 text-text-3', noteTextSize)}>
                        <NotebookPen className={touch ? 'mt-0.5 h-4 w-4 shrink-0' : 'mt-0.5 h-3 w-3 shrink-0'} />
                        <span>{a.note_content}</span>
                      </div>
                    )}
                  </div>
                </button>
                <div className={cn('flex items-center justify-between text-text-4', dateSize)}>
                  <span>{a.created_at?.slice(0, 10)}</span>
                  <button
                    type="button"
                    onClick={() => onDeleteAnnotation(a)}
                    className={deleteBtn}
                    aria-label="删除标注"
                  >
                    <Trash2 className={deleteIcon} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {view === 'bookmarks' && (
          <ul className={cn('flex flex-col', touch ? 'gap-2.5' : 'gap-2')}>
            {bookmarks.length === 0 && (
              <li className="rounded-md border border-dashed border-border-1 p-4 text-center text-xs text-text-3">
                还没有书签
              </li>
            )}
            {bookmarks.map((b) => (
              <li
                key={b.bookmark_id}
                className={cn(
                  'group flex items-center gap-2 rounded-md border border-border-1 bg-surface-1 hover:border-border-2',
                  itemPad,
                  bookmarkBtnH
                )}
              >
                <BookmarkIcon className={touch ? 'h-4 w-4 shrink-0 text-accent' : 'h-3 w-3 shrink-0 text-accent'} />
                <button
                  type="button"
                  onClick={() => onJumpBookmark(b)}
                  className={cn('flex-1 truncate text-left text-text-2', textSize, touch && 'min-h-[44px] py-2')}
                  title={b.label}
                >
                  {b.label || '未命名书签'}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteBookmark(b)}
                  className={deleteBtn}
                  aria-label="删除书签"
                >
                  <Trash2 className={deleteIcon} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
