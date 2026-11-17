// Configuration for the request worker. Everything comes from the environment.
// The agent token is read here and nowhere else; it is never logged.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RULES_DEFAULT = '/srv/agents/fanotes/.site-redesign-tools/study/RULES.md'

function intEnv(env, key, def, min = 1) {
  const raw = env[key]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) throw new Error(`${key} must be a number >= ${min}`)
  return n
}

export function loadConfig(env = process.env) {
  const origin = (env.FANOTES_SERVER_ORIGIN || '').trim().replace(/\/+$/, '')
  if (!origin) throw new Error('FANOTES_SERVER_ORIGIN is required')
  if (!/^https?:\/\//.test(origin)) throw new Error('FANOTES_SERVER_ORIGIN must start with http:// or https://')
  const token = env.FANOTES_AGENT_TOKEN || ''
  if (!token) throw new Error('FANOTES_AGENT_TOKEN is required (from the environment only)')
  const repoPath = env.FANOTES_REPO_PATH || '/srv/agents/fanotes/chats/writing-mode/repo'
  const worktreeRoot = env.FANOTES_WORKTREE_ROOT || '/srv/agents/fanotes/chats/requests'
  const stateDir = env.FANOTES_WORKER_STATE_DIR || path.join(worktreeRoot, '.worker')
  return {
    origin,
    token,
    repoPath,
    worktreeRoot,
    stateFile: env.FANOTES_WORKER_STATE_FILE || path.join(stateDir, 'state.json'),
    rulesPath: env.FANOTES_RULES_PATH || RULES_DEFAULT,
    budgetMs: intEnv(env, 'FANOTES_REQUEST_BUDGET_MIN', 60) * 60_000,
    maxTurns: env.FANOTES_MAX_TURNS ? intEnv(env, 'FANOTES_MAX_TURNS', 0) : null,
    model: env.FANOTES_CLAUDE_MODEL || '',
    // Optional JSON file {"<request id>": "<model>"}; read each time a run starts.
    modelOverridesPath: env.FANOTES_MODEL_OVERRIDES || path.join(os.homedir(), '.config/fanotes-request-worker/models.json'),
    claudeBin: env.FANOTES_CLAUDE_BIN || 'claude',
    ghBin: env.FANOTES_GH_BIN || 'gh',
    permissionMode: env.FANOTES_CLAUDE_PERMISSION_MODE || 'acceptEdits',
    allowedTools: env.FANOTES_CLAUDE_ALLOWED_TOOLS || 'Bash,Read,Edit,Write,Glob,Grep',
    pollIdleMs: intEnv(env, 'FANOTES_POLL_IDLE_SEC', 15) * 1000,
    pollWaitMs: intEnv(env, 'FANOTES_POLL_WAIT_SEC', 20) * 1000,
    throttleMs: intEnv(env, 'FANOTES_EVENT_THROTTLE_MS', 3000),
    ciTimeoutMs: intEnv(env, 'FANOTES_CI_TIMEOUT_MIN', 45) * 60_000,
    // How long to wait for the owner after CI is green before giving up.
    approvalTimeoutMs: intEnv(env, 'FANOTES_APPROVAL_TIMEOUT_HOURS', 72) * 3_600_000,
    nodeModulesSrc: env.FANOTES_NODE_MODULES_SRC || '/srv/agents/fanotes/chats/writing-mode/repo',
    upstreamGit: env.FANOTES_UPSTREAM_GIT || '/srv/agents/fanotes/upstream-git',
    tmpDir: env.FANOTES_TMPDIR || '/srv/agents/fanotes/.site-redesign-tools/tmp',
    gradleHome: env.FANOTES_GRADLE_HOME || '/srv/agents/fanotes/.site-redesign-tools/gradle-home',
    androidHome: env.ANDROID_HOME || '/mnt/nvme_jellyfin/android-sdk',
    verify: env.FANOTES_VERIFY !== '0',
    dryRun: env.FANOTES_WORKER_DRY_RUN === '1',
    once: env.FANOTES_WORKER_ONCE === '1',
    home: os.homedir(),
  }
}

const MODEL_NAME = /^[A-Za-z0-9._\[\]-]{1,64}$/u

// The model for one request: the override file wins over FANOTES_CLAUDE_MODEL.
// A missing, unreadable or malformed file falls back to the default.
export function modelFor(config, id) {
  try {
    const map = JSON.parse(fs.readFileSync(config.modelOverridesPath, 'utf8'))
    const value = map && typeof map === 'object' ? map[id] : undefined
    if (typeof value === 'string' && MODEL_NAME.test(value)) return value
  } catch { /* no overrides */ }
  return config.model
}

// Env for the child `claude` process: never contains the agent token.
export function childEnv(config, extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.FANOTES_AGENT_TOKEN
  env.TMPDIR = config.tmpDir
  return env
}
