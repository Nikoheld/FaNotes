// Orchestration. One request at a time runs Claude (server status picked/working); requests in
// pr_open / waiting_for_you do not block the next claim, so they are served by their own job
// (CI watch, messages, approval, merge) concurrently.
//   claim(picked) -> working -> pr_open -> waiting_for_you -> (approved) merged | failed
import fs from 'node:fs'
import path from 'node:path'
import { childEnv } from './config.mjs'
import { run } from './exec.mjs'
import { buildPrompt } from './prompt.mjs'
import { createThrottle, estimatePercent } from './progress.mjs'
import { startClaude } from './runner.mjs'
import { loadJobs, saveJobs, transition } from './state.mjs'
import { appendNote, branchFor, createWorktree, isSafeId, linkNodeModules, removeWorktree, saveAttachments } from './worktree.mjs'
import { ciState, findOpenPr } from './ci.mjs'

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_CI_FIXES = 2
// Phases in which Claude may run: only one such job at a time.
const ACTIVE = new Set(['claimed', 'preparing', 'running'])
const SERVER_CI = { green: 'success', red: 'failure', pending: 'pending' }

class Job {
  constructor(w, state) {
    this.w = w
    this.state = state
    this.current = null
  }
  get config() { return this.w.config }
  get api() { return this.w.api }
  get log() { return this.w.log }
  get id() { return this.state.requestId }
  get dir() { return path.join(this.config.worktreeRoot, this.id) }
  get stopping() { return this.w.stopping }
  save() { this.w.persist() }
  go(to, patch) { this.state = transition(this.state, to, patch); this.save() }
  stop() { this.current?.kill() }
  budgetLeft() { return this.state.startedAt + this.config.budgetMs - this.w.now() }
  sleep(ms) { return this.w.sleep(ms) }

  // Posts with retries; 4xx answers (e.g. 409 for an already applied transition) are not retried.
  async retry(fn, what) {
    for (let i = 0; i < 5; i++) {
      try { return await fn() } catch (e) {
        if (e.status >= 400 && e.status < 500 && e.status !== 429) { this.log.warn(`${what} refused: ${e.message}`); return null }
        this.log.warn(`${what} failed (${i + 1}/5): ${e.message}`)
        await this.sleep(1000 * 2 ** i)
      }
    }
    return null
  }
  postEvent(text, extra = {}) { return this.api.event(this.id, { text, ...extra }).catch((e) => this.log.warn('event failed: ' + e.message)) }
  postStatus(payload) { return this.retry(() => this.api.status(this.id, payload), 'status ' + payload.status) }

  async execute() {
    if (this.state.phase !== 'claimed') this.log.info(`resuming request ${this.id} in phase ${this.state.phase}`)
    try { await this.drive() } catch (e) { await this.fail(`Interner Fehler: ${this.log.redact(e.message)}`) }
    // Stopped by SIGTERM mid-request: keep state and worktree so the next start resumes.
    if (this.stopping && !['done', 'failed'].includes(this.state.phase)) return false
    try { await removeWorktree(this.config, this.id, { deleteBranch: this.state.phase === 'done' }) } catch (e) { this.log.warn('cleanup: ' + e.message) }
    return true
  }

  async fail(reason) {
    if (this.state.phase === 'done' || this.state.phase === 'failed') return
    this.log.warn(`request ${this.id} failed: ${reason}`)
    this.go('failed', { reason })
    await this.postStatus({ status: 'failed', reason })
  }
  // The owner cancelled: the server already moved the request to `rejected`; nothing to post.
  cancelled() {
    if (this.state.phase === 'done' || this.state.phase === 'failed') return
    this.log.info(`request ${this.id} cancelled by owner`)
    this.go('failed', { reason: 'abgebrochen' })
  }

  async drive() {
    for (;;) {
      if (this.stopping) return
      switch (this.state.phase) {
        case 'claimed':
          await this.postStatus({ status: 'working' })
          this.go('preparing')
          break
        case 'preparing': await this.prepare(); break
        case 'running': if (!(await this.runPhase())) return; break
        case 'pr_open': if (!(await this.ciPhase())) return; break
        case 'waiting': if (!(await this.waitPhase())) return; break
        case 'merging': if (!(await this.mergePhase())) return; break
        case 'verifying': if (!(await this.verifyPhase())) return; break
        default: return
      }
      if (this.state.phase === 'done' || this.state.phase === 'failed') return
    }
  }

  async prepare() {
    const { config, state: st } = this
    await this.postEvent('Bereitet Arbeitsbereich vor', { percent: 5 })
    const dir = await createWorktree(config, this.id)
    if (!config.dryRun) linkNodeModules(config, dir)
    const items = []
    const grab = async (name, file, mime) => {
      try { items.push({ name: file, mime, buffer: await this.api.attachment(this.id, name) }) } catch (e) { this.log.warn(`attachment ${name}: ${e.message}`) }
    }
    if (st.request.screenshot) await grab('screenshot', st.request.screenshot === 'image/jpeg' ? 'screenshot.jpg' : 'screenshot.png', st.request.screenshot)
    if (st.request.hasLogs) await grab('logs', 'logs.txt', 'text/plain')
    st.attachments = saveAttachments(dir, items)
    await this.pollControl() // messages sent while the request was queued
    this.go('running')
  }

  async identity() {
    if (this.w.ident !== undefined) return this.w.ident
    const git = (f) => run('git', ['-C', this.config.upstreamGit, 'log', '-1', `--format=${f}`, 'd83a94f9']).then((r) => (r.code === 0 ? r.stdout.trim() : ''))
    const [name, email] = await Promise.all([git('%an'), git('%ae')])
    this.w.ident = name && email ? { name, email } : null
    return this.w.ident
  }

  async claudeEnv() {
    const extra = {}
    const id = await this.identity()
    if (id) Object.assign(extra, { GIT_AUTHOR_NAME: id.name, GIT_COMMITTER_NAME: id.name, GIT_AUTHOR_EMAIL: id.email, GIT_COMMITTER_EMAIL: id.email })
    return childEnv(this.config, extra)
  }

  takePending() {
    const msgs = this.state.pending || []
    this.state.pending = []
    this.save()
    return msgs
  }

  // Pulls owner control info; stores new messages as pending and in the NOTES file.
  async pollControl() {
    const st = this.state
    let c
    try { c = await this.api.control(this.id, st.afterSeq || 0) } catch (e) { this.log.warn('control poll failed: ' + e.message); return null }
    const fresh = c.messages.filter((m) => !st.seen.includes(m.id))
    if (fresh.length) {
      st.seen.push(...fresh.map((m) => m.id))
      st.pending.push(...fresh)
      const seqs = fresh.map((m) => Number(m.id)).filter(Number.isFinite)
      if (seqs.length) st.afterSeq = Math.max(st.afterSeq || 0, ...seqs)
      for (const m of fresh) { try { appendNote(this.dir, m.text) } catch { /* worktree gone */ } }
      this.save()
    }
    return c
  }

  async runPhase() {
    const { config, state: st } = this
    const resumeId = st.sessionId
    const msgs = this.takePending()
    let prompt
    if (resumeId && msgs.length) prompt = buildPrompt({ resume: true, messages: msgs })
    else if (resumeId) prompt = 'The worker was restarted. Continue the task where you stopped, make sure the pull request exists, and print its URL.'
    else {
      const ident = await this.identity()
      prompt = buildPrompt({
        request: st.request, rules: (() => { try { return fs.readFileSync(config.rulesPath, 'utf8') } catch { return '' } })(),
        attachments: st.attachments || [], messages: msgs,
        branch: branchFor(this.id), commitIdentity: ident ? `${ident.name} <${ident.email}>` : '',
      })
    }
    let steps = st.steps || 0
    const throttle = createThrottle({ minIntervalMs: config.throttleMs, post: (p) => this.postEvent(p.text, { percent: p.percent }) })
    const outcome = { cancelled: false, timedOut: false }
    const handle = startClaude(config, {
      cwd: this.dir, env: await this.claudeEnv(), prompt, sessionId: resumeId,
      onItem: (item) => {
        if (item.kind === 'session') { if (st.sessionId !== item.id) { st.sessionId = item.id; this.save() } }
        else if (item.kind === 'pr') { if (!st.pr || st.pr.number !== item.number) { st.pr = { number: item.number, url: item.url }; this.save() } }
        else if (item.kind === 'progress') {
          if (item.tool) steps++
          throttle.push({ text: item.text, percent: estimatePercent(steps) }, !!item.important)
        }
      },
    })
    this.current = handle
    const watcher = setInterval(async () => {
      if (outcome.cancelled || outcome.timedOut) return
      if (this.budgetLeft() <= 0) { outcome.timedOut = true; handle.kill(); return }
      const c = await this.pollControl()
      if (c?.cancelled) { outcome.cancelled = true; handle.kill() }
    }, config.pollWaitMs)
    const budgetTimer = setTimeout(() => { outcome.timedOut = true; handle.kill() }, Math.max(0, this.budgetLeft()))
    const exit = await handle.done
    clearInterval(watcher); clearTimeout(budgetTimer)
    this.current = null
    throttle.flushNow()
    st.steps = steps
    this.save()

    if (outcome.cancelled) { this.cancelled(); return false }
    if (outcome.timedOut) { await this.fail('Zeitbudget überschritten'); return false }
    if (this.stopping) return false
    const pr = st.pr || (await findOpenPr(config, this.dir, branchFor(this.id)))
    if (pr) {
      st.pr = pr
      await this.postStatus({ status: 'pr_open', prNumber: pr.number, prUrl: pr.url, ci: 'pending' })
      await this.postEvent(`Erstellt PR #${pr.number}`, { percent: 90 })
      this.go('pr_open', { pr })
      return true
    }
    const c = (this.state.pending || []).length === 0 ? await this.pollControl() : null
    if (c?.cancelled) { this.cancelled(); return false }
    if ((this.state.pending || []).length > 0 && exit.code === 0) { this.go('running'); return true }
    await this.fail(exit.code === 0 ? 'Claude hat keinen Pull Request erstellt' : `Claude-Lauf fehlgeschlagen (Exit ${exit.code ?? exit.signal})`)
    return false
  }

  // Waits for CI. Green -> waiting_for_you. Red -> let Claude fix (limited), else fail.
  async ciPhase() {
    const { config, state: st } = this
    const started = this.w.now()
    for (;;) {
      if (this.stopping) return false
      const c = await this.pollControl()
      if (c?.cancelled) { this.cancelled(); return false }
      if (this.budgetLeft() <= 0) { await this.fail('Zeitbudget überschritten'); return false }
      if (st.pending.length) { await this.postStatus({ status: 'working' }); this.go('running'); return true }
      const ci = await ciState(config, this.dir, st.pr.number)
      if (ci.state === 'green') {
        await this.postEvent('CI ist grün', { percent: 95 })
        await this.postStatus({ status: 'waiting_for_you', prNumber: st.pr.number, prUrl: st.pr.url, ci: SERVER_CI.green })
        this.go('waiting')
        return true
      }
      if (ci.state === 'red') {
        if (st.ciFixes >= MAX_CI_FIXES) { await this.fail(`CI fehlgeschlagen: ${ci.failed.join(', ').slice(0, 200)}`); return false }
        st.ciFixes++
        st.pending.push({ id: `ci-${st.ciFixes}`, text: `CI failed on the pull request (${ci.failed.join(', ')}). Inspect the failure with gh, fix it on the same branch and push.` })
        await this.postEvent('CI rot, Claude behebt den Fehler', { percent: 88 })
        await this.postStatus({ status: 'working' })
        this.go('running')
        return true
      }
      if (this.w.now() - started > config.ciTimeoutMs) { await this.fail('CI-Zeitlimit überschritten'); return false }
      await this.sleep(config.pollWaitMs)
    }
  }

  async waitPhase() {
    const { config, state: st } = this
    const started = this.w.now()
    for (;;) {
      if (this.stopping) return false
      const c = await this.pollControl()
      if (c) {
        if (c.cancelled) { this.cancelled(); return false }
        // The server never resets `approved`, so an approval wins over follow-up messages.
        if (c.approved) { this.go('merging'); return true }
        if (st.pending.length) { await this.postStatus({ status: 'working' }); this.go('running'); return true }
      }
      if (this.w.now() - started > config.approvalTimeoutMs) { await this.fail('Keine Freigabe innerhalb des Zeitlimits'); return false }
      await this.sleep(config.pollWaitMs)
    }
  }

  async mergePhase() {
    const { config, state: st } = this
    const ci = await ciState(config, this.dir, st.pr.number)
    if (ci.state !== 'green') { await this.fail(`Nicht gemergt: CI ist nicht grün (${ci.state})`); return false }
    await this.postEvent('Merged den Pull Request', { percent: 96 })
    const r = await run(config.ghBin, ['pr', 'merge', String(st.pr.number), '--merge'], { cwd: this.dir, timeoutMs: 120_000 })
    if (r.code !== 0) { await this.fail('Merge fehlgeschlagen: ' + this.log.redact(r.stderr.trim().slice(-200))); return false }
    this.go('verifying')
    return true
  }

  verifySteps() {
    const { config } = this
    const gradleEnv = { GRADLE_USER_HOME: config.gradleHome, GRADLE_RO_DEP_CACHE: path.join(config.home, '.gradle/caches'), ANDROID_HOME: config.androidHome }
    return [
      { label: 'tsc', cmd: 'npx', args: ['tsc', '-p', 'tsconfig.app.json', '--noEmit'], cwd: 'fanotes', env: {} },
      { label: 'Android-Tests', cmd: './gradlew', cwd: 'android', env: gradleEnv,
        args: ['--no-daemon', '-Dorg.gradle.jvmargs=-Xmx1536m', '-Pkotlin.compiler.execution.strategy=in-process', ':core:test', ':app:compileDebugKotlin'] },
    ]
  }

  async verifyPhase() {
    const { config, state: st } = this
    await this.postEvent('Prüft main (tsc und Android-Tests)', { percent: 98 })
    if (config.verify && !config.dryRun) {
      const f = await run('git', ['-C', this.dir, 'fetch', '-q', 'origin', 'main'], { timeoutMs: 180_000 })
      const co = f.code === 0 ? await run('git', ['-C', this.dir, 'checkout', '-q', '--detach', 'origin/main']) : f
      if (co.code !== 0) { await this.fail('Verifikation: main konnte nicht geladen werden'); return false }
      const env = await this.claudeEnv()
      for (const step of this.verifySteps()) {
        const r = await run(step.cmd, step.args, { cwd: path.join(this.dir, step.cwd), env: { ...env, ...step.env }, timeoutMs: 40 * 60_000 })
        if (r.code !== 0) { await this.fail(`Gemergt, aber Verifikation von main fehlgeschlagen (${step.label})`); return false }
      }
    }
    await this.postStatus({ status: 'merged', prNumber: st.pr.number, prUrl: st.pr.url })
    this.go('done')
    return true
  }
}

export class Worker {
  constructor({ config, api, log, sleep = sleepDefault, now = () => Date.now() }) {
    Object.assign(this, { config, api, log, sleep, now })
    this.jobs = new Map() // requestId -> Job
    this.running = new Set() // promises of running jobs
    this.stopping = false
    for (const [id, st] of Object.entries(loadJobs(config.stateFile))) if (isSafeId(id)) this.jobs.set(id, new Job(this, st))
  }

  persist() { saveJobs(this.config.stateFile, Object.fromEntries([...this.jobs].map(([id, j]) => [id, j.state]))) }
  stop() { this.stopping = true; for (const j of this.jobs.values()) j.stop() }
  get phases() { return [...this.jobs.values()].map((j) => j.state.phase) }

  start(job) {
    this.jobs.set(job.id, job)
    this.persist()
    const p = job.execute().then((finished) => {
      if (finished) { this.jobs.delete(job.id); this.persist() }
    }).catch((e) => this.log.error('job error: ' + e.message)).finally(() => this.running.delete(p))
    this.running.add(p)
  }

  async loop() {
    for (const job of this.jobs.values()) this.start(job) // resume after a crash
    let claimedAny = false
    while (!this.stopping) {
      try {
        // The server refuses to claim while another request is picked/working; mirror that locally.
        if (!this.phases.some((p) => ACTIVE.has(p))) {
          const { request, busy } = await this.api.claim()
          if (request) {
            if (!isSafeId(request.id)) this.log.error('claimed request with unsafe id; ignoring')
            else {
              claimedAny = true
              this.start(new Job(this, { phase: 'claimed', requestId: request.id, request, startedAt: this.now(), seen: [], pending: [], ciFixes: 0, afterSeq: 0 }))
            }
          } else if (busy) this.log.info('server reports busy')
        }
      } catch (e) { this.log.error('claim error: ' + e.message) }
      if (this.config.once && this.jobs.size === 0 && (claimedAny || !this.config.onceWait)) break
      await this.sleep(this.config.pollIdleMs)
    }
    await Promise.all([...this.running])
  }
}
