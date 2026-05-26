export type AnnotationKind = 'highlight' | 'underline' | 'note' | 'strikethrough'

/**
 * PDF 批注矩形：相对页面尺寸归一化（0..1）。
 * 一段跨多行的 selection 可能对应多个矩形（Range.getClientRects）。
 */
export interface PdfNormRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Annotation {
  annotation_id: string
  resource_id: string
  kind: AnnotationKind
  color: string
  cfi_start: string
  cfi_end: string
  page_index: number
  text_offset_start: number
  text_offset_end: number
  selected_text: string
  note_content: string
  /**
   * PDF 批注专用：JSON 字符串形式的 PdfNormRect[]。非 PDF 批注为空串。
   * 后端存为 `annotations.pdf_rects TEXT`。前端用 `parsePdfRects` 解析。
   */
  pdf_rects: string
  created_at: string
  updated_at: string
}

/**
 * 安全解析 `annotation.pdf_rects`。非法或空串返回 []。
 */
export function parsePdfRects(raw: string | undefined | null): PdfNormRect[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (r): r is PdfNormRect =>
        r &&
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.w === 'number' &&
        typeof r.h === 'number'
    )
  } catch {
    return []
  }
}

/**
 * 把同一行的多个 rect 合并成一个连续矩形。
 *
 * 来源：`Range.getClientRects()` 在跨多个 textLayer span 时会返回每个 span 一个
 * 子 rect，相邻 rect 之间存在 1-2px 缝隙；直接渲染会出现"被切碎的高亮"视觉
 * （详见用户反馈截图）。
 *
 * 行判定：两个 rect 的 y 中心点距离 < `min(h_a, h_b) * 0.5` 视为同一行；
 * 实际多行选区也能正确分组（行距通常远大于行高的一半）。
 *
 * 同行合并：取最小 left / 最小 top / 最大 right / 最大 bottom。
 *
 * 在创建时（PdfSelectionPopover commit 前）和渲染时（PdfAnnotationOverlay）
 * 都调用——前者减少 DB 体积，后者修复历史脏数据。
 */
export function mergePdfRectsByLine(rects: PdfNormRect[]): PdfNormRect[] {
  if (rects.length <= 1) return rects.slice()
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const lines: PdfNormRect[][] = []
  for (const r of sorted) {
    const last = lines[lines.length - 1]
    if (!last) {
      lines.push([r])
      continue
    }
    const prev = last[last.length - 1]
    const prevCenter = prev.y + prev.h / 2
    const rCenter = r.y + r.h / 2
    if (Math.abs(prevCenter - rCenter) < Math.min(prev.h, r.h) * 0.5) {
      last.push(r)
    } else {
      lines.push([r])
    }
  }
  return lines.map((line) => {
    const x = Math.min(...line.map((r) => r.x))
    const y = Math.min(...line.map((r) => r.y))
    const right = Math.max(...line.map((r) => r.x + r.w))
    const bottom = Math.max(...line.map((r) => r.y + r.h))
    return { x, y, w: right - x, h: bottom - y }
  })
}

export interface Bookmark {
  bookmark_id: string
  resource_id: string
  cfi: string
  page_index: number
  label: string
  created_at: string
}

export interface ReadingProgress {
  resource_id: string
  cfi: string
  page_index: number
  percent: number
  total_reading_seconds: number
  last_read_at: string
}
