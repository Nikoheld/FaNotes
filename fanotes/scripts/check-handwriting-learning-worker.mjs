import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { validModel, personalStyle } from '../src/lib/personalHandwriting.mjs'
const require = createRequire(import.meta.url)
const { serializeFamd } = require('../electron/famd.cjs')
const base = path.resolve(process.env.FANOTES_HANDWRITING_ARTIFACTS || '../.scratch/handwriting-evaluation')
await fs.mkdir(base, { recursive: true })
const temp = await fs.mkdtemp(path.join(base, 'worker-'))
const root = path.join(temp, 'vault'), cache = path.join(temp, 'private-model')
await fs.mkdir(root)
const raw = JSON.parse(await fs.readFile(new URL('./fixtures/iam-online-a01-001z-01.json', import.meta.url)))
const doc = { schemaVersion: 1, title: 'Ordinary page', paperStyle: 'dots', sourceWidth: raw.sourceWidth, sourceHeight: raw.sourceHeight,
  strokes: raw.strokes.map(ps => ({ points: ps.map(([x,y,t]) => ({ x,y,t,pressure:.45,tiltX:0,tiltY:0,pointerType:'pen' })), baseWidth:3.2, pressureEnabled:true, purpose:'handwriting' })) }
const file = path.join(root, 'Ordinary.famd')
await fs.writeFile(file, serializeFamd('# Ordinary page', { ink: doc }))
let worker, sequence = 0
const open = () => {
  worker = new Worker(new URL('../electron/handwriting-learning-worker.mjs', import.meta.url), { workerData: { root, cache } })
  worker.on('error', error => { throw error })
}
const request = (op = 'snapshot', value) => new Promise((resolve, reject) => {
  const id = ++sequence
  const timeout = setTimeout(() => { worker.off('message', listener); reject(Error('Worker timed out')) }, 15000)
  const listener = message => { if (message.id !== id) return; clearTimeout(timeout); worker.off('message', listener); message.error ? reject(Error(message.error)) : resolve(message.result) }
  worker.on('message', listener); worker.postMessage({ id, op, value })
})
const until = async predicate => {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) { const result = await request(); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 30)) }
  throw Error('Learning condition was not reached')
}
try {
  open()
  const first = await until(r => r.pageCount === 1 && !r.busy)
  assert(validModel(first.model)); assert(personalStyle(first.model).observations.length)
  const unchanged = await request('snapshot', { revision: first.model.revision, vaultId: first.vaultId })
  assert.equal(unchanged.model, null, 'unchanged status polls must not copy the trajectory model into the UI')
  const revision = first.model.revision
  await request('scan'); const repeated = await until(r => !r.busy)
  assert.equal(repeated.model.revision, revision, 'unchanged pages are never retrained')
  await fs.copyFile(file, path.join(root, 'Copy.famd')); await request('scan')
  assert.equal((await until(r => !r.busy)).pageCount, 1)
  await request('enabled', false)
  await worker.terminate(); open()
  assert.equal((await until(r => r.pageCount === 1)).enabled, false, 'preference and checkpoints survive restart')
  await fs.writeFile(path.join(cache, 'interrupted.json.tmp'), '{unfinished')
  await request('enabled', true)
  await fs.writeFile(file, '{broken'); await request('scan')
  assert.equal((await until(r => !r.busy)).pageCount, 1, 'malformed pages retain the last good checkpoint')
  await fs.unlink(file); await fs.unlink(path.join(root, 'Copy.famd')); await request('scan')
  assert.equal((await until(r => !r.busy)).pageCount, 0, 'deleted notes retract their data')
  // Historical .md pages contribute only while their asset reference is live.
  await fs.mkdir(path.join(root, '.fanotes/assets'), { recursive: true })
  await fs.writeFile(path.join(root, '.fanotes/assets/old-page.json'), JSON.stringify(doc))
  await fs.writeFile(path.join(root, 'Legacy.md'), '# Legacy\n<!-- fanotes-ink:old-page -->')
  await request('scan'); assert.equal((await until(r => !r.busy)).pageCount, 1)
  await fs.unlink(path.join(root, 'Legacy.md')); await request('scan')
  assert.equal((await until(r => !r.busy)).pageCount, 0, 'orphan assets cannot keep deleted pages in training')
  for (let i = 0; i < 60; i++) {
    const varied = structuredClone(doc); varied.strokes[0].points[0].pressure += i * .0001
    await fs.writeFile(path.join(root, `Page-${i}.famd`), serializeFamd('# Page', { ink: varied }))
  }
  await request('scan')
  const large = await until(r => !r.busy && r.pageCount === 60)
  assert(Object.keys(large.model.pages).length <= 48)
  assert(validModel(large.model))
  assert(large.model.population, 'every indexed page contributes to the population style center')
  console.log('Local worker: ordinary FAMD and legacy ink, incremental updates, deduplication, restart, opt-out, interruption, corruption, and deletion passed.')
} finally { if (worker) await worker.terminate(); await fs.rm(temp, { recursive: true, force: true }) }
