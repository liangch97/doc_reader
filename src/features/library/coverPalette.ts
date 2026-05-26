import { useEffect, useState } from 'react'

/**
 * 共享卡片调色板（亮色 / 暗夜双套）
 *
 * 设计：
 *   - 亮色：8 种 GoodNotes 风浅色调（米白 / 鼠尾草 / 雾蓝 / 砖红 / 海军 / 黑卡 / 薰衣草 / 琥珀）
 *   - 暗夜：8 种深底变体（深焦糖 / 深森林 / 深海 / 深陶土 / 深紫 / 石墨 / 苔绿 / 酒红）
 *   - 两套共用同一个 hash idx，同一本书在亮/暗下保持"对应"色相
 *   - 两套都叠加极淡 dot-grid 纹理，亮色用黑点、暗色用白点
 */

export const PAPER = {
  ink: '#2c2a3a',
  inkSoft: '#76727f',
  hairline: '#cdc7be',
}

export const COVER_TITLE_FONT =
  "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', Georgia, serif"

export interface CoverStyle {
  bg: string
  ink: string
  accent: string
  frame: string
}

/* ────────── 亮色：8 GoodNotes 经典色 ────────── */
const LIGHT_TONES: { from: string; to: string; accent: string; frame: string; ink: string }[] = [
  { from: '#f3ede0', to: '#ebe2cf', accent: '#8a6c3e', frame: '#c2b896', ink: '#2c2a26' }, // 米白纸
  { from: '#dde3d4', to: '#c9d3bf', accent: '#5a6f48', frame: '#a4b094', ink: '#2c352a' }, // 鼠尾草
  { from: '#d8e2e8', to: '#c5d3dd', accent: '#3f6680', frame: '#9aafbb', ink: '#23323e' }, // 雾蓝
  { from: '#ecd6c5', to: '#dfc1a9', accent: '#9c5839', frame: '#c19a82', ink: '#3d2418' }, // 砖红
  { from: '#3a4a5e', to: '#2c394a', accent: '#d3b67d', frame: '#56657a', ink: '#e8e1cf' }, // 深海军
  { from: '#2a2a30', to: '#1d1d22', accent: '#c79a55', frame: '#454550', ink: '#ebe5d4' }, // 黑卡
  { from: '#dfd6e6', to: '#cfc1dc', accent: '#6b539b', frame: '#a497b8', ink: '#2c243d' }, // 薰衣草
  { from: '#efdcb4', to: '#e3c891', accent: '#a07028', frame: '#c4a779', ink: '#3a2916' }, // 琥珀
]

/* ────────── 暗夜：与亮色一一对应的深底变体 ────────── */
const DARK_TONES: { from: string; to: string; accent: string; frame: string; ink: string }[] = [
  { from: '#332b1f', to: '#241e15', accent: '#d3a865', frame: '#5a4d36', ink: '#ecdfc4' }, // 深焦糖
  { from: '#243028', to: '#1a221c', accent: '#a7c39a', frame: '#3e4f44', ink: '#d8e4d0' }, // 深森林
  { from: '#1f2c38', to: '#161e26', accent: '#82b0cc', frame: '#3a4d5e', ink: '#d2dfeb' }, // 深海
  { from: '#332119', to: '#241712', accent: '#d28e6b', frame: '#5a3a2c', ink: '#ebcdb9' }, // 深陶土
  { from: '#1f2030', to: '#171823', accent: '#a190d8', frame: '#3a3a52', ink: '#d8d2ec' }, // 深紫
  { from: '#22232b', to: '#171820', accent: '#bcb8c8', frame: '#3c3d49', ink: '#e0dee8' }, // 石墨
  { from: '#252720', to: '#1a1c17', accent: '#b8b288', frame: '#43463a', ink: '#ddd9c0' }, // 苔绿
  { from: '#2c1e23', to: '#1f1418', accent: '#d089a0', frame: '#503641', ink: '#ecc8d4' }, // 酒红
]

const LIGHT_STYLES: CoverStyle[] = LIGHT_TONES.map((t) => ({
  bg: `linear-gradient(165deg, ${t.from} 0%, ${t.to} 100%)`,
  ink: t.ink,
  accent: t.accent,
  frame: t.frame,
}))

const DARK_STYLES: CoverStyle[] = DARK_TONES.map((t) => ({
  bg: `linear-gradient(165deg, ${t.from} 0%, ${t.to} 100%)`,
  ink: t.ink,
  accent: t.accent,
  frame: t.frame,
}))

/** 根据当前主题（dark/light）返回对应 styles 数组 */
export function getCoverStyles(theme: 'dark' | 'light'): CoverStyle[] {
  return theme === 'dark' ? DARK_STYLES : LIGHT_STYLES
}

/** 标题 hash → 风格索引（两套共用） */
export function paperHashIdx(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % LIGHT_STYLES.length
}

/** 监听 <html data-theme=...> 的变化，给卡片自动切换调色 */
export function useCoverStyles(): CoverStyle[] {
  const read = (): 'dark' | 'light' => {
    if (typeof document === 'undefined') return 'dark'
    return (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
  }
  const [theme, setTheme] = useState<'dark' | 'light'>(read)

  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  return getCoverStyles(theme)
}

/** 旧导出（向后兼容，默认亮色） */
export const COVER_STYLES = LIGHT_STYLES
export const PAPER_GRADIENTS = LIGHT_STYLES.map((s) => ({ css: s.bg, ink: s.ink }))
