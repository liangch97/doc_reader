/**
 * ASCII 流程图 → SVG 拓扑解析器（v6 2026-05 #4）
 *
 * 目标：把 LLM 生成的 ASCII art（含 Unicode box-drawing ┌─┐│└┘├┤┬┴┼
 *   及 ASCII +-| 框线 + 箭头 → ← ↑ ↓ --> <-- 等）解析为
 *   `{ nodes: Rect[], edges: Edge[] }` 拓扑，供 SVG 渲染器画出
 *   矩形 / 文本 / 折线 / 箭头。
 *
 * 设计要点：
 *   1. 以字符网格为基础坐标（row, col）；用 monospace 等宽假设。
 *   2. 矩形识别：在每个左上角候选位置扫四边，确认能闭合一个矩形。
 *      左上角候选 = { '┌', '╔', '+' }，右下角候选 = { '┘', '╝', '+' }。
 *   3. 文本提取：矩形内部去框线后，按行 trim，多行 join('\n')。
 *   4. 边识别：以箭头字符为端点（→← ↑↓, ASCII 单 '>' / '<' / '^' / 'v'
 *      仅在与水平/垂直线段相连时才视为箭头）；逆向追踪直线 + 折点
 *      直到撞到矩形边界 → 形成 Edge(srcRectId, dstRectId)。
 *   5. 解析失败（节点数 = 0 / 边数 > 节点数 * 4 / 任何步骤超时）→ 返回 null，
 *      让 UI 走 fallback 字符渲染。
 *
 * 不追求 100% 准确，追求：常见 LLM 教学场景（树/链/简单 DAG）成功率 > 70%。
 */

// ─────── 类型 ─────────────────────────────────────────────────────
export interface AsciiRect {
  /** 节点 id（按发现顺序生成 r0, r1, ...） */
  id: string
  /** 网格坐标：左上 (col, row) 和宽高（字符数） */
  col: number
  row: number
  width: number   // 含边框（≥3）
  height: number  // 含边框（≥3）
  /** 内部文本（去框线、去首尾空白；多行 join 用 \n） */
  text: string
}

export interface AsciiEdge {
  /** 起点矩形 id；若起点不与矩形相连，留空字符串（保留为"游离箭头"） */
  fromId: string
  toId: string
  /** 边的几何：在网格中按列行串成的折线点（[(col,row)...]） */
  path: Array<[number, number]>
  /** 箭头方向（最后一个 segment 决定）：默认 'right' */
  arrow: 'left' | 'right' | 'up' | 'down'
}

export interface AsciiGraph {
  rects: AsciiRect[]
  edges: AsciiEdge[]
  /** 字符网格尺寸（用于 SVG viewBox 计算） */
  cols: number
  rows: number
}

// ─────── 字符集 ───────────────────────────────────────────────────
const BOX_H = new Set(['─', '═', '-', '=']) // 水平线
const BOX_V = new Set(['│', '║', '|']) // 垂直线
const BOX_TL = new Set(['┌', '╔', '┏']) // 左上角
const BOX_TR = new Set(['┐', '╗', '┓'])
const BOX_BL = new Set(['└', '╚', '┗'])
const BOX_BR = new Set(['┘', '╝', '┛'])
const BOX_T_JUNC = new Set(['┬', '╦', '┳']) // T 形（向下）
const BOX_B_JUNC = new Set(['┴', '╩', '┻'])
const BOX_L_JUNC = new Set(['├', '╠', '┣'])
const BOX_R_JUNC = new Set(['┤', '╣', '┫'])
const BOX_CROSS = new Set(['┼', '╬', '╋'])
const ASCII_CORNER = new Set(['+'])

const ARROW_R = new Set(['→', '▶', '⇒', '►'])
const ARROW_L = new Set(['←', '◀', '⇐', '◄'])
const ARROW_U = new Set(['↑', '▲', '⇑'])
const ARROW_D = new Set(['↓', '▼', '⇓'])

const isHLine = (ch: string) => BOX_H.has(ch)
const isVLine = (ch: string) => BOX_V.has(ch)
const isCornerTL = (ch: string) => BOX_TL.has(ch) || ASCII_CORNER.has(ch)
const isCornerTR = (ch: string) => BOX_TR.has(ch) || ASCII_CORNER.has(ch)
const isCornerBL = (ch: string) => BOX_BL.has(ch) || ASCII_CORNER.has(ch)
const isCornerBR = (ch: string) => BOX_BR.has(ch) || ASCII_CORNER.has(ch)
/** 任何"能算到水平线段上"的字符（含 T 形 / 交叉 / 拐点） */
const isOnHLine = (ch: string) =>
  isHLine(ch) ||
  BOX_T_JUNC.has(ch) ||
  BOX_B_JUNC.has(ch) ||
  BOX_CROSS.has(ch) ||
  BOX_L_JUNC.has(ch) ||
  BOX_R_JUNC.has(ch) ||
  isCornerTL(ch) ||
  isCornerTR(ch) ||
  isCornerBL(ch) ||
  isCornerBR(ch)
const isOnVLine = (ch: string) =>
  isVLine(ch) ||
  BOX_T_JUNC.has(ch) ||
  BOX_B_JUNC.has(ch) ||
  BOX_CROSS.has(ch) ||
  BOX_L_JUNC.has(ch) ||
  BOX_R_JUNC.has(ch) ||
  isCornerTL(ch) ||
  isCornerTR(ch) ||
  isCornerBL(ch) ||
  isCornerBR(ch)

// ─────── 网格 ─────────────────────────────────────────────────────
class Grid {
  rows: number
  cols: number
  private lines: string[]
  constructor(text: string) {
    this.lines = text.replace(/\s+$/, '').split('\n')
    this.rows = this.lines.length
    this.cols = Math.max(0, ...this.lines.map((l) => l.length))
  }
  get(row: number, col: number): string {
    if (row < 0 || row >= this.rows) return ''
    const line = this.lines[row]
    if (!line) return ''
    if (col < 0 || col >= line.length) return ''
    return line[col]
  }
  /** 是否在矩形 r 的边界字符上（用于"边追踪撞墙"判定）。 */
  isOnRectBorder(row: number, col: number, r: AsciiRect): boolean {
    const top = r.row
    const bot = r.row + r.height - 1
    const left = r.col
    const right = r.col + r.width - 1
    const onH = row === top || row === bot
    const onV = col === left || col === right
    return (
      (onH && col >= left && col <= right) ||
      (onV && row >= top && row <= bot)
    )
  }
}

// ─────── 矩形识别 ─────────────────────────────────────────────────
function findRects(g: Grid): AsciiRect[] {
  const found: AsciiRect[] = []
  let idCounter = 0

  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const ch = g.get(r, c)
      if (!isCornerTL(ch)) continue
      // 尝试向右扫直到拐角 → 长度
      let w = 0
      for (let cc = c + 1; cc < g.cols; cc++) {
        const ch2 = g.get(r, cc)
        if (isCornerTR(ch2)) {
          w = cc - c + 1
          break
        }
        if (!isHLine(ch2) && !BOX_T_JUNC.has(ch2) && !BOX_CROSS.has(ch2)) break
      }
      if (w < 3) continue
      // 向下扫
      let h = 0
      for (let rr = r + 1; rr < g.rows; rr++) {
        const ch2 = g.get(rr, c)
        if (isCornerBL(ch2)) {
          h = rr - r + 1
          break
        }
        if (!isVLine(ch2) && !BOX_L_JUNC.has(ch2) && !BOX_CROSS.has(ch2)) break
      }
      if (h < 3) continue
      // 验证右下角
      const rb = g.get(r + h - 1, c + w - 1)
      if (!isCornerBR(rb)) continue
      // 验证四条边都通（容忍 T/+ junction）
      let ok = true
      // 上边
      for (let cc = c + 1; cc < c + w - 1 && ok; cc++) {
        const x = g.get(r, cc)
        if (!isOnHLine(x)) ok = false
      }
      // 下边
      for (let cc = c + 1; cc < c + w - 1 && ok; cc++) {
        const x = g.get(r + h - 1, cc)
        if (!isOnHLine(x)) ok = false
      }
      // 左边
      for (let rr = r + 1; rr < r + h - 1 && ok; rr++) {
        const x = g.get(rr, c)
        if (!isOnVLine(x)) ok = false
      }
      // 右边
      for (let rr = r + 1; rr < r + h - 1 && ok; rr++) {
        const x = g.get(rr, c + w - 1)
        if (!isOnVLine(x)) ok = false
      }
      if (!ok) continue
      // 提取内部文本（去框线、左右各保留 1 列内边距）
      const lines: string[] = []
      for (let rr = r + 1; rr < r + h - 1; rr++) {
        let buf = ''
        for (let cc = c + 1; cc < c + w - 1; cc++) {
          buf += g.get(rr, cc)
        }
        lines.push(buf.replace(/\s+$/, ''))
      }
      // 修剪首尾空行
      while (lines.length && lines[0].trim() === '') lines.shift()
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
      const text = lines.map((l) => l.replace(/^\s+/, '')).join('\n').trim()
      found.push({
        id: `r${idCounter++}`,
        row: r,
        col: c,
        width: w,
        height: h,
        text,
      })
    }
  }

  // 过滤"被另一个矩形完全包含"的内嵌矩形（box-drawing 偶尔会有双框）
  return found.filter((rect, idx) => {
    return !found.some(
      (other, j) =>
        j !== idx &&
        other.col <= rect.col &&
        other.row <= rect.row &&
        other.col + other.width >= rect.col + rect.width &&
        other.row + other.height >= rect.row + rect.height &&
        // 严格小于（避免相同矩形互相过滤）
        (other.width > rect.width || other.height > rect.height),
    )
  })
}

// ─────── 边识别 ───────────────────────────────────────────────────
/** 在 (row,col) 找一个相邻矩形（沿 (drow,dcol) 方向走一步看是否撞到边） */
function findRectAt(rects: AsciiRect[], row: number, col: number): AsciiRect | null {
  for (const r of rects) {
    if (
      row >= r.row &&
      row <= r.row + r.height - 1 &&
      col >= r.col &&
      col <= r.col + r.width - 1
    ) {
      return r
    }
  }
  return null
}

/** 从 (row,col) 向给定方向追踪一条线段，返回端点 + 撞到的矩形（若有）。
 *  容忍中途的折点（拐角 / + / 任何 box-drawing junction）。 */
function trace(
  g: Grid,
  rects: AsciiRect[],
  startRow: number,
  startCol: number,
  drow: number,
  dcol: number,
  maxSteps = 200,
): { path: Array<[number, number]>; hitRect: AsciiRect | null } {
  const path: Array<[number, number]> = [[startCol, startRow]]
  let r = startRow
  let c = startCol
  let dr = drow
  let dc = dcol
  for (let step = 0; step < maxSteps; step++) {
    r += dr
    c += dc
    if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) break
    const ch = g.get(r, c)
    // 撞墙：到达某个矩形的边界 → 停
    const hit = findRectAt(rects, r, c)
    if (hit) {
      path.push([c, r])
      return { path, hitRect: hit }
    }
    // 折点：拐角 / + → 改变方向
    if (
      isCornerTL(ch) ||
      isCornerTR(ch) ||
      isCornerBL(ch) ||
      isCornerBR(ch)
    ) {
      path.push([c, r])
      // 尝试新方向（垂直 swap 水平）
      if (dr === 0) {
        // 当前水平：尝试上/下哪一边有线
        const above = g.get(r - 1, c)
        const below = g.get(r + 1, c)
        if (isOnVLine(above)) {
          dr = -1
          dc = 0
        } else if (isOnVLine(below)) {
          dr = 1
          dc = 0
        } else break
      } else {
        const left = g.get(r, c - 1)
        const right = g.get(r, c + 1)
        if (isOnHLine(left)) {
          dr = 0
          dc = -1
        } else if (isOnHLine(right)) {
          dr = 0
          dc = 1
        } else break
      }
      continue
    }
    // 普通线段字符
    if ((dr === 0 && isOnHLine(ch)) || (dc === 0 && isOnVLine(ch))) {
      path.push([c, r])
      continue
    }
    // 啥也不是 → 停
    break
  }
  return { path, hitRect: null }
}

function findEdges(g: Grid, rects: AsciiRect[]): AsciiEdge[] {
  const edges: AsciiEdge[] = []
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const ch = g.get(r, c)
      let direction: 'left' | 'right' | 'up' | 'down' | null = null
      if (ARROW_R.has(ch) || ch === '>') {
        // 单字符 '>' 只有在左侧紧邻水平线时才视为箭头（避免错把比较符当箭头）
        if (ch === '>' && !isOnHLine(g.get(r, c - 1))) continue
        direction = 'right'
      } else if (ARROW_L.has(ch) || ch === '<') {
        if (ch === '<' && !isOnHLine(g.get(r, c + 1))) continue
        direction = 'left'
      } else if (ARROW_U.has(ch) || ch === '^') {
        if (ch === '^' && !isOnVLine(g.get(r + 1, c))) continue
        direction = 'up'
      } else if (ARROW_D.has(ch) || ch === 'v') {
        if (ch === 'v' && !isOnVLine(g.get(r - 1, c))) continue
        direction = 'down'
      } else {
        continue
      }
      // 箭头落点在哪个矩形旁？
      let dstCol = c, dstRow = r
      let dstAdjCol = c, dstAdjRow = r
      switch (direction) {
        case 'right': dstAdjCol = c + 1; break
        case 'left':  dstAdjCol = c - 1; break
        case 'up':    dstAdjRow = r - 1; break
        case 'down':  dstAdjRow = r + 1; break
      }
      const dstRect = findRectAt(rects, dstAdjRow, dstAdjCol)
      if (!dstRect) continue
      // 从箭头逆向追踪 → 找源矩形
      let backDr = 0, backDc = 0
      switch (direction) {
        case 'right': backDc = -1; break
        case 'left':  backDc =  1; break
        case 'up':    backDr =  1; break
        case 'down':  backDr = -1; break
      }
      const t = trace(g, rects, r, c, backDr, backDc)
      if (!t.hitRect) continue
      // 路径：源 → 箭头（注意 trace 返回的是逆向，需要反转）
      const reversed: Array<[number, number]> = [...t.path].reverse()
      // 末尾补一个 dst 处的"落点"（箭头位置 + 一格）
      reversed.push([dstCol, dstRow])
      edges.push({
        fromId: t.hitRect.id,
        toId: dstRect.id,
        path: reversed,
        arrow: direction,
      })
    }
  }
  // 去重：同 from→to 同方向只保留一条（多条平行边时取第一条）
  const seen = new Set<string>()
  return edges.filter((e) => {
    const key = `${e.fromId}->${e.toId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ─────── 入口 ─────────────────────────────────────────────────────
/** 把 ASCII 文本解析为图。失败返回 null。 */
export function parseAsciiGraph(text: string): AsciiGraph | null {
  try {
    const g = new Grid(text)
    if (g.cols < 3 || g.rows < 3) return null
    const rects = findRects(g)
    if (rects.length === 0) return null
    const edges = findEdges(g, rects)
    // 健全性：边数不应离谱（防解析野化）
    if (edges.length > rects.length * 8 + 10) return null
    return { rects, edges, cols: g.cols, rows: g.rows }
  } catch {
    return null
  }
}
