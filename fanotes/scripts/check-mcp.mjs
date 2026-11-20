// MCP: the local MCP server (stdio + loopback HTTP) must keep working, and the
// removed remote /mcp connector must stay gone (server, nginx, app UI).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(appRoot, relative), 'utf8')

for (const file of ['mcp-api.mjs', 'mcp-grants.mjs', 'mcp-policy.mjs']) {
  assert.equal(existsSync(join(appRoot, '../fanotes-site', file)), false, `${file} is removed`)
}
assert.doesNotMatch(read('../fanotes-site/server.mjs'), /handleMcpRequest|mcp-api/u)
assert.doesNotMatch(read('../fanotes-site/sync-api.mjs'), /mcp-grants|revokeAccountAccess/u)
assert.doesNotMatch(read('../fanotes-site/deploy/fanotes-fasrv.conf'), /location[^\n]*(?:\/mcp|oauth|api\/v1\/mcp)/u)
assert.doesNotMatch(read('../fanotes-site/deploy/fanotes-site.service'), /FANOTES_MCP_DIR|fanotes-mcp/u)
assert.doesNotMatch(read('src/components/SyncSettingsSection.tsx'), /settings-mcp-remote|enableMcpConnector/u)
assert.doesNotMatch(read('src/App.tsx'), /startMcpBridge/u)
assert.equal(existsSync(join(appRoot, 'src/lib/mcp')), false, 'remote connector client is removed')
assert.match(read('src/components/McpSettingsSection.tsx'), /MCP-Server|Verbinden über HTTP/u)

const local = spawnSync(process.execPath, [join(appRoot, 'scripts/check-local-mcp.mjs')], { stdio: 'inherit', cwd: appRoot })
assert.equal(local.status, 0, 'check-local-mcp failed')
console.log('MCP: local server passed, remote connector is gone.')
