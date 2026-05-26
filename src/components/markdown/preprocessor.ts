/**
 * Custom Markdown Preprocessor
 *
 * ⚠️ 关于定制围栏块（2026-05 废弃）
 * 以下 4 种后名语言的特殊渲染已被废弃、不再被识别：
 *   - ```flashcards``` (闪卡)
 *   - ```qa```         (问答)
 *   - ```mindmap```    (思维导图)
 *   - ```concept```    (概念图)
 *
 * 原因：
 *   - 在 Milkdown 编辑器里被包为 fence-card，渲染后表现为「双层嵌套」响不可用
 *   - 思维导图 / 概念图 的 CSS 伪元素连接线在实际内容下走形严重
 *   - 用户反馈：不如直接用「带编号的标准 Markdown」表达层次
 *
 * 处理策略：这些围栏现在一律走默认代码块（react-markdown / Milkdown 默认表现）。
 * AI prompt 也已同步调整，LLM 不再输出这些围栏。
 *
 * 留下的能力：
 *   - `==text==` 高亮（applyHighlight）
 *   - emoji → lucide 图标（emojiSubstitute）
 *   - 有序列表全局重新连续编号（renumberOrderedLists）—— 单个笔记内
 *     所有同级有序列表项按出现顺序重写为 `1. 2. 3. ...`，避免 AI 多次
 *     生成 / 补充时出现「两个 1.」、「跳号」、「重复」等问题。
 */
export function preprocessMarkdown(input: string): string {
  if (!input) return ''
  const renumbered = renumberOrderedLists(input)
  const withMark = applyHighlight(renumbered)
  return emojiSubstitute(withMark)
}

// ───────── Renumber ordered lists (single-note ordering) ─────────
/**
 * 重新编号 markdown 中的有序列表项，使整篇笔记内的编号连续有序。
 *
 * 规则：
 *   1. 跳过代码围栏（```...```）和缩进代码块（行首 4+ 空格 + 非列表项的内容）。
 *   2. 跳过 inline code（`...`）—— 但实际只在行首层面识别列表，行内 code 不会
 *      被识别为列表项，所以无需特殊处理。
 *   3. 按 **缩进深度** 区分嵌套层级。每个层级独立计数器；当某个层级"合上"
 *      （遇到更浅缩进或被空行 + 标题打断）时，该层级计数器复位。
 *   4. 同一层级"被空行打断"是否复位 —— 这是关键设计点：
 *      - 用户原话："单个笔记下编号有序" → **不复位**，跨段落继续累加
 *        这样即便 AI 补充了一段新的有序列表，整篇笔记看下来仍是 1, 2, 3, ..., n。
 *   5. 但被 **标题（`#`...）/ 引用块（`>`）/ 水平线（`---`）** 打断时复位 ——
 *      因为标题通常意味着"新章节"，编号应当从 1 重新开始。
 *
 * 不处理无序列表 `-` `*` `+`（它们没有可见编号）。
 */
export function renumberOrderedLists(input: string): string {
  const lines = input.split('\n')
  const out: string[] = []

  // 计数器栈：按缩进深度索引，每层一个 counter
  // counters[depth] = 该层下一项应该得到的编号（首项 = 1）
  const counters = new Map<number, number>()
  const reset = () => counters.clear()
  const resetDeeperThan = (depth: number) => {
    for (const k of Array.from(counters.keys())) {
      if (k > depth) counters.delete(k)
    }
  }

  let inFence = false // 在 ``` 围栏内
  let fenceMarker = '' // ``` 还是 ~~~

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 1) 围栏代码块：进入 / 退出
    const fenceMatch = /^(\s*)(```+|~~~+)/.exec(line)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fenceMarker = fenceMatch[2][0] // '`' 或 '~'
      } else if (fenceMatch[2][0] === fenceMarker) {
        inFence = false
      }
      out.push(line)
      // 围栏出入不复位列表计数器，因为列表可能跨过代码块继续
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    // 2) 标题 / 水平线 → 复位所有层级
    if (/^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      reset()
      out.push(line)
      continue
    }

    // 3) 引用块（> ...）: 引用块里的列表自成一体，处理较复杂；为简洁起见
    //    遇到引用块视为分割信号，复位所有层级，引用块内的列表保持原样。
    if (/^\s{0,3}>/.test(line)) {
      reset()
      out.push(line)
      continue
    }

    // 4) 有序列表项：`<indent>123. text` 或 `<indent>123) text`
    const olMatch = /^(\s*)(\d+)([.)])(\s+)(.*)$/.exec(line)
    if (olMatch) {
      const indent = olMatch[1]
      const sep = olMatch[3]
      const rest = olMatch[5]
      // 缩进深度：按 4-space / tab 一级换算（CommonMark 默认 4 空格 = 一级嵌套；
      // GFM 视具体宿主而定，这里取保守的"每 2 空格 = 一级"以兼容更多写法）
      const spacesCount = indent.replace(/\t/g, '  ').length
      const depth = Math.floor(spacesCount / 2)

      // 比当前深度更深的层级，全部复位（用户从二级回到一级，二级的 counter 应清掉）
      resetDeeperThan(depth)

      const next = (counters.get(depth) ?? 0) + 1
      counters.set(depth, next)

      // 用新的编号回写当行；保留原始的分隔符 `.` / `)` 和缩进
      out.push(`${indent}${next}${sep}${olMatch[4]}${rest}`)
      continue
    }

    // 5) 无序列表项：`<indent>- text` 或 `* text` 或 `+ text`
    //    这些不影响有序列表 counter（同级混排时，不同 marker 是不同列表）
    //    但出现无序列表项也不复位有序计数器 —— 用户在两段有序列表之间
    //    插一个无序段落不应中断编号。
    if (/^\s*[-*+]\s+/.test(line)) {
      out.push(line)
      continue
    }

    // 6) 空行：不复位（跨段落继续累加，这是核心设计）
    if (/^\s*$/.test(line)) {
      out.push(line)
      continue
    }

    // 7) 普通段落文字：不复位（同样允许"段落 + 段落"之间的有序列表续号）
    out.push(line)
  }

  return out.join('\n')
}

// `==text==` (Pandoc-style highlight) → `<mark>text</mark>`.
// Skip text inside inline code spans and fenced code so examples aren't mangled.
export function applyHighlight(input: string): string {
  // Pull out inline code spans first to protect them
  const codeSpans: string[] = []
  const protectedInput = input.replace(/`[^`\n]+`/g, (m) => {
    codeSpans.push(m)
    return `\u0000CODE${codeSpans.length - 1}\u0000`
  })
  const replaced = protectedInput.replace(/==([^=\n][^=\n]*?[^=\n]|[^=\n])==/g, (_, body: string) => {
    return `<mark>${body}</mark>`
  })
  return replaced.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSpans[Number(i)] ?? '')
}

// ───────── Flashcards (⚠️ DEPRECATED 2026-05) ─────────
// 函数留下仅为保留 API 兼容（milkdownFenceView 的 import 仍存在），
// 实际不再被调用。任何 ```flashcards``` 围栏都会走默认代码块渲染。
/** @deprecated 2026-05 —— 不再调用，仅保留函数导出以免破坏 import 。 */
export function renderFlashcards(body: string): string {
  const blocks = body.split(/^\s*---\s*$/m).map((b) => b.trim()).filter(Boolean)
  const cards = blocks.map((block) => {
    const front = /(?:正面|Front|Q)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:背面|Back|A)\s*[:：]|$)/i.exec(block)
    const back = /(?:背面|Back|A)\s*[:：]\s*([\s\S]*)/i.exec(block)
    return {
      front: (front?.[1] || block).trim(),
      back: (back?.[1] || '').trim(),
    }
  })
  if (cards.length === 0) return ''
  const items = cards
    .map(
      (c, i) => `<details class="md-fc">
  <summary class="md-fc-summary">
    <span class="md-fc-no">${i + 1}<span class="md-fc-total">/${cards.length}</span></span>
    <span class="md-fc-front">${inlineMdMulti(c.front)}</span>
    <span class="md-fc-hint" aria-hidden="true">点击查看答案</span>
  </summary>
  <div class="md-fc-back">${inlineMdMulti(c.back)}</div>
</details>`
    )
    .join('\n')
  return `\n<div class="md-flashcards">
  <div class="md-block-head">
    <span class="md-block-label">闪卡</span>
    <span class="md-block-meta">${cards.length} 张</span>
  </div>
  <div class="md-fc-grid">
${items}
  </div>
</div>\n`
}

// ───────── Q&A (⚠️ DEPRECATED 2026-05) ─────────
/** @deprecated 2026-05 */
export function renderQA(body: string): string {
  const pairs: { q: string; a: string }[] = []
  const re = /(?:问|Q)\s*[:：]\s*([\s\S]*?)\n\s*(?:答|A)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:问|Q)\s*[:：]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    pairs.push({ q: m[1].trim(), a: m[2].trim() })
  }
  if (pairs.length === 0) return ''
  const items = pairs
    .map(
      (p, i) => `<details class="md-qa-item">
  <summary class="md-qa-q">
    <span class="md-qa-no">${i + 1}</span>
    <span class="md-qa-q-text">${inlineMdMulti(p.q)}</span>
  </summary>
  <div class="md-qa-a">${inlineMdMulti(p.a)}</div>
</details>`
    )
    .join('\n')
  return `\n<div class="md-qa-list">
  <div class="md-block-head">
    <span class="md-block-label">问答</span>
    <span class="md-block-meta">${pairs.length} 题</span>
  </div>
${items}
</div>\n`
}

// ───────── Mindmap (⚠️ DEPRECATED 2026-05) ─────────
/** @deprecated 2026-05 */
export function renderMindmap(body: string): string {
  const lines = body.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return ''
  type Node = { text: string; depth: number; children: Node[] }
  const root: Node = { text: '', depth: -1, children: [] }
  const stack: Node[] = [root]
  for (const ln of lines) {
    const m = /^(\s*)(?:[-*]\s*)?(.+)$/.exec(ln)
    if (!m) continue
    const depth = Math.floor(m[1].length / 2)
    const text = m[2].trim()
    const node: Node = { text, depth, children: [] }
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop()
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  const top = root.children
  if (top.length === 0) return ''
  // 顶级第一项 = 根；其他顶级项作为根的同级子项被合并
  const rootText = top[0].text
  const branches = top[0].children.length > 0 ? top[0].children : top.slice(1)

  const renderTree = (nodes: Node[]): string => {
    if (nodes.length === 0) return ''
    const items = nodes
      .map((n) => {
        const tier = Math.min(Math.max(n.depth, 1), 4)
        const kids = n.children.length > 0 ? renderTree(n.children) : ''
        return `<li class="md-mm-li"><span class="md-mm-node md-mm-d${tier}">${inlineMd(n.text)}</span>${kids}</li>`
      })
      .join('')
    return `<ul class="md-mm-children">${items}</ul>`
  }

  return `\n<figure class="md-mindmap">
  <figcaption class="md-block-head">
    <span class="md-block-label">思维导图</span>
  </figcaption>
  <div class="md-mm-body">
    <div class="md-mm-root">${inlineMd(rootText)}</div>
    ${renderTree(branches)}
  </div>
</figure>\n`
}

// ───────── Concept Map (⚠️ DEPRECATED 2026-05) ─────────
/** @deprecated 2026-05 */
export function renderConceptMap(body: string): string {
  const edges: { from: string; rel: string; to: string }[] = []
  const re = /^([^-\n][^\n]*?)\s*-+\s*(?:\[([^\]]*)\])?\s*-*>\s*(.+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    edges.push({ from: m[1].trim(), rel: (m[2] || '').trim(), to: m[3].trim() })
  }
  if (edges.length === 0) return body
  // 按 from 分组，保持首次出现顺序
  const groupOrder: string[] = []
  const groups = new Map<string, { rel: string; to: string }[]>()
  for (const e of edges) {
    if (!groups.has(e.from)) {
      groups.set(e.from, [])
      groupOrder.push(e.from)
    }
    groups.get(e.from)!.push({ rel: e.rel, to: e.to })
  }
  const uniqueNodes = new Set<string>()
  edges.forEach((e) => {
    uniqueNodes.add(e.from)
    uniqueNodes.add(e.to)
  })
  const arrowSvg =
    '<svg class="md-cm-arrow" viewBox="0 0 18 8" aria-hidden="true"><path d="M0 4 L14 4 M10 1 L14 4 L10 7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'

  const groupsHtml = groupOrder
    .map((from) => {
      const outs = groups.get(from)!
      const edgesHtml = outs
        .map(
          (o) => `<li class="md-cm-edge">
            <span class="md-cm-rel">${o.rel ? inlineMd(o.rel) : '关联'}</span>
            ${arrowSvg}
            <span class="md-cm-target">${inlineMd(o.to)}</span>
          </li>`
        )
        .join('')
      return `<div class="md-cm-group">
        <div class="md-cm-source">${inlineMd(from)}</div>
        <ul class="md-cm-out">${edgesHtml}</ul>
      </div>`
    })
    .join('')

  return `\n<figure class="md-conceptmap">
  <figcaption class="md-block-head">
    <span class="md-block-label">概念关系</span>
    <span class="md-block-meta">${uniqueNodes.size} 概念 · ${edges.length} 关系</span>
  </figcaption>
  <div class="md-cm-body">${groupsHtml}</div>
</figure>\n`
}

// ───────── helpers ─────────
function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 轻量 inline markdown 转 HTML。只负责「卡片内联」级别表达，不处理块级（标题 / 列表）。
 *  - **粗体**、*斜体*、`code`、==高亮==、[text](url)
 *  - 其他一律当作纯文本 escape
 * 这样 AI 在闪卡/问答/节点里写的粗体/代码/高亮也能被渲染出来。 */
export function inlineMd(s: string): string {
  let t = escape(s)
  // 先处理 代码 —— 避免其他 markdown 符号反射进代码中
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  // **粗体**
  t = t.replace(/\*\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*\*/g, '<strong>$1</strong>')
  // *斜体*（不干扰单独的 *）
  t = t.replace(/(^|[^*\w])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
  // ==高亮==
  t = t.replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
  // [text](url)
  t = t.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  )
  return t
}

/** 多行版本：附加 \n -> <br/> 处理，用于闪卡背面 / 问答答案这些可多行的区域。 */
function inlineMdMulti(s: string): string {
  return inlineMd(s).replace(/\n/g, '<br/>')
}

// ───────── Emoji → Lucide icons ─────────
// Replace common emojis with <span data-icon="NAME"> tokens. MarkdownView's
// ReactMarkdown `components.span` override swaps these for lucide-react icons.
const EMOJI_MAP: Record<string, string> = {
  '📝': 'pencil',
  '✏️': 'pencil',
  '✏': 'pencil',
  '✅': 'check-circle-2',
  '☑️': 'check-square-2',
  '✔️': 'check',
  '❌': 'x-circle',
  '❎': 'x-square',
  '⚠️': 'alert-triangle',
  '⚠': 'alert-triangle',
  '💡': 'lightbulb',
  '📌': 'pin',
  '📍': 'map-pin',
  '🎯': 'target',
  '🔑': 'key',
  '🔒': 'lock',
  '🔓': 'unlock',
  '📚': 'book-open',
  '📖': 'book-open',
  '📓': 'notebook',
  '📔': 'notebook-pen',
  '📒': 'notebook-text',
  '📋': 'clipboard',
  '📁': 'folder',
  '📂': 'folder-open',
  '🗂️': 'folders',
  '📅': 'calendar',
  '📆': 'calendar-days',
  '⏰': 'alarm-clock',
  '⏱️': 'timer',
  '🕐': 'clock',
  '🔔': 'bell',
  '🔕': 'bell-off',
  '⭐': 'star',
  '🌟': 'sparkles',
  '✨': 'sparkles',
  '🔥': 'flame',
  '💯': 'badge-check',
  '👍': 'thumbs-up',
  '👎': 'thumbs-down',
  '❤️': 'heart',
  '💔': 'heart-crack',
  '🚀': 'rocket',
  '🎉': 'party-popper',
  '📊': 'bar-chart-3',
  '📈': 'trending-up',
  '📉': 'trending-down',
  '🔍': 'search',
  '🔎': 'search',
  '🌐': 'globe',
  '🔗': 'link',
  '⚙️': 'settings',
  '🛠️': 'wrench',
  '🔧': 'wrench',
  '🧰': 'briefcase',
  '💻': 'laptop',
  '🖥️': 'monitor',
  '📱': 'smartphone',
  '💬': 'message-circle',
  '💭': 'message-square',
  '📧': 'mail',
  '📨': 'mail-open',
  '📥': 'inbox',
  '📤': 'send',
  'ℹ️': 'info',
  '❓': 'help-circle',
  '❔': 'help-circle',
  '❗': 'alert-circle',
  '❕': 'alert-circle',
  '⏳': 'hourglass',
  '⌛': 'hourglass',
  '🏆': 'trophy',
  '🥇': 'medal',
  '🎓': 'graduation-cap',
  '🎨': 'palette',
  '📷': 'camera',
  '🎵': 'music',
  '🎬': 'film',
  '🗺️': 'map',
  '🧠': 'brain',
  '💎': 'gem',
  '🌱': 'sprout',
  '🌳': 'trees',
  '🌍': 'earth',
  '☀️': 'sun',
  '🌙': 'moon',
  '☁️': 'cloud',
  '⚡': 'zap',
  '🌈': 'rainbow',
}

function iconHtml(name: string): string {
  return `<span class="md-icon" data-icon="${name}"></span>`
}

export function emojiSubstitute(s: string): string {
  let out = s
  for (const [k, v] of Object.entries(EMOJI_MAP)) {
    if (out.includes(k)) out = out.split(k).join(iconHtml(v))
  }
  return out
}
