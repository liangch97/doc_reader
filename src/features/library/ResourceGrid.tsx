import type { Resource } from '@/types/resource'
import { ResourceCard } from './ResourceCard'

interface Props {
  resources: Resource[]
  progressMap?: Record<string, number>
  /** 任一卡片完成"删除 / 导出"等动作后调用，让父组件刷新列表 */
  onChanged?: () => void
}

export function ResourceGrid({ resources, progressMap, onChanged }: Props) {
  // 卡片自身 w-40（160px），grid min-col 与之对齐；HomePage/CourseWorkspace 复用同一张卡片，
  // 不在此处改卡片宽度（避免它处副作用）。平板触控的"菜单常驻"已经在 ResourceCard 实现。
  return (
    <div
      className="grid gap-6"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
    >
      {resources.map((r) => (
        <ResourceCard
          key={r.resource_id}
          resource={r}
          progress={progressMap?.[r.resource_id]}
          onChanged={onChanged}
        />
      ))}
    </div>
  )
}
