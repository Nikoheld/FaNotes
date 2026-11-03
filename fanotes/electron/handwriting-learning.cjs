'use strict'
const { Worker } = require('node:worker_threads')
const path = require('node:path')
const crypto = require('node:crypto')
const os = require('node:os')
const { desktopLearningPolicy } = require('../src/lib/desktopHandwritingPolicy.mjs')
let current = null, nextId = 0
function start(root, userData) {
  if (current?.root === root) return current
  if (current) { for (const task of current.tasks.values()) task.reject(Error('Vault changed')); void current.worker.terminate() }
  const cache = path.join(userData, 'personal-handwriting-v2', crypto.createHash('sha256').update(root).digest('hex'))
  const policy = desktopLearningPolicy({ cores: os.availableParallelism?.() ?? os.cpus().length, memoryBytes: os.totalmem() })
  const worker = new Worker(path.join(__dirname, 'handwriting-learning-worker.mjs'), { workerData: { root, cache, userData, policy }, resourceLimits: { maxOldGenerationSizeMb: policy.heapMb } })
  worker.unref()
  const state = { root, worker, tasks: new Map() }; current = state
  worker.on('message', ({ id, result, error }) => {
    const task = state.tasks.get(id); if (!task) return
    clearTimeout(task.timer); state.tasks.delete(id)
    if (error) task.reject(Error(error)); else task.resolve(result)
  })
  worker.on('error', () => { for (const task of state.tasks.values()) { clearTimeout(task.timer); task.reject(Error('Local learner stopped; retry to resume.')) }; state.tasks.clear(); if (current === state) current = null })
  worker.on('exit', () => { for (const task of state.tasks.values()) { clearTimeout(task.timer); task.reject(Error('Local learning stopped.')) }; state.tasks.clear(); if (current === state) current = null })
  return state
}
module.exports.request = (root, userData, op = 'snapshot', value) => {
  const state = start(root, userData), id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.tasks.delete(id); reject(Error('Local learner is busy; retry.')) }, 30000)
    timer.unref()
    state.tasks.set(id, { resolve, reject, timer }); state.worker.postMessage({ id, op, value })
  })
}
module.exports.stop = () => { if (current) void current.worker.terminate(); current = null }
