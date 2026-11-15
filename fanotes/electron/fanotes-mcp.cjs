#!/usr/bin/env node
'use strict'

// Stand-alone stdio entry of the local MCP server.
//   node electron/fanotes-mcp.cjs [--user-data <dir>]
//   FaNotes --mcp                              (packaged app; see main.cjs)
//   ELECTRON_RUN_AS_NODE=1 FaNotes <this file> (packaged app as plain Node)
// stdout carries only JSON-RPC; diagnostics go to stderr and never contain
// note text.

const { createLocalMcpServer } = require('./local-mcp.cjs')
const { contextFromConfigFile, defaultUserDataDir, runStdio } = require('./local-mcp-transport.cjs')

const optionValue = (argv, name) => {
  const index = argv.indexOf(name)
  return index >= 0 && typeof argv[index + 1] === 'string' ? argv[index + 1] : ''
}

const runCli = async (argv = process.argv.slice(2)) => {
  const userData = optionValue(argv, '--user-data') || defaultUserDataDir()
  const logging = process.env.FANOTES_MCP_LOG === '1'
  const server = createLocalMcpServer({
    // Re-read per request so switching the setting in FaNotes applies at once.
    context: () => contextFromConfigFile(userData),
    log: (line) => { if (logging) process.stderr.write(`fanotes-mcp: ${line}\n`) },
  })
  await runStdio({ server })
}

module.exports = { runCli }

if (require.main === module) {
  runCli().then(() => process.exit(0), (error) => {
    process.stderr.write(`fanotes-mcp: ${error?.message ?? 'failed'}\n`)
    process.exit(1)
  })
}
