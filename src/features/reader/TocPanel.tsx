import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { FoliateTocItem } from '@/lib/foliate'
import { cn } from '@/lib/cn'

interface Props {
  toc: FoliateTocItem[]
  /**
   * 当前阅读位置对应的 TOC 项 href。不必严格等于某项的 href：
   * 实现会作「带锁定识别（fragment 不严格区分）+ 上祖先高亮」处理。 */
  currentHref?: string | null
  onJump?: (href: string) => void
}

/**
 * 提取 href 的「路径门牌」部分（spine path，去掉后面的 #fragment）。
 * Foliate relocate 返回的 tocItem.href 可能带 fragment、也可能不带，
 * 为了让同一节点内多个子 TOC 都能被「当前路径」包含，只拿前半部分做限定。 */
function baseHref(href: string | null | undefined): string {
  if (!href) return ''
  const i = href.indexOf('#')
  return i >= 0 ? href.slice(0, i) : href
}

export function TocPanel({ toc, currentHref, onJump }: Props) {
  /**
   * 预计算：
   *  - activePath: 从根到当前项的 href 路径（错询中间节点也需要「路径亮色」）
   *  - bestExactHref: 与 currentHref 最匹配的 TOC 项精确 href（可能带 fragment）。 */
  const { activeSet, bestExactHref } = useMemo(() => {
    const set = new Set<string>()
    if (!currentHref) return { activeSet: set, bestExactHref: null as string | null }
    const targetBase = baseHref(currentHref)

    let bestExact: string | null = null
    let bestExactLen = -1
    let bestPath: string[] = []

    const walk = (items: FoliateTocItem[], path: string[]) => {
      for (const it of items) {
        const childPath = [...path, it.href]
        const itemBase = baseHref(it.href)
        // 「匹配」判定：base 路径相同。在多项同一 spine 中、使用与 current 全 href 能够
        // 「拼接后为前缀」的 href 作为首选；其次才是 base 相等。
        if (itemBase === targetBase) {
          const isPrefix = currentHref.startsWith(it.href)
          const score = isPrefix ? it.href.length + 1000 : it.href.length
          if (score > bestExactLen) {
            bestExactLen = score
            bestExact = it.href
            bestPath = childPath
          }
        }
        if (it.subitems && it.subitems.length > 0) walk(it.subitems, childPath)
      }
    }
    walk(toc, [])
    bestPath.forEach((h) => set.add(h))
    return { activeSet: set, bestExactHref: bestExact }
  }, [toc, currentHref])

  if (!toc || toc.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-xs text-text-3">
        暂无目录
      </div>
    )
  }
  return (
    <nav className="h-full overflow-y-auto p-2 text-sm">
      <ul className="flex flex-col gap-0.5">
        {toc.map((it, i) => (
          <TocNode
            key={i}
            item={it}
            depth={0}
            activeSet={activeSet}
            currentHref={bestExactHref}
            onJump={onJump}
          />
        ))}
      </ul>
    </nav>
  )
}

function TocNode({
  item,
  depth,
  activeSet,
  currentHref,
  onJump,
}: {
  item: FoliateTocItem
  depth: number
  activeSet: Set<string>
  currentHref: string | null
  onJump?: (href: string) => void
}) {
  const isOnPath = activeSet.has(item.href)
  const isCurrent = currentHref !== null && currentHref === item.href
  const [open, setOpen] = useState(depth < 1)
  // 当前路径覆盖到本项时自动展开（仅打开，不主动收合 —— 避免干扰用户手动展收）
  useEffect(() => {
    if (isOnPath) setOpen(true)
  }, [isOnPath])
  // 当项变为 current 时滚到可见
  const btnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (isCurrent && btnRef.current) {
      btnRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [isCurrent])

  const hasChildren = !!item.subitems && item.subitems.length > 0
  return (
    <li>
      <div
        className={cn(
          'group flex items-center rounded-md transition-colors',
          isCurrent
            ? 'bg-accent/15 text-text-1 ring-1 ring-inset ring-accent/40'
            : isOnPath
              ? 'bg-surface-2/60 text-text-1'
              : 'hover:bg-surface-2'
        )}
        style={{ paddingLeft: depth * 12 }}
      >
        {/* 左侧 active 指示条 —— 仅「当前项」走实心色 */}
        <span
          aria-hidden
          className={cn(
            'mr-1 ml-0.5 inline-block h-4 w-0.5 shrink-0 rounded-full transition-colors',
            isCurrent ? 'bg-accent' : 'bg-transparent'
          )}
        />
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex h-7 w-7 shrink-0 items-center justify-center text-text-3 hover:text-text-1"
            aria-label={open ? '收起' : '展开'}
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
            />
          </button>
        ) : (
          <span className="h-7 w-7 shrink-0" />
        )}
        <button
          ref={btnRef}
          type="button"
          onClick={() => onJump?.(item.href)}
          className={cn(
            'flex-1 truncate py-1 pr-2 text-left transition-colors',
            isCurrent
              ? 'font-medium text-text-1'
              : isOnPath
                ? 'text-text-1'
                : 'text-text-2 hover:text-text-1'
          )}
          title={item.label}
        >
          {item.label}
        </button>
      </div>
      {hasChildren && open && (
        <ul className="flex flex-col gap-0.5">
          {item.subitems!.map((sub, i) => (
            <TocNode
              key={i}
              item={sub}
              depth={depth + 1}
              activeSet={activeSet}
              currentHref={currentHref}
              onJump={onJump}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
