// Paths for every view, so a view can be bookmarked and the back button works.
import type { View } from './shortcuts'

export const PATHS: Record<View, string> = {
  today: '/',
  timetable: '/stundenplan',
  grades: '/noten',
  agenda: '/termine',
  absences: '/absenzen',
  updates: '/mitteilungen',
  settings: '/einstellungen',
}

export interface Route { view: View; params: URLSearchParams }

export const parseRoute = (pathname: string, search = ''): Route => {
  const clean = pathname.replace(/\/+$/u, '') || '/'
  const view = (Object.entries(PATHS).find(([, path]) => path === clean)?.[0] as View | undefined) || 'today'
  return { view, params: new URLSearchParams(search) }
}

export const routeHref = (view: View, params: Record<string, string> = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value))
  const text = query.toString()
  return `${PATHS[view]}${text ? `?${text}` : ''}`
}
