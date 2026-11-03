import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { desktopLearningPolicy } from '../src/lib/desktopHandwritingPolicy.mjs'
import { validModel, personalStyle, learnPage } from '../src/lib/personalHandwriting.mjs'
import { schoolScript } from '../src/lib/schoolScript.mjs'
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
let policy = desktopLearningPolicy({cores:2,memoryBytes:4*1024**3})
const open = () => {
  worker = new Worker(new URL('../electron/handwriting-learning-worker.mjs', import.meta.url), { workerData: { root, cache, policy } })
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
  assert(Object.keys(large.model.pages).length <= policy.pages)
  assert.equal(large.model.desktop.beamWidth,8)
  assert(large.model.desktop.motions>128)
  assert(Object.values(large.model.pages).flatMap(p=>p.units).reduce((n,u)=>n+u.strokes.reduce((m,s)=>m+s.points.length,0),0)<=policy.snapshotPoints)
  assert(validModel(large.model))
  assert(large.model.population, 'every indexed page contributes to the population style center')
  await worker.terminate()
  policy = desktopLearningPolicy({cores:8,memoryBytes:16*1024**3}); open()
  const upgraded = await until(r => !r.busy && r.pageCount === 60 && r.scanned >= 60)
  assert.equal(upgraded.model.desktop.beamWidth,16,'changing policy rebuilds existing page checkpoints once')
  // A rare known word outside the active reservoir must still be available on demand.
  const word = { sourceWidth:900, sourceHeight:1273, strokes:[] }
  let time=0
  for(const [label,x,y,height] of [['h',80,80,40],['e',113,90,30]]) {
    const sample=schoolScript.find(s=>s.label===label), [bx,by,bw,bh]=sample.bbox
    word.strokes.push(...sample.strokes.map(s=>({...s,purpose:'handwriting',points:s.points.map(p=>({...p,x:(x+(p.x-bx)/bw*30)/900,y:(y+(p.y-by)/bh*height)/1273,t:time+=4}))})))
  }
  const checkpoints = await Promise.all((await fs.readdir(cache)).filter(f=>/^[a-f0-9]{64}\.json$/u.test(f)).map(async f=>JSON.parse(await fs.readFile(path.join(cache,f)))))
  const firstFingerprint=checkpoints.map(p=>p.contribution.fingerprint).sort()[0]
  for(let i=0;learnPage(word,schoolScript,policy).fingerprint<=firstFingerprint && i<100;i++) word.strokes[0].points[0].pressure+=.0001
  assert(learnPage(word,schoolScript,policy).fingerprint>firstFingerprint)
  await fs.mkdir(path.join(root,'Nested'))
  const wordFile=path.join(root,'Nested','Known-word.famd')
  await fs.writeFile(wordFile,serializeFamd('# Ordinary word',{ink:word}))
  await worker.terminate(); policy={...policy,pages:1}; open()
  const reduced=await until(r=>!r.busy && r.pageCount===61)
  assert(!personalStyle(reduced.model).units.some(u=>u.label==='he'),'fixture is outside the active reservoir')
  const retrieved=await request('retrieve',{text:'he he'})
  assert.equal(retrieved.model,null,'word lookup must not recopy the model')
  assert.equal(retrieved.requestedUnits.filter(u=>u.label==='he').length,1)
  await request('changed','Nested\\Known-word.md'); await request('scan')
  assert.equal((await until(r=>!r.busy)).scanned,reduced.scanned+1,'Windows save paths force reprocessing even if file size and timestamp are unchanged')
  await fs.writeFile(wordFile,serializeFamd('# Cleared',{ink:{...word,strokes:[]}})); await request('scan'); await until(r=>!r.busy)
  assert.equal((await request('retrieve',{text:'he'})).requestedUnits.length,0,'clearing a page retracts its vocabulary')
  await fs.writeFile(wordFile,serializeFamd('# Restored',{ink:word})); await request('scan'); await until(r=>!r.busy)
  assert((await request('retrieve',{text:'he'})).requestedUnits.some(u=>u.label==='he'))
  await fs.unlink(wordFile); await request('scan'); await until(r=>!r.busy)
  assert.equal((await request('retrieve',{text:'he'})).requestedUnits.length,0,'deleted words cannot be retrieved from stale checkpoints')
  console.log('Local worker: ordinary FAMD and legacy ink, incremental updates, deduplication, restart, opt-out, interruption, corruption, and deletion passed.')
} finally { if (worker) await worker.terminate(); await fs.rm(temp, { recursive: true, force: true }) }
