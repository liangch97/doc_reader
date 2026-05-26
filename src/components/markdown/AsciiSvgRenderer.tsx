/**
 * AsciiSvgRenderer —— 把 parseAsciiGraph 的输出渲染为 SVG（v6 #4）
 *
 * 坐标系换算：字符网格 (col, row) → SVG (x, y)，按等宽字体假设。
 *   CELL_W = 9px，CELL_H = 20px（与 markdown 区 .md-ascii pre 字号兼容）
 *
 * 渲染要素：
 *   - 矩形节点：圆角 + 实色描边 + 浅色填充（亮/暗主题各一套）
 *   - 节点文字：居中（多行用 <tspan>），自动按 cell 行高换行
 *   - 边：折线（path L 命令），起止吸附到节点边界，箭头用 <marker>
 *   - 整图可缩放（preserveAspectRatio=xMidYMid meet）+ 自适应容器宽度
 */
import { memo, useId } from 'react'
import type { AsciiGraph, AsciiRect, AsciiEdge } from './asciiToSvg'

interface Props {
  graph: AsciiGraph
}

// 字符网格 → 像素映射（与 monospace 行间距近似匹配）
const CELL_W = 9
const CELL_H = 20
const PAD = 8 // 整体外边距，避免贴边

function rectToSvgRect(r: AsciiRect) {
  const x = r.col * CELL_W + PAD
  const y = r.row * CELL_H + PAD
  const w = (r.width - 1) * CELL_W
  const h = (r.height - 1) * CELL_H
  return { x, y, w, h }
}

/** 把 path 中间所有点都吸附到节点矩形外边界（避免线伸进节点内部） */
function clampEdgePath(edge: AsciiEdge, rects: AsciiRect[]): Array<[number, number]> {
  const findRect = (id: string) => rects.find((r) => r.id === id) ?? null
  const from = findRect(edge.fromId)
  const to = findRect(edge.toId)
  const px: Array<[number, number]> = edge.path.map(([c, r]) => [
    c * CELL_W + PAD + CELL_W / 2,
    r * CELL_H + PAD + CELL_H / 2,
  ])
  // 把第一个点贴到 from 矩形最近的边
  if (from) {
    const sg = rectToSvgRect(from)
    const [x, y] = px[0]
    const clamped: [number, number] = clampToRectEdge(x, y, sg.x, sg.y, sg.w, sg.h)
    px[0] = clamped
  }
  // 倒数第二个点（箭头前一个） → 贴 to 矩形最近的边
  if (to && px.length >= 2) {
    const sg = rectToSvgRect(to)
    const lastIdx = px.length - 1
    const [x, y] = px[lastIdx]
    const clamped: [number, number] = clampToRectEdge(x, y, sg.x, sg.y, sg.w, sg.h)
    px[lastIdx] = clamped
  }
  return px
}

function clampToRectEdge(
  x: number,
  y: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): [number, number] {
  // 点已经在矩形外（trace 终点是边界 + 1 格）→ 把它投影到最近的边中点
  const cx = rx + rw / 2
  const cy = ry + rh / 2
  const dx = x - cx
  const dy = y - cy
  // 哪个轴更"出格"
  if (Math.abs(dx) > Math.abs(dy)) {
    return [dx > 0 ? rx + rw : rx, Math.max(ry, Math.min(ry + rh, y))]
  } else {
    return [Math.max(rx, Math.min(rx + rw, x)), dy > 0 ? ry + rh : ry]
  }
}

function pathD(points: Array<[number, number]>): string {
  if (points.length === 0) return ''
  return (
    'M ' +
    points
      .map(([x, y], i) => (i === 0 ? `${x.toFixed(1)} ${y.toFixed(1)}` : `L ${x.toFixed(1)} ${y.toFixed(1)}`))
      .join(' ')
  )
}

function AsciiSvgRendererImpl({ graph }: Props) {
  const markerId = useId().replace(/:/g, '') // SVG id 不能含冒号
  const W = graph.cols * CELL_W + PAD * 2
  const H = graph.rows * CELL_H + PAD * 2

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height="auto"
      preserveAspectRatio="xMidYMid meet"
      className="ascii-svg"
      role="img"
      aria-label="ASCII 流程图（SVG 可视化）"
    >
      <defs>
        <marker
          id={`arrow-${markerId}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" className="ascii-svg-arrow-head" />
        </marker>
        <pattern id={`dotgrid-${markerId}`} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.6" className="ascii-svg-dot" />
        </pattern>
      </defs>

      {/* 背景：dot-grid（与原 AsciiDiagram 风格延续，但是 SVG 原生） */}
      <rect x="0" y="0" width={W} height={H} className="ascii-svg-bg" />
      <rect x="0" y="0" width={W} height={H} fill={`url(#dotgrid-${markerId})`} opacity="0.6" />

      {/* 边（先画，让节点盖在上面） */}
      {graph.edges.map((e, i) => {
        const pts = clampEdgePath(e, graph.rects)
        if (pts.length < 2) return null
        return (
          <path
            key={`e-${i}`}
            d={pathD(pts)}
            className="ascii-svg-edge"
            markerEnd={`url(#arrow-${markerId})`}
          />
        )
      })}

      {/* 节点矩形 + 文本 */}
      {graph.rects.map((r) => {
        const { x, y, w, h } = rectToSvgRect(r)
        const lines = r.text.split('\n')
        // 文本：垂直居中，按行高 16 排列
        const lineHeight = 16
        const totalText = (lines.length - 1) * lineHeight
        const baseY = y + h / 2 - totalText / 2
        return (
          <g key={r.id} className="ascii-svg-node">
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx="6"
              ry="6"
              className="ascii-svg-node-rect"
            />
            {lines.map((ln, i) => (
              <text
                key={i}
                x={x + w / 2}
                y={baseY + i * lineHeight}
                textAnchor="middle"
                dominantBaseline="central"
                className="ascii-svg-node-text"
              >
                {ln}
              </text>
            ))}
          </g>
        )
      })}
    </svg>
  )
}

export const AsciiSvgRenderer = memo(AsciiSvgRendererImpl)
