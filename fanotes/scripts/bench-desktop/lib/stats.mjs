// Summary statistics and the environment record kept with every result file.
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

/** Median and spread of per-run values: min, max, and the relative half-range. */
export const summarize = (values) => {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return { n: 0, median: null, min: null, max: null, spreadPct: null }
  const median = percentile(finite, 50)
  const min = Math.min(...finite)
  const max = Math.max(...finite)
  return { n: finite.length, median, min, max, spreadPct: median ? ((max - min) / 2 / median) * 100 : null }
}

export const round = (value, digits = 1) => (Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : value)

export const loadAverage = () => os.loadavg().map((value) => round(value, 2))

const readFirst = (file) => {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/** The machine, as far as it can be seen from inside the container. */
export const machine = () => {
  const cpus = os.cpus()
  const cgroupCpu = readFirst('/sys/fs/cgroup/cpu.max').trim()
  const cgroupMemory = readFirst('/sys/fs/cgroup/memory.max').trim()
  let webkit = null
  try { webkit = execFileSync('pkg-config', ['--modversion', 'webkit2gtk-4.1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { /* not in this image */ }
  return {
    cpuModel: cpus[0]?.model ?? 'unknown',
    logicalCpus: cpus.length,
    containerCpuLimit: cgroupCpu && cgroupCpu !== 'max' ? (() => { const [quota, period] = cgroupCpu.split(' ').map(Number); return round(quota / period, 2) })() : null,
    containerMemoryLimitMb: /^\d+$/u.test(cgroupMemory) ? Math.round(Number(cgroupMemory) / 1048576) : null,
    totalMemoryMb: Math.round(os.totalmem() / 1048576),
    kernel: os.release(),
    os: (readFirst('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]*)/mu) || [])[1] ?? os.platform(),
    node: process.version,
    webkitgtk: webkit,
    hostname: os.hostname(),
  }
}
