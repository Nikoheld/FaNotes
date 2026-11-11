// Paths for every view, so a view can be bookmarked and the back button works.
import type { View } from './shortcuts'

export const PATHS: Record<View, string> = {
  today: '/',
  timetable: '/stundenplan',
  grades: '/noten',
  agenda: '/termine',
  absences: '/absenzen',
  updates: '/mitteilungen',
  commute: '/pendeln',
  settings: '/einstellungen',
}

/** The operator's upload page. Reachable by URL only; it is in no menu and works without a session. */
export const ADMIN_TIMETABLE_PATH = '/admin/stundenplan'

export interface Route { view: View; params: URLSearchParams; admin?: 'timetable' }

export const parseRoute = (pathname: string, search = ''): Route => {
  const clean = pathname.replace(/\/+$/u, '') || '/'
  if (clean === ADMIN_TIMETABLE_PATH) return { view: 'today', params: new URLSearchParams(search), admin: 'timetable' }
  const view = (Object.entries(PATHS).find(([, path]) => path === clean)?.[0] as View | undefined) || 'today'
  return { view, params: new URLSearchParams(search) }
}

export const routeHref = (view: View, params: Record<string, string> = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value))
  const text = query.toString()
  return `${PATHS[view]}${text ? `?${text}` : ''}`
}
