'use strict'

// Local MCP server core: JSON-RPC 2.0 + the Model Context Protocol surface
// (initialize, tools, resources, prompts). Transport-free: `handle(message)`
// takes one parsed JSON-RPC message and resolves to a response (or null for
// notifications). Transports live in local-mcp-transport.cjs.
//
// `context()` is called for every request and returns
// `{ enabled, writeAccess, vaultPath, excludedFolders }`, so toggles in
// Settings apply without restarting the client's server process.
// Note contents are never logged.

const { createVault, McpError } = require('./local-mcp-vault.cjs')

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'fanotes', title: 'FaNotes', version: '1.0.0' }
// About 15k tokens: under Claude Code's default MAX_MCP_OUTPUT_TOKENS (25k).
const MAX_RESULT_CHARS = 60_000
const RESOURCE_PAGE = 500
const TOOL_TIMEOUT_MS = 30_000
const MAX_BATCH = 10
// Requests beyond MAX_RUNNING wait in a bounded queue (clients routinely fire
// 5 to 10 parallel tool calls); only a full queue or a long wait is refused.
const MAX_RUNNING = 8
const MAX_QUEUED = 64
const QUEUE_TIMEOUT_MS = 30_000
const NOTE_URI = 'fanotes://note/'

const INSTRUCTIONS = [
  'FaNotes is the user\'s personal notebook: Markdown notes, handwritten notes (.famd), PDFs, writing projects (.story),',
  'homework/tasks, a calendar, exams and flashcards. All tools read the local vault on this computer.',
  'Paths are vault-relative (for example "Mathe/Analysis.md"). Start with vault_stats or list_folders, then list_notes,',
  'search_notes and read_note. Tools are read-only unless the user turned on write access in FaNotes Settings.',
].join(' ')

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const S = (description, extra = {}) => ({ type: 'string', description, ...extra })
const N = (description, min, max) => ({ type: 'integer', description, minimum: min, maximum: max })
const B = (description) => ({ type: 'boolean', description })
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

const TOOLS = [
  { name: 'vault_stats', title: 'Vault overview', description: 'Counts of notes by kind, folders, open and overdue tasks and events in the next 7 days.', inputSchema: obj(), annotations: READ },
  { name: 'list_folders', title: 'Folders and subjects', description: 'All folders of the vault. "subjects" are the top-level folders (school subjects).', inputSchema: obj(), annotations: READ },
  {
    name: 'list_notes',
    title: 'List notes',
    description: 'Lists notes (Markdown, handwriting, PDF, story), newest first. Filter by folder, modification time and kind.',
    inputSchema: obj({
      folder: S('Folder path, e.g. "Mathe". Includes sub-folders.'),
      modifiedSince: S('ISO date or date-time; only notes modified at or after it.'),
      kind: S('One of markdown, handwriting, pdf, story.', { enum: ['markdown', 'handwriting', 'pdf', 'story'] }),
      sort: S('modified (default) or path.', { enum: ['modified', 'path'] }),
      limit: N('Maximum rows (default 100).', 1, 500),
      offset: N('Rows to skip.', 0, 100000),
    }),
    annotations: READ,
  },
  {
    name: 'read_note',
    title: 'Read a note',
    description: 'Returns the text of one note. Handwritten notes return their recognized text; PDFs return the page text FaNotes extracted. Never returns images or raw bytes. Use read_story for *.story paths.',
    inputSchema: obj({ path: S('Vault-relative note path.'), maxChars: N('Truncate after this many characters (default 60000).', 1000, 200000) }, ['path']),
    annotations: READ,
  },
  {
    name: 'search_notes',
    title: 'Search notes',
    description: 'Full-text search over all notes, PDF page text and stories. German-aware (ss/ß, case). All words must occur.',
    inputSchema: obj({
      query: S('Words to search for.'),
      folder: S('Limit to a folder.'),
      kind: S('Limit to one kind.', { enum: ['markdown', 'handwriting', 'pdf', 'story'] }),
      limit: N('Maximum matches (default 20).', 1, 50),
    }, ['query']),
    annotations: READ,
  },
  {
    name: 'list_tasks',
    title: 'Tasks and homework',
    description: 'Homework and appointments from the FaNotes task list, sorted by due date. Open tasks only unless includeDone is true.',
    inputSchema: obj({
      includeDone: B('Also return finished tasks.'),
      subject: S('Only this subject.'),
      kind: S('homework or appointment.', { enum: ['homework', 'appointment'] }),
      dueBefore: S('YYYY-MM-DD; due on or before.'),
      dueAfter: S('YYYY-MM-DD; due on or after.'),
      overdue: B('Only open tasks whose due date has passed.'),
      limit: N('Maximum rows (default 100).', 1, 500),
    }),
    annotations: READ,
  },
  {
    name: 'list_calendar',
    title: 'Calendar events',
    description: 'Calendar occurrences (recurring events expanded) between two dates, including hidden calendars. Default: today until 370 days ahead.',
    inputSchema: obj({ from: S('YYYY-MM-DD'), to: S('YYYY-MM-DD, exclusive') }),
    annotations: READ,
  },
  {
    name: 'list_exams',
    title: 'Exams',
    description: 'Exam dates: calendar events and tasks called Klausur/Prüfung/exam, plus note lines that name an exam with a date.',
    inputSchema: obj({ from: S('YYYY-MM-DD'), to: S('YYYY-MM-DD, exclusive'), includeNotes: B('Also scan notes for exam lines (default true).') }),
    annotations: READ,
  },
  { name: 'list_flashcard_decks', title: 'Flashcard decks', description: 'Notes that contain flashcards (stored cards or a "Lernfragen" section) with card and due counts.', inputSchema: obj(), annotations: READ },
  {
    name: 'list_flashcards',
    title: 'Flashcards',
    description: 'Flashcards of one deck (note path) or of all decks, optionally only the ones due today.',
    inputSchema: obj({ path: S('Deck note path; omit for all decks.'), dueOnly: B('Only cards due today or earlier.'), limit: N('Maximum cards (default 40).', 1, 400) }),
    annotations: READ,
  },
  { name: 'list_stories', title: 'Writing projects', description: 'Stories (writing mode, *.story) in the vault.', inputSchema: obj(), annotations: READ },
  {
    name: 'read_story',
    title: 'Read a story',
    description: 'Outline (chapters, scenes, synopsis, status, word counts), scene text and the story bible (characters, places, events) of a story.',
    inputSchema: obj({
      path: S('Story path ending in .story.'),
      scene: S('Only this scene id (from the outline), with its full text.'),
      includeText: B('Include scene text (default true).'),
      maxChars: N('Total scene text limit (default 60000).', 1000, 200000),
    }, ['path']),
    annotations: READ,
  },
  {
    name: 'recent_activity',
    title: 'Recent activity',
    description: 'The most recently modified notes, optionally since a time.',
    inputSchema: obj({ since: S('ISO date or date-time.'), limit: N('Maximum rows (default 20).', 1, 200) }),
    annotations: READ,
  },
]

const WRITE_TOOLS = [
  {
    name: 'create_note',
    title: 'Create a note',
    description: 'Creates a new Markdown note. Fails if the path already exists; never overwrites.',
    inputSchema: obj({ path: S('New vault-relative path ending in .md, e.g. "Mathe/Ideen.md". Folders are created.'), content: S('Markdown text.') }, ['path', 'content']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'append_to_note',
    title: 'Append to a note',
    description: 'Appends text to the end of an existing Markdown note. Refuses if the note changed meanwhile.',
    inputSchema: obj({ path: S('Existing .md note.'), text: S('Markdown to append.') }, ['path', 'text']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'add_task',
    title: 'Add a task',
    description: 'Adds a homework item or appointment to the FaNotes task list.',
    inputSchema: obj({
      title: S('Task title.'),
      subject: S('Subject, e.g. "Mathe".'),
      dueDate: S('YYYY-MM-DD'),
      dueTime: S('HH:mm'),
      notes: S('Details.'),
      kind: S('homework (default) or appointment.', { enum: ['homework', 'appointment'] }),
      priority: S('normal (default) or high.', { enum: ['normal', 'high'] }),
    }, ['title']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'complete_task',
    title: 'Complete a task',
    description: 'Marks a task as done (or open again with done=false). Identify it by id from list_tasks.',
    inputSchema: obj({ id: S('Task id from list_tasks.'), title: S('Exact title, if there is no id.'), done: B('Default true.') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]

const PROMPTS = [
  {
    name: 'weekly_overview',
    title: 'Weekly overview',
    description: 'Summarise open tasks, exams and calendar for the coming days.',
    arguments: [],
    build: () => 'Use the FaNotes tools list_tasks (overdue and next 7 days), list_exams and list_calendar to give me a short plan for the coming week: what is due, which exams are near, and what I should do first.',
  },
  {
    name: 'summarize_note',
    title: 'Summarise a note',
    description: 'Summarise one note and list open questions.',
    arguments: [{ name: 'path', description: 'Vault-relative note path', required: true }],
    build: (args) => `Read the FaNotes note "${String(args.path ?? '')}" with read_note and summarise it in a few bullet points, then list questions I could still study.`,
  },
]

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })

const textResult = (value, isError = false) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length > MAX_RESULT_CHARS) {
    // Keep the payload valid JSON for structured values; flag the cut instead of slicing mid-token.
    text = typeof value === 'string'
      ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
      : JSON.stringify({ truncated: true, note: 'The result was too large and was cut. Narrow the request (folder, limit, offset, maxChars).', partial: text.slice(0, MAX_RESULT_CHARS - 300) })
  }
  return { content: [{ type: 'text', text }], isError }
}

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new McpError('The request took too long.', 'timeout')), ms)
  promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
})

const noteUri = (rel) => `${NOTE_URI}${rel.split('/').map(encodeURIComponent).join('/')}`
const pathFromUri = (uri) => {
  if (typeof uri !== 'string' || !uri.startsWith(NOTE_URI)) throw new McpError('Unknown resource URI.')
  try {
    return uri.slice(NOTE_URI.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    throw new McpError('Unknown resource URI.')
  }
}

const num = (value, fallback, min, max) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback)

/**
 * @param {{ context: () => Promise<object>|object, log?: (line: string) => void }} options
 */
const createLocalMcpServer = ({
  context, log = () => {}, listChanged = false, version = SERVER_INFO.version,
  maxRunning = MAX_RUNNING, maxQueued = MAX_QUEUED, queueTimeoutMs = QUEUE_TIMEOUT_MS,
}) => {
  const state = { vault: null, key: '' }
  let running = 0
  const queue = []
  let listedSignature = null

  /** Resolves true once a slot is held, false when the queue is full or the wait timed out. */
  const acquire = () => {
    if (running < maxRunning) { running += 1; return Promise.resolve(true) }
    if (queue.length >= maxQueued) return Promise.resolve(false)
    return new Promise((resolve) => {
      const entry = { resolve, timer: null }
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
        resolve(false)
      }, queueTimeoutMs)
      queue.push(entry)
    })
  }
  const release = () => {
    const next = queue.shift()
    if (next) { clearTimeout(next.timer); next.resolve(true) } // the slot passes on
    else running -= 1
  }

  /** Tools a client may see right now. Read tools are always listed; write tools only with write access. */
  const visibleTools = (ctx) => (ctx?.enabled && ctx.writeAccess ? [...TOOLS, ...WRITE_TOOLS] : TOOLS)
  const signatureOf = (ctx) => (ctx?.enabled && ctx.writeAccess ? 'rw' : 'r')

  const current = async () => {
    const ctx = await context()
    if (!ctx?.enabled) return { ctx, vault: null }
    const key = `${ctx.vaultPath}\0${(ctx.excludedFolders ?? []).join('\n')}`
    if (!state.vault || state.key !== key) {
      state.vault = createVault({ root: ctx.vaultPath, excluded: ctx.excludedFolders ?? [] })
      state.key = key
    }
    return { ctx, vault: state.vault }
  }

  const callTool = async (name, args, { ctx, vault }) => {
    const readNote = async () => {
      const rel = vault.cleanPath(args.path)
      const note = await vault.noteContent(rel)
      const maxChars = num(args.maxChars, 60_000, 1000, 200_000)
      return {
        path: rel,
        title: vault.titleOf(rel, note.text),
        kind: note.kind,
        modifiedAt: note.modifiedAt,
        truncated: note.text.length > maxChars,
        ...(note.note ? { note: note.note } : {}),
        ...(note.companions?.length ? { companionNotes: note.companions } : {}),
        markdown: note.text.slice(0, maxChars),
      }
    }
    switch (name) {
      case 'vault_stats': return vault.vaultStats()
      case 'list_folders': return vault.listFolders()
      case 'list_notes': return vault.listNotes({ folder: args.folder, since: args.modifiedSince, kind: args.kind, sort: args.sort, limit: num(args.limit, 100, 1, 500), offset: num(args.offset, 0, 0, 100_000) })
      case 'read_note': return readNote()
      case 'search_notes': return vault.searchNotes({ query: args.query, folder: args.folder, kind: args.kind, limit: num(args.limit, 20, 1, 50) })
      case 'list_tasks': return vault.listTasks({ includeDone: args.includeDone === true, subject: args.subject, kind: args.kind, dueBefore: args.dueBefore, dueAfter: args.dueAfter, overdue: args.overdue === true, limit: num(args.limit, 100, 1, 500) })
      case 'list_calendar': return vault.listCalendar({ from: args.from, to: args.to })
      case 'list_exams': return vault.listExams({ from: args.from, to: args.to, includeNotes: args.includeNotes })
      case 'list_flashcard_decks': return vault.flashcardDecks()
      case 'list_flashcards': return vault.listFlashcards({ path: args.path, dueOnly: args.dueOnly === true, limit: num(args.limit, 40, 1, 400) })
      case 'list_stories': return vault.listStories()
      case 'read_story': return vault.readStory(vault.cleanPath(args.path), { text: args.includeText !== false, scene: typeof args.scene === 'string' ? args.scene : '', maxChars: num(args.maxChars, 60_000, 1000, 200_000) })
      case 'recent_activity': return vault.recentActivity({ since: args.since, limit: num(args.limit, 20, 1, 200) })
      case 'create_note':
      case 'append_to_note':
      case 'add_task':
      case 'complete_task': {
        if (!ctx.writeAccess) throw new McpError('Write access is off. The user can turn it on in FaNotes under Settings > MCP Server.', 'forbidden')
        if (name === 'create_note') return vault.createNote(args)
        if (name === 'append_to_note') return vault.appendToNote(args)
        if (name === 'add_task') return vault.addTask(args)
        return vault.completeTask(args)
      }
      default: throw new McpError(`Unknown tool: ${String(name).slice(0, 60)}`, 'unknown')
    }
  }

  const handleRequest = async (message) => {
    const { id, method } = message
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {}
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false } },
        serverInfo: { ...SERVER_INFO, version },
        instructions: INSTRUCTIONS,
      })
    }
    if (method === 'ping') return rpcResult(id, {})

    const { ctx, vault } = await current()
    if (method === 'tools/list') {
      // Always list the read tools: a client that connected before the feature was switched on
      // keeps its cached list, and calls answer with the "switched off" hint until it is on.
      listedSignature = signatureOf(ctx)
      return rpcResult(id, { tools: visibleTools(ctx) })
    }
    if (method === 'tools/call') {
      if (typeof params.name !== 'string') return rpcError(id, -32602, 'Missing tool name.')
      if (!vault) return rpcResult(id, textResult('AI access is switched off in FaNotes. Turn it on under Settings > MCP Server.', true))
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
      const known = [...TOOLS, ...WRITE_TOOLS].some((tool) => tool.name === params.name)
      if (!known) return rpcError(id, -32602, `Unknown tool: ${params.name.slice(0, 60)}`)
      try {
        const value = await withTimeout(callTool(params.name, args, { ctx, vault }), TOOL_TIMEOUT_MS)
        log(`tool ${params.name} ok`)
        return rpcResult(id, textResult(value))
      } catch (error) {
        log(`tool ${params.name} failed (${error?.code ?? 'error'})`)
        const message = error instanceof McpError ? error.message : 'The tool failed unexpectedly.'
        return rpcResult(id, textResult(message, true))
      }
    }
    if (method === 'resources/list') {
      if (!vault) return rpcResult(id, { resources: [] })
      const offset = /^\d{1,7}$/u.test(String(params.cursor ?? '')) ? Number(params.cursor) : 0
      const listing = await vault.listNotes({ limit: RESOURCE_PAGE, offset, sort: 'modified' })
      const next = offset + RESOURCE_PAGE < listing.total ? { nextCursor: String(offset + RESOURCE_PAGE) } : {}
      return rpcResult(id, {
        ...next,
        resources: listing.notes.filter((note) => note.kind !== 'story').map((note) => ({
          uri: noteUri(note.path),
          name: note.path,
          title: note.title,
          mimeType: 'text/markdown',
        })),
      })
    }
    if (method === 'resources/templates/list') {
      return rpcResult(id, { resourceTemplates: [{ uriTemplate: `${NOTE_URI}{+path}`, name: 'note', title: 'FaNotes note', description: 'A note by vault-relative path.', mimeType: 'text/markdown' }] })
    }
    if (method === 'resources/read') {
      if (!vault) return rpcError(id, -32002, 'AI access is switched off in FaNotes.')
      try {
        const rel = vault.cleanPath(pathFromUri(params.uri))
        const note = await vault.noteContent(rel)
        return rpcResult(id, { contents: [{ uri: noteUri(rel), mimeType: 'text/markdown', text: note.text.slice(0, 200_000) }] })
      } catch (error) {
        return rpcError(id, error?.code === 'not_found' ? -32002 : -32602, error instanceof McpError ? error.message : 'The resource could not be read.')
      }
    }
    if (method === 'prompts/list') return rpcResult(id, { prompts: PROMPTS.map(({ build, ...rest }) => rest) })
    if (method === 'prompts/get') {
      const prompt = PROMPTS.find((entry) => entry.name === params.name)
      if (!prompt) return rpcError(id, -32602, 'Unknown prompt.')
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
      if (prompt.arguments.some((arg) => arg.required && typeof args[arg.name] !== 'string')) return rpcError(id, -32602, 'Missing prompt argument.')
      return rpcResult(id, { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args) } }] })
    }
    return rpcError(id, -32601, `Method not found: ${String(method).slice(0, 60)}`)
  }

  /** One JSON-RPC message in, one response (or null for a notification). */
  const handleOne = async (message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return rpcError(message?.id, -32600, 'Invalid request.')
    }
    if (typeof message.method !== 'string') return null // a response from the client: nothing to do
    if (message.id === undefined || message.id === null) return null // notification
    if (typeof message.id !== 'string' && typeof message.id !== 'number') return rpcError(null, -32600, 'Invalid request id.')
    const exempt = message.method === 'initialize' || message.method === 'ping'
    if (!exempt && !(await acquire())) {
      log('request refused: queue full or timed out')
      if (message.method === 'tools/call') {
        return rpcResult(message.id, textResult('FaNotes is busy with other requests. Please retry this call in a few seconds.', true))
      }
      return rpcError(message.id, -32000, 'The server is busy. Try again in a moment.')
    }
    try {
      return await handleRequest(message)
    } catch (error) {
      log(`request ${String(message.method).slice(0, 40)} failed`)
      return rpcError(message.id, -32603, error instanceof McpError ? error.message : 'Internal error.')
    } finally {
      if (!exempt) release()
    }
  }

  /** A parsed JSON value (message or batch) in; a response value or null out. */
  const handle = async (payload) => {
    if (Array.isArray(payload)) {
      if (!payload.length || payload.length > MAX_BATCH) return rpcError(null, -32600, `Invalid batch (1 to ${MAX_BATCH} messages).`)
      const replies = []
      for (const item of payload) {
        const reply = await handleOne(item)
        if (reply) replies.push(reply)
      }
      return replies.length ? replies : null
    }
    return handleOne(payload)
  }

  /** True when the tool list a client already fetched is out of date (stdio sends list_changed). */
  const pollListChanged = async () => {
    if (listedSignature === null) return false
    let ctx = null
    try { ctx = await context() } catch { return false }
    const signature = signatureOf(ctx)
    if (signature === listedSignature) return false
    listedSignature = signature
    return true
  }

  return { handle, handleOne, pollListChanged, tools: () => [...TOOLS, ...WRITE_TOOLS], SUPPORTED_VERSIONS }
}

module.exports = { createLocalMcpServer, SUPPORTED_VERSIONS, TOOLS, WRITE_TOOLS, rpcError }
