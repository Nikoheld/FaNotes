'use strict'

// Main-process side of the local MCP server: runs the optional loopback HTTP
// transport while Settings → KI-Zugriff (MCP) has it switched on, and tells
// the settings page how a client can start the stdio server. No Electron
// import (the caller passes what it knows), so it is testable in plain Node.

const fs = require('node:fs')
const path = require('node:path')
const { createLocalMcpServer } = require('./local-mcp.cjs')
const { createHttpTransport, loadTokenStore, regenerateToken, saveTokenStore } = require('./local-mcp-transport.cjs')
const { normalizeExcluded } = require('./local-mcp-vault.cjs')

// Files a headless `ELECTRON_RUN_AS_NODE=1 <AppImage> <copy>/fanotes-mcp.cjs` start needs. An AppImage
// is a squashfs mount that only exists while the image runs, so the entry is copied next to the
// user data, where a client can point at it (and the path survives updates of the AppImage).
const MCP_RUNTIME_FILES = [
  'fanotes-mcp.cjs', 'local-mcp.cjs', 'local-mcp-transport.cjs', 'local-mcp-vault.cjs', 'local-mcp-host.cjs',
  'german-search.cjs', 'famd.cjs', 'famdV2.mjs', 'famdPack.mjs', 'noteAnnotation.mjs',
]

/** Copies the stdio server files to `<userData>/mcp`; returns the entry path, or '' when that failed. */
const syncMcpRuntime = (userData, sourceDir = __dirname) => {
  const target = path.join(userData, 'mcp')
  try {
    fs.mkdirSync(target, { recursive: true })
    for (const name of MCP_RUNTIME_FILES) {
      const from = path.join(sourceDir, name)
      const to = path.join(target, name)
      const data = fs.readFileSync(from)
      let same = false
      try { same = data.equals(fs.readFileSync(to)) } catch { same = false }
      if (!same) fs.writeFileSync(to, data)
    }
    return path.join(target, 'fanotes-mcp.cjs')
  } catch {
    return ''
  }
}

const createLocalMcpHost = ({ userData, getState, packaged = false, execPath = process.execPath, appImage = '', version }) => {
  const server = createLocalMcpServer({
    version,
    context: () => {
      const state = getState()
      return {
        enabled: state.settings.mcpEnabled === true && Boolean(state.vaultPath),
        writeAccess: state.settings.mcpWriteAccess === true,
        vaultPath: state.vaultPath ?? '',
        excludedFolders: normalizeExcluded(state.settings.mcpExcludedFolders),
      }
    },
  })
  let transport = null
  let running = null
  let starting = Promise.resolve()
  let lastError = ''

  const stop = async () => {
    const current = transport
    transport = null
    running = null
    if (current) await current.close()
  }

  const start = async () => {
    const store = loadTokenStore(userData)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = createHttpTransport({ server, getToken: () => loadTokenStore(userData).token, port: attempt === 0 ? store.port : 0 })
      try {
        const port = await candidate.listen()
        if (port !== store.port) saveTokenStore(userData, { ...loadTokenStore(userData), port })
        transport = candidate
        running = port
        lastError = ''
        return
      } catch (error) {
        await candidate.close()
        lastError = error?.code === 'EADDRINUSE' ? 'port busy' : 'could not start'
      }
    }
  }

  /** Starts or stops the HTTP transport to match the settings. Serialised. */
  const apply = (settings) => {
    const wanted = settings.mcpEnabled === true && settings.mcpHttpEnabled === true
    starting = starting.catch(() => {}).then(async () => {
      if (wanted && !transport) await start()
      else if (!wanted && transport) await stop()
    })
    return starting
  }

  const info = () => {
    const store = loadTokenStore(userData)
    let entry = path.join(__dirname, 'fanotes-mcp.cjs')
    let copied = false
    if (appImage) {
      const copy = syncMcpRuntime(userData)
      if (copy) { entry = copy; copied = true }
    }
    return {
      httpRunning: running !== null,
      httpUrl: `http://127.0.0.1:${running ?? store.port}/mcp`,
      // The token itself never leaves the main process through info(); see revealToken().
      httpTokenHint: store.token ? `${store.token.slice(0, 6)}…${store.token.slice(-4)}` : '',
      httpError: lastError,
      stdio: {
        packaged,
        appImage,
        execPath,
        entryPath: entry,
        copied,
        platform: process.platform,
        userData,
      },
    }
  }

  const regenerate = () => { regenerateToken(userData); return info() }

  /** One-shot reveal for an explicit "show / copy token" action. */
  const revealToken = () => ({ token: loadTokenStore(userData).token })

  return { apply, info, regenerate, revealToken, stop }
}

module.exports = { createLocalMcpHost, syncMcpRuntime, MCP_RUNTIME_FILES }
