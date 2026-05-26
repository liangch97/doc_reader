/**
 * 平板端阅读字体懒加载器（TABLET_DESIGN.md §5）
 *
 * 设计要点：
 *   1. `<link rel="stylesheet" href="/fonts/fonts.css">` **首次需要时**才注入
 *      一次（idempotent），不在首屏拉。
 *   2. 按 font key 触发实际网络请求 —— 用 `document.fonts.load(family)` 主动
 *      预热，浏览器会去 fetch 对应 woff2；下次切回该字体不会再请求。
 *   3. 缺失文件不会 throw —— `document.fonts.load` 失败时静默回退到 fallback。
 *   4. `localStorage` 记忆已经"用过"的 key，下次首屏可以预热（暂未实现）。
 *
 * 不在这里硬编码字体目录路径——`fonts.css` 才是真相源，本模块只负责"触发加载"。
 */

import type { ReaderTheme } from '@/features/reader/readerThemes'

/**
 * 字体目录条目。`key` 写入 `ReaderPrefs.fontKey`，`family` 是 CSS 注入串
 * （含 fallback），`primary` 是 `document.fonts.load` 探测用的主字族名。
 *
 * `recommended` 是字体的推荐排版参数（TABLET_DESIGN.md §5.3）——首次切换到
 * 该字体且 `prefs.fontTouched === false` 时自动应用，否则尊重用户手调。
 */
export interface FontCatalogItem {
  key: string
  label: string
  /** 分组：用于 UI 展示（"中文优先"/"英文优先"/"系统"） */
  group: 'system' | 'cjk' | 'latin'
  /** 注入到阅读区的完整 font-family（含 fallback 链）。'system' 为空串。 */
  family: string
  /** 主字族名，用于 `document.fonts.load(\`16px "${primary}"\`)` */
  primary: string
  /** 推荐排版参数 */
  recommended: {
    fontScale: number
    lineHeight: number
    letterSpacing: number
  }
}

export const FONT_CATALOG: FontCatalogItem[] = [
  {
    key: 'system',
    label: '系统默认',
    group: 'system',
    family: '',
    primary: '',
    recommended: { fontScale: 1.0, lineHeight: 1.7, letterSpacing: 0 },
  },
  {
    key: 'source-serif',
    label: '思源宋体',
    group: 'cjk',
    family: `'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', 'SimSun', serif`,
    primary: 'Source Han Serif SC',
    recommended: { fontScale: 17 / 16, lineHeight: 1.75, letterSpacing: 0.01 },
  },
  {
    key: 'source-sans',
    label: '思源黑体',
    group: 'cjk',
    family: `'Source Han Sans SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif`,
    primary: 'Source Han Sans SC',
    recommended: { fontScale: 1.0, lineHeight: 1.7, letterSpacing: 0 },
  },
  {
    key: 'lxgw-wenkai',
    label: '霞鹜文楷',
    group: 'cjk',
    family: `'LXGW WenKai', 'Source Han Serif SC', 'STKaiti', '楷体', serif`,
    primary: 'LXGW WenKai',
    recommended: { fontScale: 18 / 16, lineHeight: 1.8, letterSpacing: 0.02 },
  },
  {
    key: 'lxgw-neo',
    label: '霞鹜新晰黑',
    group: 'cjk',
    family: `'LXGW Neo XiHei', 'Source Han Sans SC', 'PingFang SC', sans-serif`,
    primary: 'LXGW Neo XiHei',
    recommended: { fontScale: 1.0, lineHeight: 1.7, letterSpacing: 0 },
  },
  {
    key: 'inter',
    label: 'Inter',
    group: 'latin',
    family: `'Inter', -apple-system, 'Segoe UI', 'Source Han Sans SC', sans-serif`,
    primary: 'Inter',
    recommended: { fontScale: 1.0, lineHeight: 1.6, letterSpacing: -0.01 },
  },
  {
    key: 'crimson',
    label: 'Crimson',
    group: 'latin',
    family: `'Crimson Pro', Georgia, 'Source Han Serif SC', serif`,
    primary: 'Crimson Pro',
    recommended: { fontScale: 18 / 16, lineHeight: 1.7, letterSpacing: 0 },
  },
]

export function findFontByKey(key: string | undefined): FontCatalogItem {
  return FONT_CATALOG.find((f) => f.key === key) ?? FONT_CATALOG[0]
}

// ===== 内部状态 =====

/** fonts.css 是否已注入。注入只做一次，跨调用幂等。 */
let stylesheetInjected = false
/** 哪些 family 已经触发过 `document.fonts.load`。 */
const loadedFamilies = new Set<string>()

const LS_LOADED_KEY = 'doc-reader.fonts.loaded'

function readLoadedFromStorage(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(LS_LOADED_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch {
    /* ignore */
  }
  return new Set()
}

function persistLoaded() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LS_LOADED_KEY, JSON.stringify(Array.from(loadedFamilies)))
  } catch {
    /* ignore */
  }
}

/**
 * 把 `<link rel="stylesheet" href="/fonts/fonts.css">` 注入到 `<head>`。
 * 多次调用幂等。SSR / 无 document 环境直接 no-op。
 */
export function ensureFontStylesheet(): void {
  if (stylesheetInjected) return
  if (typeof document === 'undefined') return
  // 已存在（HMR / 多窗口） → 标记已注入即可
  if (document.querySelector('link[data-doc-reader-fonts]')) {
    stylesheetInjected = true
    return
  }
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/fonts/fonts.css'
  link.setAttribute('data-doc-reader-fonts', '1')
  document.head.appendChild(link)
  stylesheetInjected = true
  // 从 localStorage 恢复历史已加载集合
  readLoadedFromStorage().forEach((f) => loadedFamilies.add(f))
}

/**
 * 触发指定字体下载（如还没下过）。返回 Promise，解析为 true / false 表示是否
 * 成功就绪——失败时静默返回 false，不会 throw。
 *
 * 'system' 不做任何事，直接 true。
 */
export async function loadFont(key: string): Promise<boolean> {
  const item = findFontByKey(key)
  if (!item.primary) return true
  if (typeof document === 'undefined' || !document.fonts) return true

  ensureFontStylesheet()
  if (loadedFamilies.has(item.primary)) return true

  try {
    // 预热 16px 字号；浏览器会拉对应 woff2 并 swap 进 FontFaceSet
    await document.fonts.load(`16px "${item.primary}"`)
    loadedFamilies.add(item.primary)
    persistLoaded()
    return true
  } catch {
    return false
  }
}

/**
 * 已加载字体集合的不可变快照（UI 用来灰显未就绪项）。
 */
export function getLoadedFontKeys(): string[] {
  return FONT_CATALOG.filter((f) => !f.primary || loadedFamilies.has(f.primary)).map((f) => f.key)
}

// Re-export ReaderTheme for callers needing combined font + theme metadata —
// 占位，未来 P5 让批注高亮颜色读 theme 时用得上。
export type { ReaderTheme }
