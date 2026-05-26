import { useEffect, useState, useCallback, useRef } from 'react'
import { invoke } from '@/lib/tauri'
import {
  migrateColorSchemeToTheme,
  type ReaderThemeKey,
} from './readerThemes'

export interface ReaderPrefs {
  /** 翻页模式：分页 / 滚动连续 */
  flow: 'paginated' | 'scrolled'
  /** 最大列数：1 单页 / 2 双页 */
  maxColumnCount: 1 | 2
  /** 左右页边距（像素） */
  margin: number
  /** 列间距百分比 */
  gap: number
  /** 右侧面板宽度（像素） */
  rightPaneWidth: number
  /** 左侧 TOC 面板宽度（像素） */
  leftPaneWidth: number
  /**
   * 沉浸式阅读：默认开启。
   * - 进入阅读器时左右栏自动收起；工具栏 ~3s 不动后淡出，鼠标移到顶部时回显。
   * - 用户可通过工具栏按钮一键切换。
   */
  immersive: boolean

  // ========== 排版细化（B1，readest 风格）==========
  /** 字号缩放倍数（1.0 = 100%，范围 0.7 - 1.6） */
  fontScale: number
  /** 行高（倍率，1.0 - 2.4） */
  lineHeight: number
  /** 字间距（em，-0.05 - 0.20） */
  letterSpacing: number
  /** 段落间距（em，0 - 2.0） */
  paragraphSpacing: number
  /** 首行缩进（em，0 - 4，中文常用 2） */
  textIndent: number
  /** 是否两端对齐（false 时左对齐） */
  justify: boolean
  /**
   * 是否覆盖书本自带字体。
   * - true：强制用 mdTheme 选定的字体族（!important）
   * - false：mdTheme 字体仅作为 fallback，让 epub 内 author CSS 优先
   */
  overrideFont: boolean

  // ========== 翻页交互（C1）==========
  /**
   * 点击阅读区翻页。
   * - true：左 35% → 上一页；右 35% → 下一页；中央 30% → 切换工具栏可见
   * - false：点击不翻页（保留旧行为，靠键盘 / 滚轮 / 工具栏按钮）
   * 选中文本 / 点击链接（脚注） 时不会触发翻页。
   */
  tapNavigation: boolean

  // ========== 颜色主题（B2，readest 同款三族）==========
  /**
   * 阅读区配色方案。
   * - 'auto' : 跟随系统亮/暗
   * - 'light': 强制亮色（白底黑字）
   * - 'dark' : 强制暗色（深底浅字）
   * - 'sepia': 米黄护眼（#f5ecd9 / #5b4636）
   * 只影响 foliate iframe 内的 background-color / color；不影响壳。
   */
  colorScheme: 'auto' | 'light' | 'dark' | 'sepia'

  // ========== 字体（B3）==========
  /**
   * body 正文字体族。
   * - 'system'：用 mdTheme 自带的字体（不覆盖）
   * - 其他值是预设 family 字符串（已含中英文 fallback）
   * 仅当 prefs.overrideFont === true 时才注入到 body 上。
   */
  bodyFontFamily: string

  // ========== 固定布局（C3，PDF 等）==========
  /** PDF / fixed-layout 缩放：'fit-width' / 'fit-page' / 数字百分比 */
  fixedZoom: 'fit-width' | 'fit-page' | number
  /** PDF / fixed-layout 跨页：'none' 单页 / 'auto' 双页 */
  fixedSpread: 'none' | 'auto'

  // ========== 平板主题（TABLET_DESIGN.md §4） ==========
  /**
   * 平板阅读主题。桌面不走该字段，仍走 colorScheme。
   * - 'auto'：跟随系统（浅则 paper，深则 dusk）
   * - 'paper' | 'cream' | 'sepia' | 'moss' | 'mist' | 'dusk' | 'midnight'
   *
   * 迁移策略（一次性）：初始加载 prefs 时若 `theme` 为 undefined，根据
   * 旧 `colorScheme` 推出合理默认，错开与桌面 colorScheme 独立。
   */
  theme: ReaderThemeKey

  /** 字体 key（P3 阶段 vendor）。默认 'system'。 */
  fontKey: string

  /**
   * 用户是否手调过 fontScale / lineHeight —— 字体切换时是否自动应用推荐参数。
   * 初始 false，一旦用户调动过字号/行距就设 true。
   */
  fontTouched: boolean
}

const DEFAULTS: ReaderPrefs = {
  flow: 'paginated',
  maxColumnCount: 1,
  margin: 48,
  gap: 7,
  rightPaneWidth: 260,
  leftPaneWidth: 220,
  immersive: true,
  fontScale: 1.0,
  lineHeight: 1.7,
  letterSpacing: 0,
  paragraphSpacing: 0.4,
  textIndent: 0,
  justify: false,
  overrideFont: false,
  tapNavigation: true,
  colorScheme: 'auto',
  bodyFontFamily: 'system',
  fixedZoom: 'fit-width',
  fixedSpread: 'none',
  theme: 'auto',
  fontKey: 'system',
  fontTouched: false,
}

// 后端 KV 键名（写入 app_prefs.json）
const KEY = 'reader_prefs'
// 本地缓存键 — 避免首屏闪烁
const LS_KEY = 'doc-reader.reader-prefs'

/**
 * 一次性迁移：v1 时 rightPaneWidth=288 / leftPaneWidth=240，对默认窗口偏宽。
 * v2 把默认值改成 260 / 220；如果用户从未改过（== 旧默认），就替换为新默认。
 * 只识别"等于旧默认"以尊重已经手动拖过的用户。
 *
 * v3（平板重构）：补上 `theme` / `fontKey` / `fontTouched` 三个新字段。
 *  - 旧记录里 `theme` 为 undefined 时，根据 `colorScheme` 推出，不动 colorScheme 本身
 *    （桌面 UI 仍依赖它）。
 */
function migratePrefs(p: ReaderPrefs): ReaderPrefs {
  const next = { ...p }
  if (next.rightPaneWidth === 288) next.rightPaneWidth = 260
  if (next.leftPaneWidth === 240) next.leftPaneWidth = 220
  // v3 新字段补齐
  if (typeof (next as Partial<ReaderPrefs>).theme === 'undefined') {
    next.theme = migrateColorSchemeToTheme(next.colorScheme)
  }
  if (typeof (next as Partial<ReaderPrefs>).fontKey === 'undefined') {
    next.fontKey = 'system'
  }
  if (typeof (next as Partial<ReaderPrefs>).fontTouched === 'undefined') {
    next.fontTouched = false
  }
  return next
}

function loadCache(): ReaderPrefs {
  try {
    const v = localStorage.getItem(LS_KEY)
    if (v) return migratePrefs({ ...DEFAULTS, ...JSON.parse(v) })
  } catch {
    /* ignore */
  }
  return DEFAULTS
}

function saveCache(p: ReaderPrefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

export function useReaderPrefs() {
  const [prefs, setPrefsState] = useState<ReaderPrefs>(() => loadCache())
  const saveTimerRef = useRef<number | null>(null)

  // 启动时从 Tauri 后端拉取
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const v = await invoke<ReaderPrefs | null>('app_prefs_get', { key: KEY })
        if (cancelled) return
        if (v && typeof v === 'object') {
          const merged = migratePrefs({ ...DEFAULTS, ...v })
          setPrefsState(merged)
          saveCache(merged)
        }
      } catch {
        /* 后端不可用 → 退化为本地缓存 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setPrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...patch }
      saveCache(next)
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        invoke('app_prefs_set', { key: KEY, value: next }).catch(() => {
          /* 后端写入失败不影响本地体验 */
        })
      }, 250)
      return next
    })
  }, [])

  // 多窗口同步
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY) setPrefsState(loadCache())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return { prefs, setPrefs }
}
