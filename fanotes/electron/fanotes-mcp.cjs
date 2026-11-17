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
  let version
  try { version = require('../package.json').version } catch { version = undefined }
  const server = createLocalMcpServer({
    version,
    // Re-read per request so switching the setting in FaNotes applies at once.
    context: () => contextFromConfigFile(userData),
    listChanged: true, // the stdio transport polls config.json and sends tools/list_changed
    log: (line) => { if (logging) process.stderr.write(`fanotes-mcp: ${line}\n`) },
  })
  await runStdio({ server })
}

/** Exit once stdout has flushed: a large reply on a pipe must not be cut off by process.exit. */
const exitAfterDrain = (code) => {
  const done = () => process.exit(code)
  try { process.stdout.write('', done) } catch { done() }
  setTimeout(done, 3000).unref()
}

module.exports = { runCli, exitAfterDrain }

if (require.main === module) {
  runCli().then(() => exitAfterDrain(0), (error) => {
    process.stderr.write(`fanotes-mcp: ${error?.message ?? 'failed'}\n`)
    exitAfterDrain(1)
  })
}
