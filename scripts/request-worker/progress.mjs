// Maps Claude Code stream-json events to short German progress lines.
import path from 'node:path'

const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/

export function findPrUrl(text) {
  const m = PR_URL_RE.exec(String(text || ''))
  return m ? { url: m[0], number: Number(m[1]) } : null
}

function shorten(s, n = 60) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

const base = (p) => (p ? path.basename(String(p)) : 'Datei')

// Returns {text, important} for a Bash command.
export function describeBash(cmd) {
  const c = String(cmd || '')
  if (/gh\s+pr\s+create/.test(c)) return { text: 'Erstellt Pull Request', important: true }
  if (/gh\s+pr\s+(checks|view)/.test(c)) return { text: 'Prüft CI-Status' }
  if (/git\s+push/.test(c)) return { text: 'Lädt Branch hoch', important: true }
  if (/git\s+commit/.test(c)) return { text: 'Committet Änderungen', important: true }
  if (/gradlew/.test(c)) return { text: /:core:test|test/.test(c) ? 'Führt Android-Tests aus' : 'Baut die Android-App', important: true }
  if (/\btsc\b/.test(c)) return { text: 'Prüft Typen (tsc)', important: true }
  if (/node\s+--test|vitest|jest|npm\s+(run\s+)?test|check-[\w-]+\.(mjs|cjs)/.test(c)) return { text: 'Führt Tests aus', important: true }
  if (/vite\s+build|npm\s+run\s+build/.test(c)) return { text: 'Baut die Web-App' }
  if (/playwright|chromium/.test(c)) return { text: 'Testet im Browser' }
  if (/git\s+(fetch|rebase|merge)/.test(c)) return { text: 'Aktualisiert Git' }
  if (/^\s*(grep|rg|find|ls|cat|sed|head|tail)\b/.test(c)) return { text: 'Durchsucht den Code' }
  return { text: `Führt aus: ${shorten(c, 50)}` }
}

export function describeTool(name, input = {}) {
  switch (name) {
    case 'Read': return { text: `Liest ${base(input.file_path)}` }
    case 'Edit':
    case 'MultiEdit': return { text: `Bearbeitet ${base(input.file_path)}` }
    case 'Write': return { text: `Schreibt ${base(input.file_path)}` }
    case 'NotebookEdit': return { text: `Bearbeitet ${base(input.notebook_path)}` }
    case 'Glob': return { text: 'Sucht Dateien' }
    case 'Grep': return { text: 'Durchsucht den Code' }
    case 'Bash': return describeBash(input.command)
    case 'WebFetch':
    case 'WebSearch': return { text: 'Liest Dokumentation im Web' }
    case 'Task':
    case 'Agent': return { text: 'Startet einen Hilfsagenten' }
    case 'TodoWrite': return { text: 'Aktualisiert den Plan' }
    default: return { text: `Nutzt ${shorten(name, 30)}` }
  }
}

// Parse one stream-json line. Returns an array of
// {kind:'progress', text, important?} | {kind:'session', id} | {kind:'pr', url, number} | {kind:'result', ok, text}
export function mapStreamEvent(ev) {
  const out = []
  if (!ev || typeof ev !== 'object') return out
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) out.push({ kind: 'session', id: ev.session_id })
    out.push({ kind: 'progress', text: 'Claude startet' })
    return out
  }
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_use') {
        const d = describeTool(block.name, block.input)
        out.push({ kind: 'progress', text: d.text, important: !!d.important, tool: block.name })
        const pr = findPrUrl(block.input?.command)
        if (pr) out.push({ kind: 'pr', ...pr })
      }
    }
    return out
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type !== 'tool_result') continue
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : ''
      const pr = findPrUrl(text)
      if (pr) {
        out.push({ kind: 'pr', ...pr })
        out.push({ kind: 'progress', text: `Erstellt PR #${pr.number}`, important: true })
      }
    }
    return out
  }
  if (ev.type === 'result') {
    if (ev.session_id) out.push({ kind: 'session', id: ev.session_id })
    const ok = ev.subtype === 'success' && !ev.is_error
    const pr = findPrUrl(ev.result)
    if (pr) out.push({ kind: 'pr', ...pr })
    out.push({ kind: 'result', ok, text: typeof ev.result === 'string' ? ev.result : '', subtype: ev.subtype })
    out.push({ kind: 'progress', text: ok ? 'Arbeitsschritt abgeschlossen' : 'Lauf beendet mit Fehler', important: true })
  }
  return out
}

// Rough percent for the live view: grows with tool steps, capped below PR stage.
export function estimatePercent(steps) {
  return Math.min(85, Math.round(10 + 75 * (1 - Math.exp(-steps / 40))))
}

// Throttled poster. Important lines are queued; others only keep the latest.
export function createThrottle({ minIntervalMs, post, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = -Infinity
  let latest = null
  let queue = []
  let timer = null
  const drain = () => {
    timer = null
    let item = null
    if (queue.length) item = queue.shift()
    else if (latest) { item = latest; latest = null }
    if (item) { last = now(); post(item) }
    if (queue.length || latest) schedule()
  }
  const schedule = () => {
    if (timer) return
    timer = setTimer(drain, Math.max(0, minIntervalMs - (now() - last)))
  }
  return {
    push(item, important = false) {
      if (important) queue.push(item)
      else latest = item
      if (now() - last >= minIntervalMs && !timer) drain()
      else schedule()
    },
    flushNow() {
      if (timer) clearTimer(timer)
      timer = null
      const all = [...queue, ...(latest ? [latest] : [])]
      queue = []
      latest = null
      for (const i of all) post(i)
      if (all.length) last = now()
    },
  }
}
