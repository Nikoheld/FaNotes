// Website session for schools whose mobile OAuth redirect is not registered.
// A PHPSESSID is bound to the client IP, so this module always opens its own
// session with the stored Microsoft SSO cookies and never replays a phone cookie.

import { addDays, carryTimetableExams, confirmedLessonStamps, emptyWeekCountsAsRead, fallbackSchoolSpan, withoutUnprovenEmptyReads, extractWebIds, findIcalUrl, icalBodyUsable, microsoftLoginHost, microsoftLoginRequired, mondaysBetween, overlayDated, overlayLessons, parseGradesHtml, parseIcs, parseSchedulerXml, parseWeekSpan, planWeekFetches, redirectTargetAllowed, schedulerBodyUsable, schedulerFetchUrl, schedulerWeekLoaded, schoolHostAllowed, schulnetzCallAllowed, sessionProblem, spanOfEvents, stripPhpSession, weekMonday, zurichToday } from './schulnetz-logic.mjs'

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

const schoolLanding = (url) => {
  let parsed
  try { parsed = new URL(url) } catch { return false }
  if (!schoolHostAllowed(parsed.hostname)) return false
  const path = parsed.pathname.replace(/\/+$/u, '')
  return path.endsWith('/aksa') || path === ''
}

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
    if (!redirectTargetAllowed(url)) return { needsInteraction: true, error: 'blocked' }
    if (!schulnetzCallAllowed('GET', url) && !microsoftLoginHost(current.hostname) && !schoolLanding(url)) {
      return { needsInteraction: true, error: 'blocked' }
    }
    if (current.pathname.endsWith('/authorize.php')) return { needsInteraction: true, error: 'mobile-oauth' }
    const response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual' })
    storeCookies(jar, current.host, setCookieLines(response))
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return { needsInteraction: true, error: 'redirect' }
      url = new URL(location, url).toString()
      if (!redirectTargetAllowed(url)) return { needsInteraction: true, error: 'blocked' }
      continue
    }
    html = await response.text()
    const problem = sessionProblem(url, html)
    if (problem === 'microsoft') return { needsInteraction: true, error: 'microsoft' }
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
    if (microsoftLoginHost(current.hostname) && /type=["']password["']/i.test(html)) return { needsInteraction: true, error: 'password' }
    return { needsInteraction: true, error: 'no-session' }
  }
  return { needsInteraction: true, error: 'hops' }
}

export const scrapeWithSession = async (baseUrl, session, fetchImpl, options = {}) => {
  const root = baseUrl.replace(/\/+$/u, '')
  const pages = {}
  let transid = session.transid
  // A browser sends the open page as referer when its scheduler loads a week.
  let openPage = `${root}/`
  const get = async (path) => {
    const url = path.startsWith('http') ? path : `${root}${path}`
    if (!redirectTargetAllowed(url) || (!schulnetzCallAllowed('GET', url) && !schoolLanding(url))) {
      pages.error = 'blocked'
      return ''
    }
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: url.includes('scheduler_processor') ? 'text/xml' : 'text/html',
        Cookie: `PHPSESSID=${session.php}`,
        'User-Agent': session.userAgent,
        Referer: url.includes('scheduler_processor') ? openPage : `${root}/`,
      },
      redirect: 'manual',
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location') || ''
      pages.problem = microsoftLoginRequired(location, '') ? 'microsoft' : 'login'
      return ''
    }
    if (response.status < 200 || response.status >= 300) {
      pages.problem = 'read-failed'
      return ''
    }
    const body = await response.text()
    const problem = sessionProblem(url, body)
    if (problem) {
      pages.problem = problem
      return ''
    }
    const fresh = extractWebIds(url, body)
    if (fresh?.transid) transid = fresh.transid
    if (!url.includes('scheduler_processor')) openPage = url
    return body
  }
  const order = ['1', '21311', '21111', '21411', '21200', '22202', '22108', '21312']
  for (const pageId of order) {
    const body = await get(`/index.php?pageid=${pageId}&id=${session.id}&transid=${transid}`)
    pages[pageId] = body
    if (pages.problem) break
  }
  const nowIso = options.now || new Date().toISOString()
  const today = options.today || zurichToday(new Date(nowIso))
  const previousEvents = Array.isArray(options.previousEvents) ? options.previousEvents : []
  const previousExams = Array.isArray(options.previousExams) ? options.previousExams : []
  const weekFetched = { ...(options.weekFetched || {}) }
  const weekRead = { ...(options.weekRead || {}) }
  if (!Object.keys(weekRead).length) Object.assign(weekRead, confirmedLessonStamps(previousEvents, weekFetched, {}))
  const examWeekFetched = { ...(options.examWeekFetched || {}) }
  let weekSpanStart = options.weekSpanStart || ''
  let weekSpanEnd = options.weekSpanEnd || ''
  let icalFetchedAt = options.icalFetchedAt || ''
  let events = previousEvents
  let exams = previousExams
  if (!pages.problem && pages['22202']) {
    const htmlSpan = parseWeekSpan(pages['22202'])
    if (htmlSpan) {
      weekSpanStart = htmlSpan.start
      weekSpanEnd = htmlSpan.end
    }
    const vacations = Array.isArray(options.vacations) ? options.vacations : []
    // Without a range on the page, plan the school year from appointments and holidays,
    // not only the four weeks around today.
    const span = weekSpanStart && weekSpanEnd ? { start: weekSpanStart, end: weekSpanEnd } : fallbackSchoolSpan(previousEvents, vacations, today)
    const icalUrl = findIcalUrl(pages['22202'], root)
    const icalAvailable = Boolean(icalUrl && schulnetzCallAllowed('GET', icalUrl))
    const plan = planWeekFetches({
      mondays: span ? mondaysBetween(span.start, span.end) : [],
      // Retry timing follows every attempt, so an unread week is not requested on every sync.
      fetchedAt: { ...weekFetched, ...confirmedLessonStamps(previousEvents, weekFetched, weekRead) },
      icalFetchedAt,
      now: nowIso,
      today,
      icalAvailable,
    })
    const lessonWeeks = {}
    const examWeeks = {}
    const current = weekMonday(today)
    let currentEmptyUsable = false
    const emptyWeeks = []
    let schedulerGaveLessons = false
    // Schulnetz hands out a new transid with every page, and the scheduler only answers with the
    // transid of its own page. After Terminliste and Prüfungen the timetable's transid is stale and
    // every week came back empty, so open each page again right before its weeks.
    const reopen = async (pageId) => { await get(`/index.php?pageid=${pageId}&id=${session.id}&transid=${transid}`) }
    if (plan.fetch.length && !pages.problem) await reopen('22202')
    for (const monday of plan.fetch) {
      if (pages.problem) break
      const max = addDays(monday, 7)
      const curr = monday === current ? today : monday
      const lessonUrl = schedulerFetchUrl({ root, pageId: '22202', ansicht: 'schueleransicht', id: session.id, transid, today: curr, min: monday, max, extra: '' })
      const lessonBody = await get(lessonUrl)
      if (schedulerWeekLoaded(lessonBody)) {
        const parsed = parseSchedulerXml(lessonBody)
        if (parsed.length) {
          lessonWeeks[monday] = parsed
          weekFetched[monday] = nowIso
          weekRead[monday] = nowIso
          schedulerGaveLessons = true
        }
      } else if (schedulerBodyUsable(lessonBody)) {
        if (monday !== current) {
          weekFetched[monday] = nowIso
          emptyWeeks.push(monday)
        } else {
          currentEmptyUsable = true
        }
      }
    }
    if (plan.fetch.length && !pages.problem) await reopen('21312')
    for (const monday of plan.fetch) {
      if (pages.problem) break
      const max = addDays(monday, 7)
      const curr = monday === current ? today : monday
      const examUrl = schedulerFetchUrl({ root, pageId: '21312', ansicht: 'klassenuebersicht', id: session.id, transid, today: curr, min: monday, max, extra: 'showOnlyThisClass=-1' })
      const examBody = await get(examUrl)
      if (schedulerWeekLoaded(examBody)) {
        const parsed = parseSchedulerXml(examBody).map((event) => ({
          ...event,
          eventType: event.eventType && event.eventType !== 'lesson' ? event.eventType : 'exam',
        }))
        if (parsed.length) {
          examWeeks[monday] = parsed
          examWeekFetched[monday] = nowIso
        }
      } else if (schedulerBodyUsable(examBody) && !previousExams.some((event) => weekMonday(String(event.start || '').slice(0, 10)) === monday)) {
        examWeekFetched[monday] = nowIso
      }
    }
    const lessonEvents = Object.values(lessonWeeks).flat()
    events = overlayLessons(previousEvents, lessonEvents, new Set(Object.keys(lessonWeeks)))
    exams = carryTimetableExams(lessonEvents, overlayDated(previousExams, Object.values(examWeeks).flat(), new Set(Object.keys(examWeeks))))
    // An empty answer proves a free week only when the scheduler returned lessons for some week
    // in this read, or the week is a holiday. Otherwise the week stays "not loaded".
    for (const monday of emptyWeeks) if (emptyWeekCountsAsRead(monday, schedulerGaveLessons, vacations)) weekRead[monday] = nowIso
    if (currentEmptyUsable && !Object.hasOwn(lessonWeeks, current) && emptyWeekCountsAsRead(current, schedulerGaveLessons, vacations)) weekRead[current] = nowIso
    if (!schedulerGaveLessons && plan.fetch.length) {
      const kept = withoutUnprovenEmptyReads(weekRead, events, vacations)
      for (const key of Object.keys(weekRead)) if (!Object.hasOwn(kept, key)) delete weekRead[key]
    }
    if (plan.fetchIcal && icalAvailable && !pages.problem) {
      const body = await get(icalUrl)
      if (icalBodyUsable(body)) {
        const icalEvents = parseIcs(body)
        icalFetchedAt = nowIso
        if (!htmlSpan) {
          const icalSpan = spanOfEvents(icalEvents)
          if (icalSpan) {
            weekSpanStart = icalSpan.start
            weekSpanEnd = icalSpan.end
          }
        }
        const refreshed = new Set(Object.keys(lessonWeeks))
        const covered = new Set(weekSpanStart && weekSpanEnd ? mondaysBetween(weekSpanStart, weekSpanEnd) : icalEvents.map((event) => weekMonday(String(event.start || '').slice(0, 10))).filter(Boolean))
        const uncovered = new Set([...covered].filter((monday) => !refreshed.has(monday)))
        events = overlayLessons(events, icalEvents, uncovered)
        exams = carryTimetableExams(icalEvents.filter((event) => !Object.hasOwn(examWeeks, weekMonday(String(event.start || '').slice(0, 10)))), exams)
        for (const monday of covered) {
          if (icalEvents.some((event) => event.eventType === 'exam' && weekMonday(String(event.start || '').slice(0, 10)) === monday) ||
            !previousExams.some((event) => weekMonday(String(event.start || '').slice(0, 10)) === monday)) examWeekFetched[monday] = nowIso
        }
      }
    }
  }
  return {
    problem: pages.problem || '',
    grades: parseGradesHtml(pages['21311'] || ''),
    events,
    exams,
    startHtml: pages['1'] || '',
    absencesHtml: pages['21111'] || '',
    kontoHtml: pages['21411'] || '',
    examsHtml: pages['21312'] || '',
    termineHtml: pages['22108'] || '',
    transid,
    weekFetched,
    weekRead,
    examWeekFetched,
    weekSpanStart,
    weekSpanEnd,
    icalFetchedAt,
  }
}
