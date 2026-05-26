import type { MdTheme } from '@/components/markdown/MarkdownView'
import type { ReaderPrefs } from './useReaderPrefs'
import { resolveReaderTheme } from './readerThemes'
import { findFontByKey } from '@/lib/fontLoader'

/**
 * 把 MdTheme 翻译为可注入到 foliate 渲染文档（iframe / shadow doc）里的 CSS。
 * foliate paginator.setStyles(css) 会把这段 CSS 注入到每个章节文档中。
 *
 * 只覆盖排版（字体、行高、对齐、引用、代码、首行缩进），不动颜色变量
 * （颜色由 foliate 自己依据系统主题处理），保证深浅色都可读。
 *
 * `prefs` 提供时会在主题 CSS 之后追加「排版覆盖层」（B1，readest 风格）：
 *   字号缩放 / 行高 / 字间距 / 段间距 / 首行缩进 / 两端对齐 / 字体覆盖
 * 这些都用 `!important` 压过 author CSS 与 theme 模板，是 reader 用户偏好的最高优先级。
 */
export function buildFoliateThemeCSS(theme: MdTheme, prefs?: ReaderPrefs): string {
  return buildThemeBase(theme) + buildPrefsOverride(prefs)
}

function buildThemeBase(theme: MdTheme): string {
  const base = `
    html, body { margin: 0; }
    body {
      font-size: 1em;
      line-height: 1.7;
      word-wrap: break-word;
    }
    img { max-width: 100%; height: auto; }
    code { font-family: 'JetBrains Mono', Consolas, Menlo, monospace; }
    pre  { overflow-x: auto; padding: 0.8em 1em; }
    blockquote { padding: 0.4em 1em; }
  `

  switch (theme) {
    case 'github':
      return `${base}
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.65; }
        h1, h2 { padding-bottom: 0.3em; border-bottom: 1px solid currentColor; opacity: .98; }
      `
    case 'academic':
      return `${base}
        body {
          font-family: 'Source Serif Pro', 'Noto Serif SC', Georgia, 'Times New Roman', serif;
          line-height: 1.85;
          text-align: justify;
          hyphens: auto;
        }
        p { text-indent: 2em; margin: 0.4em 0; }
        h1 { text-align: center; }
        blockquote { font-style: italic; border-left: 2px solid currentColor; }
        blockquote p { text-indent: 0; }
      `
    case 'typora':
      return `${base}
        body { font-family: 'Inter', 'PingFang SC', sans-serif; line-height: 1.8; letter-spacing: 0.01em; }
        h1, h2, h3 { letter-spacing: -0.005em; }
        p { margin: 0.9em 0; }
      `
    case 'heti':
      return `${base}
        body {
          font-family: 'Source Han Serif SC', 'Noto Serif SC', '宋体', Georgia, serif;
          line-height: 1.95;
          text-align: justify;
          letter-spacing: 0.02em;
        }
        p { text-indent: 2em; margin: 0.5em 0; }
        h1, h2, h3 {
          font-family: 'Source Han Sans SC', 'Noto Sans SC', 'PingFang SC', sans-serif;
          text-align: center;
          letter-spacing: 0.05em;
        }
      `
    case 'notion':
      return `${base}
        body { font-family: 'Inter', 'PingFang SC', sans-serif; line-height: 1.7; }
        h1 { font-size: 1.875em; font-weight: 700; }
        h2 { font-size: 1.5em; }
        blockquote { border-left: 4px solid currentColor; opacity: .85; border-radius: 6px; }
      `
    case 'obsidian':
      return `${base}
        body { font-family: 'Inter', 'Noto Sans SC', sans-serif; line-height: 1.75; }
        h1::before { content: '# '; opacity: 0.4; }
        h2::before { content: '## '; opacity: 0.4; }
        h3::before { content: '### '; opacity: 0.4; }
      `
    case 'newspaper':
      return `${base}
        body {
          font-family: 'Source Serif Pro', 'Noto Serif SC', Georgia, serif;
          line-height: 1.7;
          text-align: justify;
          hyphens: auto;
        }
        h1 {
          font-size: 2.4em;
          font-weight: 800;
          text-align: center;
          letter-spacing: -0.01em;
          border-top: 3px double currentColor;
          border-bottom: 3px double currentColor;
          padding: 0.4em 0;
        }
        h2 { text-align: center; font-style: italic; }
        p:first-of-type::first-letter,
        h1 + p::first-letter,
        h2 + p::first-letter {
          float: left;
          font-size: 3.4em;
          line-height: 0.9;
          font-weight: 700;
          margin: 0.05em 0.1em 0 0;
        }
      `
    case 'mono':
      return `${base}
        body {
          font-family: 'JetBrains Mono', Consolas, monospace;
          font-size: 0.92em;
          line-height: 1.6;
        }
        h1, h2, h3 { font-family: inherit; }
        h1::before { content: '╔═══ '; opacity: .5; }
        h1::after  { content: ' ═══╗'; opacity: .5; }
        h2::before { content: '── '; opacity: .5; }
        h2::after  { content: ' ──'; opacity: .5; }
        h3::before { content: '> '; opacity: .6; }
        ul li::marker { content: '▸ '; }
      `
    case 'handwriting':
      return `${base}
        body {
          font-family: 'Caveat', 'Patrick Hand', '楷体', 'Kaiti SC', cursive;
          font-size: 1.1em;
          line-height: 1.85;
        }
        h1, h2, h3 { font-family: inherit; }
      `
    case 'minimal':
      return `${base}
        body {
          font-family: 'Inter', 'PingFang SC', sans-serif;
          line-height: 1.9;
          max-width: 65ch;
          margin: 0 auto;
          padding: 0 1em;
        }
        h1, h2, h3 { font-weight: 300; letter-spacing: -0.01em; }
        h1 { font-size: 2em; }
        blockquote { border: 0; font-style: italic; text-align: center; padding: 0.5em 2em; }
        hr { border: 0; text-align: center; margin: 2.5em 0; }
        hr::before { content: '· · ·'; letter-spacing: 0.5em; opacity: .6; }
      `
    case 'default':
    default:
      return `${base}
        body { font-family: 'Inter', 'PingFang SC', sans-serif; }
      `
  }
}

/**
 * 用户排版偏好覆盖层（!important）。空字符串表示「不覆盖该项，沿用主题/作者 CSS」。
 *
 * 注意优先级：foliate `setStyles` 注入的 CSS 拥有 author-level 优先级；要稳压 epub
 * 自带的 `style="..."` inline 样式，必须用 `!important`。这是 readest 同款做法。
 */
/**
 * 预设字体族（B3）。
 * Key 是 stable id，value 是含中英文 fallback 的 CSS font-family 字符串。
 * 'system' 是哨兵值，表示「不覆盖，沿用 mdTheme 的字体」。
 */
export const FONT_FAMILIES: Array<{ id: string; label: string; family: string }> = [
  { id: 'system', label: '系统默认', family: '' },
  {
    id: 'serif-sc',
    label: '中文衬线',
    family: `'Source Han Serif SC', 'Noto Serif SC', 'Source Han Serif CN', '宋体', SimSun, Georgia, serif`,
  },
  {
    id: 'sans-sc',
    label: '中文黑体',
    family: `'Source Han Sans SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'Heiti SC', sans-serif`,
  },
  {
    id: 'kaiti',
    label: '楷体',
    family: `'KaiTi', 'STKaiti', '楷体', 'Kaiti SC', 'Source Han Serif SC', serif`,
  },
  {
    id: 'fangsong',
    label: '仿宋',
    family: `'FangSong', 'STFangsong', '仿宋', 'Songti SC', serif`,
  },
  {
    id: 'serif-en',
    label: '英文衬线',
    family: `'Source Serif Pro', Georgia, 'Times New Roman', 'Noto Serif SC', serif`,
  },
  {
    id: 'sans-en',
    label: '英文无衬线',
    family: `'Inter', -apple-system, 'Segoe UI', 'Helvetica Neue', 'Noto Sans SC', sans-serif`,
  },
  {
    id: 'mono',
    label: '等宽',
    family: `'JetBrains Mono', 'SF Mono', Consolas, Menlo, monospace`,
  },
]

/**
 * 颜色主题（B2，readest 同款三族）。
 * 'auto' 由 base 主题决定（即原本"颜色由系统控制"的行为）。
 */
const COLOR_SCHEMES: Record<string, { bg: string; fg: string }> = {
  light: { bg: '#ffffff', fg: '#1f2328' },
  dark: { bg: '#0d1117', fg: '#e6edf3' },
  sepia: { bg: '#f5ecd9', fg: '#5b4636' },
}

function buildPrefsOverride(prefs?: ReaderPrefs): string {
  if (!prefs) return ''
  const fontScale = prefs.fontScale
  const lh = prefs.lineHeight
  const ls = prefs.letterSpacing
  const ps = prefs.paragraphSpacing
  const ti = prefs.textIndent
  const justify = prefs.justify ? 'justify' : 'left'
  // overrideFont = false 时 font-family 不写覆盖，author CSS 与 theme 字体（已在 base 主题里设）保留
  // overrideFont = true 时把 body font-family 强制为「与 theme 一致 + inherit」
  // 由于 theme 已经设过 body font-family，这里仅在 true 时附加 !important
  // 字号缩放策略（readest 同款）：
  //   ① html 根字号用 %  → 让所有 em/rem 单位整体跟随
  //   ② 把所有元素的 font-size 强制改回 1em（相对父级），抹掉作者 CSS 里写死的 px/具体 em，
  //      让缩放真正生效；同时通过 :where(...) 把选择器特异度降到 0，避免压掉
  //      base 主题里 h1/h2 的尺寸层级（理论 layer 应使用 @layer，但 foliate 注入的 CSS
  //      用 :where 是兼容性最好的等效手段）。
  //   ③ 例外：h1-h6 不强制 1em，让它们保留主题/作者定义的相对尺寸（h1 通常 2em 等）。
  const fontPercent = Math.round(fontScale * 100)

  // B2 颜色主题：
  //  - 平板新字段 `theme` 优先（'auto' 时回退到 colorScheme；非 'auto' 时使用 readerThemes.ts 的真相源）
  //  - 桌面无 `theme` 字段或为 'auto' 时仍走老 `colorScheme` 三档（light/dark/sepia），保持桌面零回归
  let colorCSS = ''
  const tabletTheme =
    prefs.theme && prefs.theme !== 'auto' ? resolveReaderTheme(prefs.theme) : null
  if (tabletTheme) {
    colorCSS = `
    html, body {
      background-color: ${tabletTheme.bg} !important;
      color: ${tabletTheme.fg} !important;
    }
    body, p, li, blockquote, span, div, h1, h2, h3, h4, h5, h6, td, th {
      color: inherit !important;
    }
    a { color: ${tabletTheme.link} !important; }
    ::selection { background-color: ${tabletTheme.selection}; }
    hr { border-color: ${tabletTheme.divider} !important; }
    `
  } else {
    // 'auto' 不输出，让 base / 系统决定
    const cs =
      prefs.colorScheme && prefs.colorScheme !== 'auto'
        ? COLOR_SCHEMES[prefs.colorScheme]
        : null
    colorCSS = cs
      ? `
    html, body {
      background-color: ${cs.bg} !important;
      color: ${cs.fg} !important;
    }
    body, p, li, blockquote, span, div, h1, h2, h3, h4, h5, h6, td, th {
      color: inherit !important;
    }
    a { color: ${prefs.colorScheme === 'dark' ? '#79b8ff' : prefs.colorScheme === 'sepia' ? '#7d5a3c' : '#0969da'} !important; }
    `
      : ''
  }

  // B3 字体覆盖：
  //   - 平板新字段 `fontKey` 优先（非 'system' 时强制注入到 body）
  //   - 否则走老 `overrideFont` + `bodyFontFamily`（桌面 UI 路径）
  const tabletFont =
    prefs.fontKey && prefs.fontKey !== 'system' ? findFontByKey(prefs.fontKey) : null
  const fontEntry = FONT_FAMILIES.find((f) => f.id === prefs.bodyFontFamily)
  let familyCSS = ''
  if (tabletFont && tabletFont.family) {
    familyCSS = `
    body { font-family: ${tabletFont.family} !important; }
    p, li, blockquote, span, div, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption { font-family: inherit !important; }
    `
  } else if (prefs.overrideFont && fontEntry && fontEntry.family) {
    familyCSS = `
    body { font-family: ${fontEntry.family} !important; }
    p, li, blockquote, span, div, td, th, dt, dd, figcaption { font-family: inherit !important; }
    `
  } else if (prefs.overrideFont) {
    // 选了 system 但 overrideFont=true → 让 theme 字体强制覆盖 author
    familyCSS = `body, p, li, blockquote, h1, h2, h3, h4, h5, h6, span, div { font-family: inherit !important; }`
  }

  return `
    /* === reader prefs override (B1/B2/B3) === */
    html { font-size: ${fontPercent}% !important; }
    :where(body, p, li, blockquote, span, div, td, th, dt, dd, figcaption, a) {
      font-size: 1em !important;
    }
    body {
      line-height: ${lh} !important;
      letter-spacing: ${ls}em !important;
      text-align: ${justify} !important;
    }
    p, li, blockquote {
      line-height: ${lh} !important;
      letter-spacing: ${ls}em !important;
      text-align: ${justify} !important;
    }
    p {
      margin-top: ${ps}em !important;
      margin-bottom: ${ps}em !important;
      ${ti > 0 ? `text-indent: ${ti}em !important;` : ''}
    }
    ${colorCSS}
    ${familyCSS}
  `
}
