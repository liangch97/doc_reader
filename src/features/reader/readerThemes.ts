/**
 * 平板端 7 套阅读主题 —— 唯一真相源（TABLET_DESIGN.md §4）
 *
 * 每个主题独立 bg / text / accent / 链接 / 选中色 / 分割线，保证在 foliate iframe
 * 内也能整套应用。批注高亮色按主题底色调过：
 *   - paper/cream/sepia/mist：维持鲜艳值
 *   - moss：饱和度 -15%
 *   - dusk/midnight：提亮 +20%，加 8% 不透明
 *
 * 平板 UI 用 `theme` 字段（见 `useReaderPrefs.ts`），桌面继续用旧 `colorScheme`。
 * `foliateThemes.ts` 优先读 `theme`，回退 `colorScheme`。
 */

export type ReaderThemeKey =
  | 'auto'
  | 'paper'
  | 'cream'
  | 'wheat'
  | 'sepia'
  | 'moss'
  | 'mist'
  | 'frost'
  | 'slate'
  | 'dusk'
  | 'midnight'
  | 'ink'

export interface ReaderTheme {
  /** stable id，写入 prefs */
  key: Exclude<ReaderThemeKey, 'auto'>
  /** UI 展示名 */
  label: string
  /** 主色调（按钮、链接、强调） */
  accent: string
  /** 阅读背景 */
  bg: string
  /** 正文文字 */
  fg: string
  /** 链接色 */
  link: string
  /** 选区底色 */
  selection: string
  /** 分割线 */
  divider: string
  /** 是否为暗色调（决定状态栏色 / 系统 UI 提示） */
  dark: boolean
}

export const READER_THEMES: Record<Exclude<ReaderThemeKey, 'auto'>, ReaderTheme> = {
  paper: {
    key: 'paper',
    label: '纸白',
    accent: '#7C5CFC',
    bg: '#FAFAF7',
    fg: '#1F1E1A',
    link: '#5A3FE0',
    selection: 'rgba(124,92,252,0.22)',
    divider: 'rgba(31,30,26,0.12)',
    dark: false,
  },
  cream: {
    key: 'cream',
    label: '米白',
    accent: '#CB8F39',
    bg: '#FDF6E3',
    fg: '#2D2A1F',
    link: '#A66E20',
    selection: 'rgba(203,143,57,0.25)',
    divider: 'rgba(45,42,31,0.14)',
    dark: false,
  },
  sepia: {
    key: 'sepia',
    label: '羊皮',
    accent: '#A0522D',
    bg: '#F2E7CC',
    fg: '#3B2F1F',
    link: '#7D5A3C',
    selection: 'rgba(160,82,45,0.25)',
    divider: 'rgba(59,47,31,0.16)',
    dark: false,
  },
  moss: {
    key: 'moss',
    label: '豆沙',
    accent: '#3E7A4E',
    bg: '#DCE7D8',
    fg: '#23301F',
    link: '#2C6238',
    selection: 'rgba(62,122,78,0.20)',
    divider: 'rgba(35,48,31,0.14)',
    dark: false,
  },
  mist: {
    key: 'mist',
    label: '雾灰',
    accent: '#5856D6',
    bg: '#D4D4D2',
    fg: '#1D1D1F',
    link: '#3F3DA8',
    selection: 'rgba(88,86,214,0.24)',
    divider: 'rgba(29,29,31,0.16)',
    dark: false,
  },
  dusk: {
    key: 'dusk',
    label: '暮色',
    accent: '#8B6DFF',
    bg: '#1F1F22',
    fg: '#D0CEC8',
    link: '#A98BFF',
    selection: 'rgba(139,109,255,0.30)',
    divider: 'rgba(208,206,200,0.16)',
    dark: true,
  },
  midnight: {
    key: 'midnight',
    label: '深夜',
    accent: '#A78BFA',
    bg: '#0C0C0F',
    fg: '#BEBDBA',
    link: '#C0A6FF',
    selection: 'rgba(167,139,250,0.28)',
    divider: 'rgba(190,189,186,0.14)',
    dark: true,
  },
  // ─── 业界主流补充主题（8 → 12 个）───
  // 麦黄：Kindle 经典暗黄，比 cream 更暖有油漆感，适合长时间阅读
  wheat: {
    key: 'wheat',
    label: '麦黄',
    accent: '#B86A2B',
    bg: '#F4E8CF',
    fg: '#3A2E1C',
    link: '#955420',
    selection: 'rgba(184,106,43,0.24)',
    divider: 'rgba(58,46,28,0.14)',
    dark: false,
  },
  // 冷雾：Apple Books Light 风格，蓝灰偏冷，不像 paper 那么纯白刷眼
  frost: {
    key: 'frost',
    label: '冷雾',
    accent: '#3D7DCC',
    bg: '#EAF1F8',
    fg: '#1A2330',
    link: '#1F5BA0',
    selection: 'rgba(61,125,204,0.22)',
    divider: 'rgba(26,35,48,0.14)',
    dark: false,
  },
  // 石板：中性灰调，介于 dusk 和 paper 之间，黄昏阅读不动脒眼
  slate: {
    key: 'slate',
    label: '石板',
    accent: '#7BA8E0',
    bg: '#3A3D42',
    fg: '#CFD2D6',
    link: '#A0C2F0',
    selection: 'rgba(123,168,224,0.28)',
    divider: 'rgba(207,210,214,0.14)',
    dark: true,
  },
  // 墨黑：OLED 友好纯黑，比 midnight 更岻但字色更柔和避免高对比刺眼
  ink: {
    key: 'ink',
    label: '墨黑',
    accent: '#7BD3FA',
    bg: '#000000',
    fg: '#A8A8A8',
    link: '#9BDDFB',
    selection: 'rgba(123,211,250,0.26)',
    divider: 'rgba(168,168,168,0.14)',
    dark: true,
  },
}

export const READER_THEME_LIST: ReaderTheme[] = [
  READER_THEMES.paper,
  READER_THEMES.cream,
  READER_THEMES.wheat,
  READER_THEMES.sepia,
  READER_THEMES.moss,
  READER_THEMES.mist,
  READER_THEMES.frost,
  READER_THEMES.slate,
  READER_THEMES.dusk,
  READER_THEMES.midnight,
  READER_THEMES.ink,
]

/**
 * 把 `theme` 字段解析成实际主题对象。
 *  - 'auto' 浅色系统 → paper
 *  - 'auto' 深色系统 → dusk（不用 midnight，避免 OLED 太黑突兀）
 *  - 其他值 → 对应主题
 *
 * 在 SSR / 测试环境中 `window` 不可用时按 light 走（paper）。
 */
export function resolveReaderTheme(key: ReaderThemeKey | undefined): ReaderTheme {
  const k = key ?? 'auto'
  if (k === 'auto') {
    const prefersDark =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
    return prefersDark ? READER_THEMES.dusk : READER_THEMES.paper
  }
  return READER_THEMES[k]
}

/**
 * 把老的 `colorScheme` 字段映射到新的 `theme` key（一次性迁移用）。
 * 映射规则见 TABLET_DESIGN.md §9。
 */
export function migrateColorSchemeToTheme(
  colorScheme: 'auto' | 'light' | 'dark' | 'sepia' | undefined
): ReaderThemeKey {
  switch (colorScheme) {
    case 'light':
      return 'paper'
    case 'dark':
      return 'dusk'
    case 'sepia':
      return 'sepia'
    case 'auto':
    default:
      return 'auto'
  }
}

/**
 * 把当前 ReaderTheme 写入根 `:root` CSS 变量，让整张屏幕（toolbar / sidebar /
 * 笔记区 / 设置弹窗 / 所有 .bg-bg 等 utility）跟着阅读底色走。
 *
 * 用户体验诉求："修改阅读背景颜色应该修改的是整张屏幕包括菜单的颜色"。
 *
 * 内部维护"原始值快照"，组件卸载（离开阅读路由）时调用 cleanup 把变量还原。
 * 多个组件挂载/卸载顺序无关 —— 任何时候最后一次 apply 决定当前值。
 *
 * 注：这里只覆盖最常被引用的几个语义 token；对 hl-*、shadow-* 等不做改动，
 * 由各组件自己的样式负责对比度。
 */
const TOKEN_KEYS = [
  '--bg',
  '--bg-solid',
  '--popover',
  '--popover-border',
  '--surface-1',
  '--surface-2',
  '--surface-3',
  '--border-1',
  '--text-1',
  '--text-2',
  '--text-3',
  '--accent',
] as const

let originalTokens: Record<string, string> | null = null

function snapshotOriginals() {
  if (originalTokens) return
  const cs = getComputedStyle(document.documentElement)
  const snap: Record<string, string> = {}
  for (const k of TOKEN_KEYS) snap[k] = cs.getPropertyValue(k).trim()
  originalTokens = snap
}

/** 把 hex（#RRGGBB / #RGB）按 alpha 转为 rgba(...) 字符串。alpha 为小数 0..1。 */
function hexWithAlpha(hex: string, alpha: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 把 hex 按主题亮暗微调一档（暗色 → 提亮 / 亮色 → 压暗），得到 popover/bg-solid。*/
function shadeHex(hex: string, amount: number): string {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const adj = (c: number) => {
    const next = c + amount
    return Math.max(0, Math.min(255, Math.round(next)))
  }
  const hh = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hh(adj(r))}${hh(adj(g))}${hh(adj(b))}`
}

/**
 * 把主题对象写入根 :root CSS 变量。
 *
 * 注意：**不返回 cleanup**（或返回 noop）—— 一旦设过主题色，整个应用就保持
 * 这套色板，离开阅读器进入笔记区/图书馆也不变。这正是用户要求的"修改阅读
 * 背景颜色应该修改整张屏幕包括菜单的颜色，笔记区也不能做色差"。
 *
 * 重新覆盖只需再次调用本函数；多次调用按最后一次的值生效。
 */
export function applyReaderThemeToRoot(theme: ReaderTheme): () => void {
  if (typeof document === 'undefined') return () => {}
  snapshotOriginals()
  const root = document.documentElement

  const dark = theme.dark
  // 暗色：往亮调一档做表面色；亮色：往暗调一档（"轻微抬"出层次）
  const surfaceShift = dark ? 14 : -8
  const popoverShift = dark ? 24 : -14

  root.style.setProperty('--bg', theme.bg)
  root.style.setProperty('--bg-solid', shadeHex(theme.bg, surfaceShift))
  root.style.setProperty('--popover', shadeHex(theme.bg, popoverShift))
  root.style.setProperty(
    '--popover-border',
    hexWithAlpha(theme.fg, dark ? 0.18 : 0.12)
  )
  root.style.setProperty('--surface-1', hexWithAlpha(theme.fg, dark ? 0.06 : 0.04))
  root.style.setProperty('--surface-2', hexWithAlpha(theme.fg, dark ? 0.10 : 0.07))
  root.style.setProperty('--surface-3', hexWithAlpha(theme.fg, dark ? 0.15 : 0.11))
  root.style.setProperty('--border-1', theme.divider)
  root.style.setProperty('--text-1', theme.fg)
  root.style.setProperty('--text-2', hexWithAlpha(theme.fg, 0.72))
  root.style.setProperty('--text-3', hexWithAlpha(theme.fg, 0.50))
  root.style.setProperty('--accent', theme.accent)

  // 兼容深浅 `data-theme` 选择器（部分组件用 :root[data-theme='light'] 走差异化）
  root.setAttribute('data-theme', dark ? 'dark' : 'light')

  // cleanup: noop — 离开阅读器后仍保持当前主题色，不还原
  return () => {}
}

/**
 * 应用启动早期调用一次：从 localStorage 读 reader_prefs.theme，把对应主题色
 * 写入根变量，让 App 第一帧就用上用户的阅读主题（不再有"先暗后亮"闪烁）。
 */
export function applyStoredReaderThemeOnBoot() {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem('doc-reader.reader-prefs')
    if (!raw) return
    const parsed = JSON.parse(raw) as { theme?: ReaderThemeKey }
    const t = resolveReaderTheme(parsed.theme)
    applyReaderThemeToRoot(t)
  } catch {
    /* ignore */
  }
}

