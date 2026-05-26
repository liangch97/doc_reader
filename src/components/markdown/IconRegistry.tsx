import {
  Pencil, CheckCircle2, CheckSquare2, Check, XCircle, XSquare, AlertTriangle,
  Lightbulb, Pin, MapPin, Target, Key, Lock, Unlock, BookOpen, Notebook,
  NotebookPen, NotebookText, Clipboard, Folder, FolderOpen, Folders, Calendar,
  CalendarDays, AlarmClock, Timer, Clock, Bell, BellOff, Star, Sparkles, Flame,
  BadgeCheck, ThumbsUp, ThumbsDown, Heart, HeartCrack, Rocket, PartyPopper,
  BarChart3, TrendingUp, TrendingDown, Search, Globe, Link, Settings, Wrench,
  Briefcase, Laptop, Monitor, Smartphone, MessageCircle, MessageSquare, Mail,
  MailOpen, Inbox, Send, Info, HelpCircle, AlertCircle, Hourglass, Trophy,
  Medal, GraduationCap, Palette, Camera, Music, Film, Map, Brain, Gem, Sprout,
  Trees, Earth, Sun, Moon, Cloud, Zap, Rainbow,
  type LucideIcon,
} from 'lucide-react'

/** Mapping from kebab-case data-icon attribute to a lucide-react component */
export const ICON_REGISTRY: Record<string, LucideIcon> = {
  'pencil': Pencil,
  'check-circle-2': CheckCircle2,
  'check-square-2': CheckSquare2,
  'check': Check,
  'x-circle': XCircle,
  'x-square': XSquare,
  'alert-triangle': AlertTriangle,
  'lightbulb': Lightbulb,
  'pin': Pin,
  'map-pin': MapPin,
  'target': Target,
  'key': Key,
  'lock': Lock,
  'unlock': Unlock,
  'book-open': BookOpen,
  'notebook': Notebook,
  'notebook-pen': NotebookPen,
  'notebook-text': NotebookText,
  'clipboard': Clipboard,
  'folder': Folder,
  'folder-open': FolderOpen,
  'folders': Folders,
  'calendar': Calendar,
  'calendar-days': CalendarDays,
  'alarm-clock': AlarmClock,
  'timer': Timer,
  'clock': Clock,
  'bell': Bell,
  'bell-off': BellOff,
  'star': Star,
  'sparkles': Sparkles,
  'flame': Flame,
  'badge-check': BadgeCheck,
  'thumbs-up': ThumbsUp,
  'thumbs-down': ThumbsDown,
  'heart': Heart,
  'heart-crack': HeartCrack,
  'rocket': Rocket,
  'party-popper': PartyPopper,
  'bar-chart-3': BarChart3,
  'trending-up': TrendingUp,
  'trending-down': TrendingDown,
  'search': Search,
  'globe': Globe,
  'link': Link,
  'settings': Settings,
  'wrench': Wrench,
  'briefcase': Briefcase,
  'laptop': Laptop,
  'monitor': Monitor,
  'smartphone': Smartphone,
  'message-circle': MessageCircle,
  'message-square': MessageSquare,
  'mail': Mail,
  'mail-open': MailOpen,
  'inbox': Inbox,
  'send': Send,
  'info': Info,
  'help-circle': HelpCircle,
  'alert-circle': AlertCircle,
  'hourglass': Hourglass,
  'trophy': Trophy,
  'medal': Medal,
  'graduation-cap': GraduationCap,
  'palette': Palette,
  'camera': Camera,
  'music': Music,
  'film': Film,
  'map': Map,
  'brain': Brain,
  'gem': Gem,
  'sprout': Sprout,
  'trees': Trees,
  'earth': Earth,
  'sun': Sun,
  'moon': Moon,
  'cloud': Cloud,
  'zap': Zap,
  'rainbow': Rainbow,
}

interface InlineIconProps {
  name: string
  className?: string
}

/** Renders an inline lucide icon for use inside markdown spans. */
export function InlineIcon({ name, className }: InlineIconProps) {
  const Icon = ICON_REGISTRY[name]
  if (!Icon) return null
  return (
    <span className={`md-icon-wrap ${className ?? ''}`} aria-hidden="true">
      <Icon size={14} strokeWidth={2} />
    </span>
  )
}
