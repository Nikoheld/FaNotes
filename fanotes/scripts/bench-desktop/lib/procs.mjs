// Process trees, memory and page-cache control (Linux /proc).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const read = (file) => {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

export const descendants = (rootPid) => {
  const result = [rootPid]
  for (let index = 0; index < result.length; index += 1) {
    const pid = result[index]
    let tasks = []
    try { tasks = fs.readdirSync(`/proc/${pid}/task`) } catch { continue }
    for (const task of tasks) {
      const children = read(`/proc/${pid}/task/${task}/children`)
      for (const raw of (children || '').trim().split(/\s+/u)) {
        const child = Number(raw)
        if (child && !result.includes(child)) result.push(child)
      }
    }
  }
  return result
}

const safeDescendants = (rootPid) => {
  try { return descendants(rootPid) } catch { return [rootPid] }
}

const processName = (pid) => {
  const cmdline = read(`/proc/${pid}/cmdline`)
  if (!cmdline) return null
  const parts = cmdline.split('\0').filter(Boolean)
  const exe = path.basename(parts[0] || '')
  const type = parts.find((part) => part.startsWith('--type='))
  return type ? `${exe} ${type.slice(7)}` : exe
}

/** RSS (VmRSS) and PSS (smaps_rollup) of every process of the app, in MB. */
export const memory = (rootPid) => {
  const processes = []
  for (const pid of safeDescendants(rootPid)) {
    const status = read(`/proc/${pid}/status`)
    if (!status) continue
    const rssKb = Number((status.match(/^VmRSS:\s+(\d+)/mu) || [])[1] || 0)
    const rollup = read(`/proc/${pid}/smaps_rollup`)
    const pssKb = rollup ? Number((rollup.match(/^Pss:\s+(\d+)/mu) || [])[1] || 0) : null
    processes.push({ pid, name: processName(pid), rssMb: rssKb / 1024, pssMb: pssKb === null ? null : pssKb / 1024 })
  }
  return {
    rssMb: processes.reduce((sum, item) => sum + item.rssMb, 0),
    pssMb: processes.every((item) => item.pssMb !== null) ? processes.reduce((sum, item) => sum + item.pssMb, 0) : null,
    processes,
  }
}

/** CPU time (user + system, ms) of every process of the app, from /proc/<pid>/stat. */
export const cpuTime = (rootPid) => {
  const ticksPerSecond = 100 // USER_HZ on Linux x86_64
  const processes = []
  for (const pid of safeDescendants(rootPid)) {
    const stat = read(`/proc/${pid}/stat`)
    if (!stat) continue
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    processes.push({ pid, name: processName(pid), ms: ((Number(fields[11]) + Number(fields[12])) * 1000) / ticksPerSecond })
  }
  return { ms: processes.reduce((sum, item) => sum + item.ms, 0), processes }
}

/** Every regular file the process tree has mapped (libraries, data files). */
export const mappedFiles = (rootPid) => {
  const files = new Set()
  for (const pid of safeDescendants(rootPid)) {
    for (const line of (read(`/proc/${pid}/maps`) || '').split('\n')) {
      const file = line.split(/\s+/u).slice(5).join(' ')
      if (file.startsWith('/') && !file.startsWith('/dev/') && !file.startsWith('/memfd') && !file.endsWith('(deleted)')) files.add(file)
    }
  }
  return [...files]
}

const walk = (root, out = []) => {
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export const filesUnder = (...roots) => roots.flatMap((root) => (fs.statSync(root, { throwIfNoEntry: false })?.isDirectory() ? walk(root) : fs.existsSync(root) ? [root] : []))

// posix_fadvise(DONTNEED) per file: drops only these files' clean pages from the
// page cache, so a "cold" start reads them from disk again without touching the
// rest of the (shared) machine. Node has no fadvise; python3 does.
const EVICT = 'import os,sys\nn=0\nfor p in sys.stdin.read().split("\\0"):\n  if not p: continue\n  try:\n    fd=os.open(p,os.O_RDONLY)\n    os.posix_fadvise(fd,0,0,os.POSIX_FADV_DONTNEED); os.close(fd); n+=1\n  except OSError: pass\nprint(n)'

export const evict = (files) => Number(execFileSync('python3', ['-c', EVICT], { input: files.join('\0'), encoding: 'utf8' }).trim())

/** Fraction of the files' bytes in the page cache (fincore). */
export const residency = (files) => {
  let cached = 0
  let total = 0
  for (let index = 0; index < files.length; index += 200) {
    try {
      const output = execFileSync('fincore', ['--bytes', '--noheadings', '--raw', '--output', 'RES,SIZE', ...files.slice(index, index + 200)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of output.trim().split('\n')) {
        const [res, size] = line.split(/\s+/u).map(Number)
        if (Number.isFinite(res) && Number.isFinite(size)) { cached += res; total += size }
      }
    } catch {
      // A file vanished; skip the batch.
    }
  }
  return total ? cached / total : 0
}

export const killTree = (rootPid, signal = 'SIGKILL') => {
  for (const pid of safeDescendants(rootPid).reverse()) {
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
}

export const alive = (pid) => {
  const stat = read(`/proc/${pid}/stat`)
  return Boolean(stat) && !/\) Z /u.test(stat)
}
