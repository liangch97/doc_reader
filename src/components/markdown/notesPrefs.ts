/**
 * 笔记 / 笔记本 Markdown 编辑区的字号 / 行距 / 字体偏好。
 *
 * 灵感来源：阅读器的 `useReaderPrefs` —— 用户希望"书籍阅读"和"笔记编辑"
 * 都能调整字号 / 行距 / 字体。但笔记区不需要后端持久化（写量不大、跨设备
 * 体验不是核心需求），所以这里只用 localStorage，避免引入新的后端 KV。
 *
 * 应用方式：在笔记区根节点（`<article class="md-root md-theme-XXX">`）上
 * 通过 `notesPrefsToStyle()` 拼出 inline style：
 *   - `--notes-font-size`、`--notes-line-height`、`--notes-letter-spacing`、
 *     `--notes-font-family` 注入到 CSS 变量
 *   - markdown.css 里 `.milkdown` / `.md-root` 用 `var(--notes-font-size, 16px)`
 *     等 fallback 形式消费这些变量；未设置时退回原默认。
 */

export type NotesFontFamily =
  | 'system' // Inter + 苹方 / 雅黑（与默认 .md-theme-default 同款）
  | 'sans' // 通用无衬线
  | 'serif' // 衬线（学术风）
  | 'mono' // 等宽（代码主导内容）

export interface NotesPrefs {
  /** 正文字号（px，12-22） */
  fontSize: number
  /** 行高（倍率，1.3-2.6） */
  lineHeight: number
  /** 字间距（em，0-0.10） */
  letterSpacing: number
  /** 字体族选择 */
  fontFamily: NotesFontFamily
}

export const NOTES_PREFS_DEFAULT: NotesPrefs = {
  fontSize: 16,
  lineHeight: 1.85,
  letterSpacing: 0,
  fontFamily: 'system',
}

const LS_KEY = 'doc-reader.notes-prefs'

export function loadNotesPrefs(): NotesPrefs {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v) {
      const parsed = JSON.parse(v) as Partial<NotesPrefs>
      return { ...NOTES_PREFS_DEFAULT, ...parsed }
    }
  } catch {
    /* ignore */
  }
  return NOTES_PREFS_DEFAULT
}

export function saveNotesPrefs(p: NotesPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

const FAMILY_STACK: Record<NotesFontFamily, string> = {
  system:
    "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
  sans:
    "'Inter', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  serif:
    "'Source Serif 4', 'Source Serif Pro', 'Source Han Serif SC', 'Noto Serif SC', Georgia, serif",
  mono: "'JetBrains Mono', 'Fira Code', Consolas, Menlo, monospace",
}

/** 把 prefs 转成应用到笔记根节点的 CSS 变量 inline style */
export function notesPrefsToStyle(p: NotesPrefs): React.CSSProperties {
  return {
    // 这些变量被 markdown.css 的 .milkdown / .md-root / .ProseMirror 规则消费
    ['--notes-font-size' as string]: `${p.fontSize}px`,
    ['--notes-line-height' as string]: `${p.lineHeight}`,
    ['--notes-letter-spacing' as string]: `${p.letterSpacing}em`,
    ['--notes-font-family' as string]: FAMILY_STACK[p.fontFamily],
  } as React.CSSProperties
}
