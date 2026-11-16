// Orchestrates one request at a time: claim -> worktree -> claude -> PR -> CI -> approval -> merge -> verify.
import fs from 'node:fs'
import path from 'node:path'
import { childEnv } from './config.mjs'
import { run } from './exec.mjs'
import { buildPrompt, SCRATCH_DIR } from './prompt.mjs'
import { createThrottle, estimatePercent } from './progress.mjs'
import { startClaude } from './runner.mjs'
import { loadState, saveState, transition, emptyState } from './state.mjs'
import { appendNote, branchFor, createWorktree, isSafeId, linkNodeModules, removeWorktree, saveAttachments } from './worktree.mjs'
import { ciState, findOpenPr } from './ci.mjs'

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_CI_FIXES = 2

export class Worker {
  constructor({ config, api, log, sleep = sleepDefault, now = () => Date.now() }) {
    Object.assign(this, { config, api, log, sleep, now })
    this.state = loadState(config.stateFile)
    this.stopping = false
    this.current = null // running claude handle
  }

  save() { saveState(this.config.stateFile, this.state) }
  go(to, patch) { this.state = transition(this.state, to, patch); this.save() }
  get id() { return this.state.requestId }
  get dir() { return path.join(this.config.worktreeRoot, this.id) }

  stop() { this.stopping = true; this.current?.kill() }

  async retry(fn, what) {
    for (let i = 0; i < 5; i++) {
      try { return await fn() } catch (e) { this.log.warn(`${what} failed (${i + 1}/5): ${e.message}`); await this.sleep(1000 * 2 ** i) }
    }
    return null
  }
  postEvent(text, extra = {}) {
    return this.api.event(this.id, { type: 'progress', text, ...extra }).catch((e) => this.log.warn('event failed: ' + e.message))
  }
  postStatus(payload) { return this.retry(() => this.api.status(this.id, payload), 'status ' + payload.status) }

  // Main loop. Returns after one request when config.once is set.
  async loop() {
    while (!this.stopping) {
      let worked = false
      try { worked = await this.processOne() } catch (e) { this.log.error('loop error: ' + e.message) }
      if (this.config.once && (worked || this.state.phase === 'idle')) return
      if (!worked) await this.sleep(this.config.pollIdleMs)
    }
  }

  async processOne() {
    if (this.state.phase === 'done' || this.state.phase === 'failed') { await this.cleanup(); this.state = emptyState(); this.save() }
    if (this.state.phase === 'idle') {
      const req = await this.api.claim()
      if (!req) return false
      if (!isSafeId(req.id)) { this.log.error('claimed request with unsafe id; ignoring'); return false }
      this.go('claimed', { requestId: req.id, request: req, startedAt: this.now(), seen: (req.messages || []).map((m) => String(m.id ?? '')), pending: [], ciFixes: 0 })
    } else this.log.info(`resuming request ${this.id} in phase ${this.state.phase}`)
    try { await this.drive() } catch (e) { await this.fail(`Interner Fehler: ${this.log.redact(e.message)}`) }
    // Stopped by SIGTERM mid-request: keep state and worktree so the next start resumes.
    if (this.stopping && !['done', 'failed'].includes(this.state.phase)) return true
    await this.cleanup()
    this.state = emptyState()
    this.save()
    return true
  }

  async fail(reason) {
    if (this.state.phase === 'done' || this.state.phase === 'failed') return
    this.log.warn(`request ${this.id} failed: ${reason}`)
    this.go('failed', { reason })
    await this.postStatus({ status: 'failed', reason })
  }

  async cleanup() {
    if (!this.id) return
    try { await removeWorktree(this.config, this.id, { deleteBranch: this.state.phase === 'done' }) } catch (e) { this.log.warn('cleanup: ' + e.message) }
  }

  budgetLeft() { return this.state.startedAt + this.config.budgetMs - this.now() }

  async drive() {
    for (;;) {
      if (this.stopping) return
      switch (this.state.phase) {
        case 'claimed':
          await this.postStatus({ status: 'picked' })
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
    const { config } = this
    await this.postEvent('Bereitet Arbeitsbereich vor', { percent: 5 })
    const dir = await createWorktree(config, this.id)
    if (!config.dryRun) linkNodeModules(config, dir)
    const attachments = saveAttachments(dir, this.state.request)
    this.state.attachments = attachments
    this.go('running', { attachments })
  }

  async identity() {
    if (this.ident !== undefined) return this.ident
    const git = (f) => run('git', ['-C', this.config.upstreamGit, 'log', '-1', `--format=${f}`, 'd83a94f9']).then((r) => (r.code === 0 ? r.stdout.trim() : ''))
    const [name, email] = await Promise.all([git('%an'), git('%ae')])
    this.ident = name && email ? { name, email } : null
    return this.ident
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
    let c
    try { c = await this.api.control(this.id) } catch (e) { this.log.warn('control poll failed: ' + e.message); return null }
    const fresh = c.messages.filter((m) => !this.state.seen.includes(m.id))
    if (fresh.length) {
      this.state.seen.push(...fresh.map((m) => m.id))
      this.state.pending.push(...fresh)
      for (const m of fresh) { try { appendNote(this.dir, m.text) } catch { /* worktree gone */ } }
      this.save()
    }
    return c
  }

  async runPhase() {
    const { config } = this
    const st = this.state
    const resumeId = st.sessionId
    const msgs = this.takePending()
    let prompt
    if (resumeId && msgs.length) prompt = buildPrompt({ resume: true, messages: msgs })
    else if (resumeId) prompt = 'The worker was restarted. Continue the task where you stopped, make sure the pull request exists, and print its URL.'
    else {
      const ident = await this.identity()
      prompt = buildPrompt({
        request: st.request, rules: (() => { try { return fs.readFileSync(config.rulesPath, 'utf8') } catch { return '' } })(),
        attachments: st.attachments || [], messages: [...(st.request.messages || []).map((m) => ({ text: String(m.text ?? '') })).filter((m) => m.text), ...msgs],
        branch: branchFor(this.id), commitIdentity: ident ? `${ident.name} <${ident.email}>` : '',
      })
    }
    let steps = st.steps || 0
    const throttle = createThrottle({ minIntervalMs: config.throttleMs, post: (p) => this.postEvent(p.text, { percent: p.percent }) })
    let outcome = { cancelled: false, timedOut: false, result: null }
    const handle = startClaude(config, {
      cwd: this.dir, env: await this.claudeEnv(), prompt, sessionId: resumeId,
      onItem: (item) => {
        if (item.kind === 'session') { if (st.sessionId !== item.id) { st.sessionId = item.id; this.save() } }
        else if (item.kind === 'pr') { if (!st.pr || st.pr.number !== item.number) { st.pr = { number: item.number, url: item.url }; this.save() } }
        else if (item.kind === 'result') outcome.result = item
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
      if (c && (c.cancelled || c.rejected)) { outcome.cancelled = true; handle.kill() }
    }, config.pollWaitMs)
    // also enforce the budget exactly, not only on poll ticks
    const budgetTimer = setTimeout(() => { outcome.timedOut = true; handle.kill() }, Math.max(0, this.budgetLeft()))
    const exit = await handle.done
    clearInterval(watcher); clearTimeout(budgetTimer)
    this.current = null
    throttle.flushNow()
    st.steps = steps
    this.save()

    if (outcome.cancelled) { await this.fail('abgebrochen'); return false }
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
    if ((this.state.pending || []).length === 0) await this.pollControl()
    if ((this.state.pending || []).length > 0 && exit.code === 0) { this.go('running'); return true }
    await this.fail(exit.code === 0 ? 'Claude hat keinen Pull Request erstellt' : `Claude-Lauf fehlgeschlagen (Exit ${exit.code ?? exit.signal})`)
    return false
  }

  // Waits for CI. Green -> waiting_for_you. Red -> let Claude fix (limited), else fail.
  async ciPhase() {
    const { config, state: st } = this
    const started = this.now()
    let last = ''
    for (;;) {
      if (this.stopping) return false
      const c = await this.pollControl()
      if (c && (c.cancelled || c.rejected)) { await this.fail('abgebrochen'); return false }
      if (this.budgetLeft() <= 0) { await this.fail('Zeitbudget überschritten'); return false }
      if (st.pending.length) { this.go('running'); return true }
      const ci = await ciState(config, this.dir, st.pr.number)
      if (ci.state !== last) {
        last = ci.state
        await this.postStatus({ status: 'pr_open', prNumber: st.pr.number, prUrl: st.pr.url, ci: ci.state })
      }
      if (ci.state === 'green') {
        await this.postEvent('CI ist grün', { percent: 95 })
        await this.postStatus({ status: 'waiting_for_you', prNumber: st.pr.number, prUrl: st.pr.url, ci: 'green' })
        this.go('waiting')
        return true
      }
      if (ci.state === 'red') {
        if (st.ciFixes >= MAX_CI_FIXES) { await this.fail(`CI fehlgeschlagen: ${ci.failed.join(', ').slice(0, 200)}`); return false }
        st.ciFixes++
        st.pending.push({ id: `ci-${st.ciFixes}`, text: `CI failed on the pull request (${ci.failed.join(', ')}). Inspect the failure with gh, fix it on the same branch and push.` })
        await this.postEvent('CI rot, Claude behebt den Fehler', { percent: 88 })
        this.go('running')
        return true
      }
      if (this.now() - started > config.ciTimeoutMs) { await this.fail('CI-Zeitlimit überschritten'); return false }
      await this.sleep(config.pollWaitMs)
    }
  }

  async waitPhase() {
    const { config, state: st } = this
    const started = this.now()
    for (;;) {
      if (this.stopping) return false
      const c = await this.pollControl()
      if (c) {
        if (c.cancelled) { await this.fail('abgebrochen'); return false }
        if (c.rejected) { this.log.info('request rejected by owner'); this.go('failed', { reason: 'rejected' }); return false }
        if (st.pending.length) { await this.postStatus({ status: 'working' }); this.go('running'); return true }
        if (c.approved) { this.go('merging'); return true }
      }
      if (this.now() - started > config.approvalTimeoutMs) { await this.fail('Keine Freigabe innerhalb des Zeitlimits'); return false }
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
      for (const step of this.verifySteps()) {
        const r = await run(step.cmd, step.args, { cwd: path.join(this.dir, step.cwd), env: await this.claudeEnv().then((e) => ({ ...e, ...step.env })), timeoutMs: 40 * 60_000 })
        if (r.code !== 0) { await this.fail(`Gemergt, aber Verifikation von main fehlgeschlagen (${step.label})`); return false }
      }
    }
    await this.postStatus({ status: 'merged', prNumber: st.pr.number, prUrl: st.pr.url })
    this.go('done')
    return true
  }
}
