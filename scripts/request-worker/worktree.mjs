// Git worktree + scratch-dir handling for one request.
import fs from 'node:fs'
import path from 'node:path'
import { run } from './exec.mjs'
import { SCRATCH_DIR } from './prompt.mjs'

export const isSafeId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(String(id))
export const branchFor = (id) => `request/${id}`

export function safeName(name, fallback = 'attachment') {
  const b = path.basename(String(name || fallback)).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '')
  return (b || fallback).slice(0, 80)
}

export async function createWorktree(config, id) {
  if (!isSafeId(id)) throw new Error('unsafe request id')
  const dir = path.join(config.worktreeRoot, id)
  fs.mkdirSync(config.worktreeRoot, { recursive: true, mode: 0o700 })
  const f = await run('git', ['-C', config.repoPath, 'fetch', '-q', 'origin', 'main'], { timeoutMs: 180_000 })
  if (f.code !== 0) throw new Error('git fetch fehlgeschlagen')
  if (!fs.existsSync(dir)) {
    const w = await run('git', ['-C', config.repoPath, 'worktree', 'add', '-B', branchFor(id), dir, 'origin/main'], { timeoutMs: 180_000 })
    if (w.code !== 0) throw new Error('git worktree add fehlgeschlagen: ' + w.stderr.slice(-200))
  }
  const ex = await run('git', ['-C', dir, 'rev-parse', '--git-path', 'info/exclude'])
  if (ex.code === 0) {
    const file = path.resolve(dir, ex.stdout.trim())
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const add = ['/' + SCRATCH_DIR + '/', '/node_modules', '/fanotes/node_modules'].filter((l) => !have.includes(l))
    if (add.length) fs.appendFileSync(file, (have && !have.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n')
  }
  fs.mkdirSync(path.join(dir, SCRATCH_DIR), { recursive: true })
  return dir
}

export function linkNodeModules(config, dir) {
  for (const rel of ['node_modules', 'fanotes/node_modules']) {
    const src = path.join(config.nodeModulesSrc, rel)
    const dst = path.join(dir, rel)
    try { if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst) } catch { /* best effort */ }
  }
}

// Saves fetched attachments into the scratch dir. items: [{name, mime, buffer}]. Returns [{path,label}].
export function saveAttachments(dir, items) {
  const out = []
  const scratch = path.join(dir, SCRATCH_DIR)
  fs.mkdirSync(scratch, { recursive: true })
  const used = new Set()
  for (const a of items) {
    if (!a?.buffer?.length || a.buffer.length > 4 * 1024 * 1024) continue
    let name = safeName(a.name)
    while (used.has(name)) name = '_' + name
    used.add(name)
    try {
      fs.writeFileSync(path.join(scratch, name), a.buffer)
      out.push({ path: `${SCRATCH_DIR}/${name}`, label: String(a.mime || 'file') })
    } catch { /* skip unwritable attachment */ }
  }
  return out
}

export function appendNote(dir, text) {
  const file = path.join(dir, SCRATCH_DIR, 'NOTES.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `\n## Follow-up (${new Date().toISOString()})\n${text}\n`)
}

export async function removeWorktree(config, id, { deleteBranch = false } = {}) {
  if (!isSafeId(id)) return
  const dir = path.join(config.worktreeRoot, id)
  await run('git', ['-C', config.repoPath, 'worktree', 'remove', '--force', dir])
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  await run('git', ['-C', config.repoPath, 'worktree', 'prune'])
  if (deleteBranch) await run('git', ['-C', config.repoPath, 'branch', '-D', branchFor(id)])
}
