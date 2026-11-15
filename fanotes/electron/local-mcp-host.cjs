'use strict'

// Main-process side of the local MCP server: runs the optional loopback HTTP
// transport while Settings → KI-Zugriff (MCP) has it switched on, and tells
// the settings page how a client can start the stdio server. No Electron
// import (the caller passes what it knows), so it is testable in plain Node.

const path = require('node:path')
const { createLocalMcpServer } = require('./local-mcp.cjs')
const { createHttpTransport, loadTokenStore, regenerateToken, saveTokenStore } = require('./local-mcp-transport.cjs')
const { normalizeExcluded } = require('./local-mcp-vault.cjs')

const createLocalMcpHost = ({ userData, getState, packaged = false, execPath = process.execPath, appImage = '' }) => {
  const server = createLocalMcpServer({
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
    const entry = path.join(__dirname, 'fanotes-mcp.cjs')
    return {
      httpRunning: running !== null,
      httpUrl: `http://127.0.0.1:${running ?? store.port}/mcp`,
      httpToken: store.token,
      httpError: lastError,
      stdio: {
        packaged,
        appImage,
        execPath,
        entryPath: entry,
        platform: process.platform,
        userData,
      },
    }
  }

  const regenerate = () => { regenerateToken(userData); return info() }

  return { apply, info, regenerate, stop }
}

module.exports = { createLocalMcpHost }
