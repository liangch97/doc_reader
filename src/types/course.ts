import type { Resource } from './resource'

export interface Course {
  course_id: string
  name: string
  description: string
  cover_color: string
  cover_emoji: string
  notebook_id: string
  outline_id: string
  sort_order: number
  archived: boolean
  created_at: string
  updated_at: string
}

export type CourseResourceCategory = 'main' | 'ref' | 'extra'

export interface CourseResourceLink {
  category: CourseResourceCategory
  sort_order: number
  added_at: string
  resource: Resource
}
