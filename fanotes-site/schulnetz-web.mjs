// Website session for schools whose mobile OAuth redirect is not registered.
// A PHPSESSID is bound to the client IP, so this module always opens its own
// session with the stored Microsoft SSO cookies and never replays a phone cookie.

import { extractWebIds, parseGradesHtml, parseSchedulerXml, schulnetzCallAllowed, sessionProblem, stripPhpSession } from './schulnetz-logic.mjs'

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

const setCookieLines = (response) => {
  if (typeof response.headers?.getSetCookie === 'function') return response.headers.getSetCookie()
  return response.setCookies || []
}

const storeCookies = (jar, host, lines) => {
  const current = new Map(String(jar[host] || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const cut = part.indexOf('=')
    return [part.slice(0, cut), part.slice(cut + 1)]
  }))
  for (const line of lines) {
    const pair = String(line).split(';')[0]
    const cut = pair.indexOf('=')
    if (cut <= 0) continue
    current.set(pair.slice(0, cut).trim(), pair.slice(cut + 1).trim())
  }
  jar[host] = [...current.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

const cookieFor = (jar, sso, host) => stripPhpSession(sso[host] || '') || jar[host] || ''

export const establishWebSession = async (baseUrl, ssoCookies, fetchImpl, userAgent = USER_AGENT) => {
  const sso = {}
  for (const [host, value] of Object.entries(ssoCookies || {})) sso[host] = stripPhpSession(value)
  const jar = {}
  let url = `${baseUrl.replace(/\/+$/u, '')}/index.php?pageid=1`
  let html = ''
  for (let hop = 0; hop < 8; hop += 1) {
    const current = new URL(url)
    if (current.protocol !== 'https:') return { needsInteraction: true, error: 'https' }
    const headers = {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': userAgent,
      Referer: `${baseUrl.replace(/\/+$/u, '')}/`,
    }
    const cookie = cookieFor(jar, sso, current.host)
    if (cookie) headers.Cookie = cookie
    if (!schulnetzCallAllowed('GET', url) && !current.hostname.endsWith('schulnetz-ag.ch') && !current.hostname.includes('microsoft')) {
      return { needsInteraction: true, error: 'blocked' }
    }
    if (current.pathname.endsWith('/authorize.php')) return { needsInteraction: true, error: 'mobile-oauth' }
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual' })
    storeCookies(jar, current.host, setCookieLines(response))
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { needsInteraction: true, error: 'redirect' }
      url = new URL(location, url).toString()
      continue
    }
    html = await response.text()
    const problem = sessionProblem(url, html)
    if (problem === 'ip' || problem === 'inactivity' || problem === 'login') {
      if (hop === 0) {
        url = `${baseUrl.replace(/\/+$/u, '')}/index.php?pageid=1`
        continue
      }
      return { needsInteraction: true, error: problem }
    }
    const ids = extractWebIds(url, html)
    const php = /PHPSESSID=([^;]+)/i.exec(jar[current.host] || '')?.[1] || ''
    if (ids && php) return { php, id: ids.id, transid: ids.transid, html, jar, userAgent }
    if (current.hostname.includes('microsoft') && /type=["']password["']/i.test(html)) return { needsInteraction: true, error: 'password' }
    return { needsInteraction: true, error: 'no-session' }
  }
  return { needsInteraction: true, error: 'hops' }
}

export const scrapeWithSession = async (baseUrl, session, fetchImpl) => {
  const root = baseUrl.replace(/\/+$/u, '')
  const jarHost = new URL(root).host
  const pages = {}
  let transid = session.transid
  const get = async (path) => {
    const url = path.startsWith('http') ? path : `${root}${path}`
    if (!schulnetzCallAllowed('GET', url) && !url.includes('/aksa/?') && !url.endsWith('/aksa/')) {
      pages.error = 'blocked'
      return ''
    }
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: url.includes('scheduler_processor') ? 'text/xml' : 'text/html',
        Cookie: `PHPSESSID=${session.php}`,
        'User-Agent': session.userAgent,
        Referer: `${root}/`,
      },
      redirect: 'manual',
    })
    const body = await response.text()
    const problem = sessionProblem(url, body)
    if (problem) {
      pages.problem = problem
      return ''
    }
    const fresh = extractWebIds(url, body)
    if (fresh?.transid) transid = fresh.transid
    return body
  }
  const order = ['1', '21311', '21111', '21411', '21200', '22202', '22108', '21312']
  for (const pageId of order) {
    const body = await get(`/index.php?pageid=${pageId}&id=${session.id}&transid=${transid}`)
    pages[pageId] = body
    if (pages.problem) break
  }
  if (!pages.problem && pages['22202']) {
    const today = new Date().toISOString().slice(0, 10)
    pages.scheduler = await get(`/scheduler_processor.php?view=week&curr_date=${today}&min_date=${today}&max_date=${today}&ansicht=schueleransicht&id=${session.id}&transid=${transid}&pageid=22202&timeshift=-120`)
  }
  return {
    problem: pages.problem || '',
    grades: parseGradesHtml(pages['21311'] || ''),
    events: parseSchedulerXml(pages.scheduler || ''),
    startHtml: pages['1'] || '',
    absencesHtml: pages['21111'] || '',
    kontoHtml: pages['21411'] || '',
    examsHtml: pages['21312'] || '',
    termineHtml: pages['22108'] || '',
    transid,
  }
}
