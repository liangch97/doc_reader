import {
  BookOpen,
  Bot,
  HardDrive,
  Wrench,
  Sigma,
  Globe,
  Settings,
  Dna,
  GraduationCap,
  Library,
  PenLine,
  Microscope,
  type LucideIcon,
} from 'lucide-react'

/**
 * 课程封面图标系统：用 lucide SVG 替代 emoji
 *
 * `cover_emoji` 字段（向后兼容字段名）现在存放 lucide 图标名（小写）。
 * 对历史 emoji 数据：通过 EMOJI_FALLBACK 映射到对应图标，未知一律 fallback 到 'book'。
 */

export const COVER_ICON_MAP: Record<string, LucideIcon> = {
  book: BookOpen,
  library: Library,
  graduation: GraduationCap,
  bot: Bot,
  drive: HardDrive,
  wrench: Wrench,
  sigma: Sigma,
  globe: Globe,
  settings: Settings,
  dna: Dna,
  pen: PenLine,
  microscope: Microscope,
}

/** 推荐给用户挑选的图标列表（顺序即展示顺序） */
export const COVER_ICON_PRESETS: { id: string; label: string }[] = [
  { id: 'book', label: '书' },
  { id: 'library', label: '书库' },
  { id: 'graduation', label: '学位' },
  { id: 'bot', label: 'AI' },
  { id: 'sigma', label: '数学' },
  { id: 'dna', label: '生物' },
  { id: 'microscope', label: '科学' },
  { id: 'globe', label: '世界' },
  { id: 'wrench', label: '工程' },
  { id: 'drive', label: '存储' },
  { id: 'pen', label: '写作' },
  { id: 'settings', label: '设置' },
]

/** 历史 emoji → 图标 id 兼容映射 */
const EMOJI_FALLBACK: Record<string, string> = {
  '📚': 'book',
  '📖': 'book',
  '🤖': 'bot',
  '💾': 'drive',
  '🔧': 'wrench',
  '🧮': 'sigma',
  '🌐': 'globe',
  '⚙️': 'settings',
  '🧬': 'dna',
  '🎓': 'graduation',
  '✏️': 'pen',
  '🔬': 'microscope',
}

export function resolveCoverIcon(value: string | null | undefined): LucideIcon {
  if (!value) return COVER_ICON_MAP.book
  const id = EMOJI_FALLBACK[value] ?? value
  return COVER_ICON_MAP[id] ?? COVER_ICON_MAP.book
}
