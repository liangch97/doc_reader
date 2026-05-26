import { Link } from 'react-router-dom'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Resource } from '@/types/resource'
import { cn } from '@/lib/cn'
import {
  useCoverStyles,
  paperHashIdx,
  COVER_TITLE_FONT,
  type CoverStyle,
} from './coverPalette'
import { ResourceCardMenu } from './ResourceCardMenu'

interface Props {
  resource: Resource
  progress?: number
  /**
   * 卡片菜单触发"删除 / 导出"等动作后调用，让父组件 reload 列表。
   * 不传则菜单的"删除"动作仍会执行，只是上层可能展示陈旧数据。
   */
  onChanged?: () => void
}

function strHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * 5 种排版驱动的封面：
 *   - editorial: 大字号左对齐 + 顶部细横线
 *   - colossal:  巨大首字铺满 + 完整标题压在底部
 *   - bauhaus:   一个色块圆/方/三角 + 底部小标题
 *   - manuscript:垂直左侧色边 + 居左大标题
 *   - minimal:   纯净留白 + 底部小标题 + 角落 accent 点
 */
type Layout = 'editorial' | 'colossal' | 'bauhaus' | 'manuscript' | 'minimal'
const LAYOUTS: Layout[] = ['editorial', 'colossal', 'bauhaus', 'manuscript', 'minimal']

function pickLayout(s: string): Layout {
  return LAYOUTS[(strHash(s) >> 3) % LAYOUTS.length]
}

/* ────────── 对称圆润抽象 SVG 装饰 ────────── */
type Ornament = 'concentric' | 'petal' | 'halo' | 'vesica' | 'rings'
const ORNAMENTS: Ornament[] = ['concentric', 'petal', 'halo', 'vesica', 'rings']
function pickOrnament(s: string): Ornament {
  return ORNAMENTS[(strHash(s) >> 5) % ORNAMENTS.length]
}

function OrnamentSvg({
  kind,
  color,
  className,
  opacity = 0.14,
}: {
  kind: Ornament
  color: string
  className?: string
  opacity?: number
}) {
  const common = {
    viewBox: '0 0 100 100',
    fill: 'none',
    stroke: color,
    strokeWidth: 1,
    'aria-hidden': true,
    className,
    style: { opacity },
  } as const
  switch (kind) {
    case 'concentric':
      return (
        <svg {...common}>
          <circle cx="50" cy="50" r="46" />
          <circle cx="50" cy="50" r="32" />
          <circle cx="50" cy="50" r="18" />
          <circle cx="50" cy="50" r="4" fill={color} stroke="none" />
        </svg>
      )
    case 'petal':
      return (
        <svg {...common}>
          <circle cx="50" cy="30" r="22" />
          <circle cx="50" cy="70" r="22" />
          <circle cx="30" cy="50" r="22" />
          <circle cx="70" cy="50" r="22" />
        </svg>
      )
    case 'halo': {
      const dots = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = 38
        const rad = (a * Math.PI) / 180
        return { x: 50 + r * Math.cos(rad), y: 50 + r * Math.sin(rad), key: a }
      })
      return (
        <svg {...common}>
          <circle cx="50" cy="50" r="20" />
          {dots.map((d) => (
            <circle key={d.key} cx={d.x} cy={d.y} r="2.5" fill={color} stroke="none" />
          ))}
        </svg>
      )
    }
    case 'vesica':
      return (
        <svg {...common}>
          <circle cx="36" cy="50" r="28" />
          <circle cx="64" cy="50" r="28" />
        </svg>
      )
    case 'rings':
      return (
        <svg {...common}>
          <circle cx="50" cy="50" r="44" />
          <circle cx="50" cy="50" r="34" strokeDasharray="2 4" />
          <circle cx="50" cy="50" r="24" />
          <circle cx="50" cy="50" r="14" strokeDasharray="2 3" />
        </svg>
      )
  }
}

export function ResourceCard({ resource, progress, onChanged }: Props) {
  const pct = typeof progress === 'number' ? Math.round(progress * 100) : null
  const styles = useCoverStyles()
  const style = styles[paperHashIdx(resource.title || resource.resource_id)]
  const layout = pickLayout(resource.title || resource.resource_id)

  const rawCover = resource.cover_path?.trim() || ''
  const hasNativeCover = rawCover.length > 0
  const coverSrc = !hasNativeCover
    ? ''
    : rawCover.startsWith('http') || rawCover.startsWith('data:')
      ? rawCover
      : convertFileSrc(rawCover)

  return (
    /*
     * 用 div 作为外层 group，再把 Link 平铺到内部 absolute inset-0 上 ——
     * 这样可以把"操作菜单按钮"叠在卡片右上角而**不嵌套在 <a> 内**
     * （HTML 不允许 <button> 作 <a> 的后代；嵌套时 React 也会 warning）。
     * 卡片视觉内容在 z-10，可见但 pointer-events: none，让点击穿透到下层 Link；
     * 菜单按钮自身 z-20 + pointer-events: auto 截获 click，不触发跳转。
     */
    <div className="group relative flex w-40 shrink-0 flex-col">
      <Link
        to={`/reader/${resource.resource_id}`}
        aria-label={resource.title}
        className="absolute inset-0 z-0 rounded-md transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
      />
      <div
        className={cn(
          'pointer-events-none relative z-10 flex w-full flex-col gap-2 rounded-md p-2'
        )}
      >
      <div
        className="relative flex h-56 w-full overflow-hidden rounded-[4px] transition-transform group-hover:-translate-y-0.5"
        style={
          hasNativeCover
            ? {
                background: '#1a1a1f',
                boxShadow:
                  '0 4px 12px -2px rgba(20,15,5,0.35), inset 0 0 0 1px rgba(0,0,0,0.15)',
              }
            : {
                background: style.bg,
                boxShadow:
                  '0 4px 12px -2px rgba(60,50,30,0.28), inset 0 0 0 1px rgba(255,255,255,0.18)',
              }
        }
      >
        {hasNativeCover ? (
          <img
            src={coverSrc}
            alt={resource.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <CoverArtwork title={resource.title} layout={layout} style={style} />
        )}

        {pct !== null && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/15">
            <div className="h-full" style={{ width: `${pct}%`, background: style.accent }} />
          </div>
        )}
      </div>
      <div
        className="line-clamp-2 text-xs font-medium text-text-1"
        title={resource.title}
      >
        {resource.title}
      </div>
      {/* 卡片下方进度条：封面底部已有 3px hairline，但视觉太弱；这里再加一条
          带百分比文字的，作为正式的"读到哪里"指示。pct === 0 时仍显示一根细
          骨架，告诉用户"这本还没开始读"，比无视觉零状态更清晰。 */}
      {pct !== null && (
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{ width: `${pct}%`, background: style.accent }}
            />
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-text-3">{pct}%</span>
        </div>
      )}
      </div>
      {/*
        卡片菜单：导出 / 删除。
        - **始终可见**（不再仅 hover 显现）——触屏平板没有 hover 事件，hover-only
          等于功能完全不可用；同时显式的"三点"按钮也比"悬停才出现"更符合发现性原则。
        - 桌面端非 hover 时降低透明度（opacity-70）避免喧宾夺主，hover 或 focus
          时恢复 100%；
        - `pointer-events: auto` 让自己能接收点击；下拉面板在 ResourceCardMenu
          内部 z-30 渲染。
      */}
      <div className="pointer-events-auto absolute right-2 top-2 opacity-70 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ResourceCardMenu resource={resource} onChanged={onChanged} />
      </div>
    </div>
  )
}

/* ────────── 5 种布局 ────────── */
function CoverArtwork({
  title,
  layout,
  style,
}: {
  title: string
  layout: Layout
  style: CoverStyle
}) {
  const t = title.trim() || 'Untitled'
  const firstChar = t.charAt(0).toUpperCase()
  const ornament = pickOrnament(title)

  switch (layout) {
    /* Editorial — 顶部细线 + 巨大左对齐衬体标题（杂志感） */
    case 'editorial': {
      return (
        <div className="relative flex h-full w-full flex-col px-4 py-5">
          <OrnamentSvg
            kind={ornament}
            color={style.accent}
            className="pointer-events-none absolute -right-10 -top-10 h-40 w-40"
            opacity={0.14}
          />
          <div
            className="relative h-[2px] w-6"
            style={{ background: style.accent }}
          />
          <div className="relative mt-auto pb-2">
            <div
              className="line-clamp-5 text-left text-[20px] leading-[1.1]"
              title={title}
              style={{
                fontFamily: COVER_TITLE_FONT,
                fontWeight: 600,
                letterSpacing: '-0.01em',
                color: style.ink,
              }}
            >
              {t}
            </div>
          </div>
        </div>
      )
    }

    /* Colossal — 超大首字铺满 + 底部小完整标题 */
    case 'colossal': {
      return (
        <div className="relative flex h-full w-full">
          <div
            aria-hidden
            className="absolute -left-2 -top-3 select-none leading-none"
            style={{
              fontFamily: COVER_TITLE_FONT,
              fontWeight: 700,
              fontSize: '180px',
              color: style.accent,
              opacity: 0.18,
              letterSpacing: '-0.04em',
            }}
          >
            {firstChar}
          </div>
          <div className="relative mt-auto w-full px-4 pb-5">
            <div
              className="h-px w-8"
              style={{ background: style.accent, opacity: 0.7 }}
            />
            <div
              className="mt-3 line-clamp-4 text-left text-[14px] leading-[1.35]"
              title={title}
              style={{
                fontFamily: COVER_TITLE_FONT,
                fontWeight: 500,
                letterSpacing: '0.01em',
                color: style.ink,
              }}
            >
              {t}
            </div>
          </div>
        </div>
      )
    }

    /* Bauhaus — 几何色块 + 底部小标题 */
    case 'bauhaus': {
      // 形状选择：按 hash 决定 圆 / 方 / 三角
      const shapeIdx = strHash(title) % 3
      return (
        <div className="relative flex h-full w-full flex-col">
          {/* 顶部偏右的几何块 */}
          <div className="relative h-[58%] w-full overflow-hidden">
            {shapeIdx === 0 && (
              <div
                aria-hidden
                className="absolute right-[-30%] top-[-30%] h-[160%] w-[160%] rounded-full"
                style={{ background: style.accent, opacity: 0.85 }}
              />
            )}
            {shapeIdx === 1 && (
              <div
                aria-hidden
                className="absolute right-[12%] top-[20%] h-[60%] w-[60%]"
                style={{ background: style.accent, opacity: 0.85 }}
              />
            )}
            {shapeIdx === 2 && (
              <div
                aria-hidden
                className="absolute right-[10%] top-[15%] h-[70%] w-[70%]"
                style={{
                  background: style.accent,
                  opacity: 0.85,
                  clipPath: 'polygon(50% 0, 100% 100%, 0 100%)',
                }}
              />
            )}
          </div>
          <div className="flex-1 px-4 py-3">
            <div
              className="line-clamp-3 text-left text-[14px] leading-[1.35]"
              title={title}
              style={{
                fontFamily: COVER_TITLE_FONT,
                fontWeight: 500,
                letterSpacing: '0.02em',
                color: style.ink,
              }}
            >
              {t}
            </div>
          </div>
        </div>
      )
    }

    /* Manuscript — 左侧 accent 竖边 + 居左大标题（古书页感） */
    case 'manuscript': {
      return (
        <div className="relative flex h-full w-full overflow-hidden">
          <OrnamentSvg
            kind={ornament}
            color={style.accent}
            className="pointer-events-none absolute -bottom-12 -right-12 h-44 w-44"
            opacity={0.13}
          />
          <div
            className="relative h-full w-[6px] shrink-0"
            style={{ background: style.accent, opacity: 0.85 }}
          />
          <div className="relative flex flex-1 flex-col px-4 py-5">
            <div
              className="text-[10px] uppercase tracking-[0.3em]"
              style={{ color: style.accent, opacity: 0.85 }}
            >
              {firstChar}
            </div>
            <div className="mt-auto">
              <div
                className="line-clamp-5 text-left text-[17px] leading-[1.2]"
                title={title}
                style={{
                  fontFamily: COVER_TITLE_FONT,
                  fontWeight: 500,
                  letterSpacing: '0.01em',
                  color: style.ink,
                }}
              >
                {t}
              </div>
              <div
                className="mt-3 h-px w-6"
                style={{ background: style.frame, opacity: 0.6 }}
              />
            </div>
          </div>
        </div>
      )
    }

    /* Minimal — 纯净留白 + 角落 accent 点 + 底部小标题（瑞士极简） */
    case 'minimal': {
      return (
        <div className="relative flex h-full w-full flex-col overflow-hidden px-4 py-5">
          <OrnamentSvg
            kind={ornament}
            color={style.accent}
            className="pointer-events-none absolute left-1/2 top-1/2 h-44 w-44 -translate-x-1/2 -translate-y-1/2"
            opacity={0.11}
          />
          <div className="relative flex items-center gap-1.5">
            <div
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: style.accent }}
            />
            <div
              className="text-[10px] uppercase tracking-[0.25em]"
              style={{ color: style.ink, opacity: 0.5 }}
            >
              {firstChar}
            </div>
          </div>
          <div className="relative mt-auto">
            <div
              className="line-clamp-5 text-left text-[15px] leading-[1.35]"
              title={title}
              style={{
                fontFamily: COVER_TITLE_FONT,
                fontWeight: 500,
                letterSpacing: '0.01em',
                color: style.ink,
              }}
            >
              {t}
            </div>
          </div>
        </div>
      )
    }
  }
}
