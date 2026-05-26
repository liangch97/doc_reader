      /**
 * LearningHistoryPanel —— 右栏「学习历史」tab 容器（v6 #3+ 修订）
 *
 * 设计反转：以**档案管理**为主，事件时间线退居子标签。
 *
 * 子标签：
 *   - 'archives' (默认) : ArchiveListPanel —— 历次学习会话的列表 / 复习 / 恢复 / 重命名 / 删除
 *   - 'timeline'         : VibeHistoryPanel —— 事件时间线（保留作为辅助视角）
 *
 * 复用：
 *   - ArchiveListPanel 在 tab 模式下不传 onClose（无右上角 X，长驻 tab）
 *   - 恢复成功后通过 'reader-pane-change' 切到 'agent' tab，让用户看到恢复结果
 *
 * 注意：本组件仅在 doc_session 可用时渲染（AiPaneContainer 上层判断）。
 */
import { useEffect, useState } from 'react'
import { Archive, Clock } from 'lucide-react'
import { cn } from '@/lib/cn'
import { ArchiveListPanel } from './ArchiveListPanel'
import { VibeHistoryPanel } from './VibeHistoryPanel'

type SubTab = 'archives' | 'timeline'

interface Props {
  sessionId: string
  /** 父组件标识本 tab 是否处于活动态（VibeHistoryPanel 内部用作刷新触发） */
  isActive?: boolean
}

export function LearningHistoryPanel({ sessionId, isActive }: Props) {
  const [subTab, setSubTab] = useState<SubTab>('archives')
  // 接收 VibeHistoryPanel 的「查看上一次学习」跳转信号 → 切到档案 + 传 initialArchiveId
  const [initialArchiveId, setInitialArchiveId] = useState<string | undefined>(undefined)

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ archiveId?: string }>).detail
      const id = detail?.archiveId
      if (!id) return
      setSubTab('archives')
      setInitialArchiveId(id)
    }
    window.addEventListener('agent-open-archive', handler)
    return () => window.removeEventListener('agent-open-archive', handler)
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部子 tab 切换 */}
      <div className="flex shrink-0 items-center gap-0 border-b border-border-1 bg-bg-2/30 px-2 text-[11px]">
        <SubTabBtn
          active={subTab === 'archives'}
          onClick={() => setSubTab('archives')}
          icon={<Archive className="size-3" />}
        >
          档案管理
        </SubTabBtn>
        <SubTabBtn
          active={subTab === 'timeline'}
          onClick={() => setSubTab('timeline')}
          icon={<Clock className="size-3" />}
        >
          时间线
        </SubTabBtn>
      </div>

      {/* 子 tab 内容：用 hidden 切换以保持子组件状态（避免每次切回重新拉数据） */}
      <div className="min-h-0 flex-1">
        <div className={cn('h-full', subTab !== 'archives' && 'hidden')}>
          <ArchiveListPanel
            sessionId={sessionId}
            initialArchiveId={initialArchiveId}
            onRestored={() => {
              // 恢复成功后，让用户回到学习区看新内容
              window.dispatchEvent(
                new CustomEvent('reader-pane-change', { detail: { pane: 'agent' } }),
              )
              // 清掉 initial 标记，避免下次重新切回时又自动进复习
              setInitialArchiveId(undefined)
            }}
          />
        </div>
        <div className={cn('h-full', subTab !== 'timeline' && 'hidden')}>
          <VibeHistoryPanel sessionId={sessionId} isActive={isActive && subTab === 'timeline'} />
        </div>
      </div>
    </div>
  )
}

function SubTabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 border-b-2 px-2.5 py-1.5 transition',
        active
          ? 'border-indigo-500 text-text-1'
          : 'border-transparent text-text-3 hover:text-text-2',
      )}
    >
      {icon}
      {children}
    </button>
  )
}
