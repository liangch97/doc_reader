import { useEffect, useState } from 'react'
import { Archive, Bookmark, Dumbbell, FileText, GraduationCap, Highlighter, Send } from 'lucide-react'
import { AnnotationsPanel } from './AnnotationsPanel'
import { AiPaneContainer } from './AiPaneContainer'
import { onAiExplain } from './readerAiBus'
import type { Annotation, Bookmark as BookmarkT } from '@/types/annotation'
import type { Resource } from '@/types/resource'
import type { FoliateTocItem } from '@/lib/foliate'
import { cn } from '@/lib/cn'

interface Props {
  resource: Resource
  toc: FoliateTocItem[]
  currentPageIndex?: number
  /** 当前可见页面的原始文本（优先于后端 DB 查询）。 */
  currentPageContent?: string
  annotations: Annotation[]
  bookmarks: BookmarkT[]
  onJumpAnnotation: (a: Annotation) => void
  onDeleteAnnotation: (a: Annotation) => void
  onJumpBookmark: (b: BookmarkT) => void
  onDeleteBookmark: (b: BookmarkT) => void
  /** RAG 来源跳转：ChatTab 点击 [P12-13] 标签时触发，仅 Legacy 资料生效 */
  onJumpPage?: (pageIndex: number) => void
}

/**
 * 右栏 4-tab 单层平铺：
 *   笔记 | 聊天 | 标注 | 书签
 *
 * 历史：早期是「AI / 标注」外层 + 「笔记 / 聊天」内层 + 「标注 / 书签」第三层
 * 三层 tab，再叠上沉浸式工具栏的磨砂浮层 → 视觉极乱。本版本把所有 tab 升到
 * 顶层一行，无嵌套；图标即语义，文字辅助。
 */
type Pane = 'note' | 'chat' | 'agent' | 'training' | 'vibe' | 'annotations' | 'bookmarks'

export function RightPane({
  resource,
  toc,
  currentPageIndex,
  currentPageContent,
  annotations,
  bookmarks,
  onJumpAnnotation,
  onDeleteAnnotation,
  onJumpBookmark,
  onDeleteBookmark,
  onJumpPage,
}: Props) {
  // 续读：记住上次激活的 tab，每个资料独立存（用户在 A 书选了"标注"，
  // 切到 B 书会回到 B 书自己上次的 tab，不会跨书污染）。
  // localStorage 不依赖后端，刷新即取，丢失也无伤大雅。
  // v4 (2026-05) P5.1：若 URL 含 ?pane=xxx 优先用它（顶层 TrainingPage 等入口跳转时定位 tab）。
  const lsKey = `reader:right-pane:${resource.resource_id}`
  const isValidPane = (v: string | null | undefined): v is Pane =>
    v === 'note' ||
    v === 'chat' ||
    v === 'agent' ||
    v === 'training' ||
    v === 'vibe' ||
    v === 'annotations' ||
    v === 'bookmarks'
  const [pane, setPane] = useState<Pane>(() => {
    try {
      // 先看 URL ?pane=
      const urlPane = new URLSearchParams(window.location.search).get('pane')
      if (isValidPane(urlPane)) return urlPane
      // 退回 localStorage
      const v = localStorage.getItem(lsKey)
      if (isValidPane(v)) return v
    } catch {
      /* localStorage / URL 不可用 → 使用默认值 */
    }
    return 'note'
  })
  useEffect(() => {
    try {
      localStorage.setItem(lsKey, pane)
    } catch {
      /* 同上：禁用时静默 */
    }
  }, [pane, lsKey])
  const aiAvailable = !!resource.doc_session_id

  // 选区"AI 解释"事件：自动切到 chat tab。
  // 若资源没有 doc_session（AI 不可用），仍然切过去显示"需要抽取文本"提示，比静默无响应好。
  useEffect(() => {
    return onAiExplain(() => {
      setPane('chat')
    })
  }, [])

  // v5 (2026-05) B2: 学习区「练习本单元」按钮派发的内部事件 → 切到 training tab
  // 由 AgentTab.PracticeUnitCta 触发，detail.pane 必为 'training'。
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ pane?: string }>).detail
      if (detail?.pane && isValidPane(detail.pane)) {
        setPane(detail.pane)
      }
    }
    window.addEventListener('reader-pane-change', handler)
    return () => window.removeEventListener('reader-pane-change', handler)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 border-b border-border-1 bg-surface-1 text-xs">
        <PaneBtn active={pane === 'note'} onClick={() => setPane('note')}>
          <FileText className="h-3.5 w-3.5" /> 笔记
        </PaneBtn>
        <PaneBtn
          active={pane === 'chat'}
          onClick={() => setPane('chat')}
          disabled={!aiAvailable}
          title={aiAvailable ? undefined : '聊天需要资料已抽取文本'}
        >
          <Send className="h-3.5 w-3.5" /> 聊天
        </PaneBtn>
        <PaneBtn
          active={pane === 'agent'}
          onClick={() => setPane('agent')}
          disabled={!aiAvailable}
          title={aiAvailable ? '学习 Agent：路线图 + 按页讲解 / 考察 / 判分' : '学习 Agent 需要资料已抽取文本'}
        >
          <GraduationCap className="h-3.5 w-3.5" /> 学习
        </PaneBtn>
        <PaneBtn
          active={pane === 'training'}
          onClick={() => setPane('training')}
          disabled={!aiAvailable}
          title={aiAvailable ? '训练：多题型刷题 + 代码运行 + 技能树' : '训练需要资料已抽取文本'}
        >
          <Dumbbell className="h-3.5 w-3.5" /> 训练
        </PaneBtn>
        {/* v6 (2026-05) #3+ 修订：以档案管理为主、时间线为辅的学习历史 */}
        <PaneBtn
          active={pane === 'vibe'}
          onClick={() => setPane('vibe')}
          disabled={!aiAvailable}
          title={aiAvailable ? '学习档案：历次学习会话的复习 / 恢复 / 重命名 / 删除' : '需要资料已抽取文本'}
        >
          <Archive className="h-3.5 w-3.5" /> 档案
        </PaneBtn>
        <PaneBtn active={pane === 'annotations'} onClick={() => setPane('annotations')}>
          <Highlighter className="h-3.5 w-3.5" /> 标注
          {annotations.length > 0 && (
            <span className="text-[10px] text-text-3">{annotations.length}</span>
          )}
        </PaneBtn>
        <PaneBtn active={pane === 'bookmarks'} onClick={() => setPane('bookmarks')}>
          <Bookmark className="h-3.5 w-3.5" /> 书签
          {bookmarks.length > 0 && (
            <span className="text-[10px] text-text-3">{bookmarks.length}</span>
          )}
        </PaneBtn>
      </div>
      <div className="min-h-0 flex-1">
        {(pane === 'note' || pane === 'chat' || pane === 'agent' || pane === 'training' || pane === 'vibe') && (
          <AiPaneContainer
            resource={resource}
            toc={toc}
            currentPageIndex={currentPageIndex}
            currentPageContent={currentPageContent}
            mode={pane}
            onJumpPage={onJumpPage}
          />
        )}
        {(pane === 'annotations' || pane === 'bookmarks') && (
          <AnnotationsPanel
            view={pane === 'annotations' ? 'notes' : 'bookmarks'}
            annotations={annotations}
            bookmarks={bookmarks}
            onJumpAnnotation={onJumpAnnotation}
            onDeleteAnnotation={onDeleteAnnotation}
            onJumpBookmark={onJumpBookmark}
            onDeleteBookmark={onDeleteBookmark}
          />
        )}
      </div>
    </div>
  )
}

function PaneBtn({
  children,
  active,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 py-2 transition-colors',
        active ? 'bg-surface-2 text-text-1' : 'text-text-3 hover:text-text-1',
        disabled && 'cursor-not-allowed opacity-40 hover:text-text-3'
      )}
    >
      {children}
    </button>
  )
}
