// How much slower than an idle machine this host runs parallel work right now (1 = idle).
//
// Timing budgets in the recognition checks are written for an idle machine. On a shared CI runner or a developer
// box with other builds running, wall-clock time stretches by the share of CPU the process does not get, while
// the work done is the same. Measure that share (wall time per CPU millisecond that busy threads, one per core,
// actually received) and scale the budgets by it, instead of raising the limits for everybody. Never below 1,
// so an idle host keeps the strict budget; capped so a stuck machine still fails.
import os from 'node:os'
import { Worker } from 'node:worker_threads'

const spin = `
const { parentPort, workerData } = require('node:worker_threads')
const start = process.threadCpuUsage()
const wallStart = process.hrtime.bigint()
let sink = 0
for (;;) {
  for (let index = 0; index < 20000; index += 1) sink += Math.sqrt(index)
  const used = process.threadCpuUsage(start)
  if ((used.user + used.system) / 1000 >= workerData.cpuMs) break
}
const used = process.threadCpuUsage(start)
parentPort.postMessage({ wallMs: Number(process.hrtime.bigint() - wallStart) / 1e6, cpuMs: Math.max(1, (used.user + used.system) / 1000), sink })
`

export const measureHostContention = async ({ cpuMs = 80, cap = 6 } = {}) => {
  const threads = Math.max(2, os.availableParallelism?.() ?? os.cpus().length)
  const runs = await Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
    const worker = new Worker(spin, { eval: true, workerData: { cpuMs } })
    worker.once('message', resolve)
    worker.once('error', reject)
  })))
  const factors = runs.map((run) => run.wallMs / run.cpuMs).sort((a, b) => a - b)
  return Math.min(cap, Math.max(1, factors[Math.floor(factors.length / 2)]))
}
