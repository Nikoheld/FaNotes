// The committed OpenAPI document is generated from the sync router.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { syncOpenApiDocument, syncOperationsFromSource } from './sync-openapi.mjs'

const source = readFileSync(new URL('./sync-api.mjs', import.meta.url), 'utf8')
const document = syncOpenApiDocument(source)
const committed = JSON.parse(readFileSync(new URL('./openapi/sync-v1.json', import.meta.url), 'utf8'))

const EXPECTED = [
  'POST /prelogin',
  'POST /register',
  'POST /login',
  'GET /account',
  'DELETE /account',
  'POST /logout',
  'POST /password',
  'GET /changes',
  'GET /integrity',
  'DELETE /devices/{deviceId}',
  'GET /files/{fileId}/revisions',
  'POST /files/{fileId}/restore',
  'POST /files/{fileId}/uploads',
  'GET /files/{fileId}/uploads/{uploadId}',
  'PATCH /files/{fileId}/uploads/{uploadId}',
  'DELETE /files/{fileId}/uploads/{uploadId}',
  'POST /files/{fileId}/uploads/{uploadId}/complete',
  'GET /files/{fileId}',
  'HEAD /files/{fileId}',
  'PUT /files/{fileId}',
  'DELETE /files/{fileId}',
]

const specKeys = () => {
  const keys = []
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of Object.keys(methods)) keys.push(`${method.toUpperCase()} ${path}`)
  }
  return keys.sort()
}

test('the OpenAPI document lists every sync route and matches the committed file', () => {
  const parsed = syncOperationsFromSource(source).map((operation) => `${operation.method} ${operation.path}`).sort()
  assert.deepEqual(parsed, [...EXPECTED].sort())
  assert.deepEqual(specKeys(), [...EXPECTED].sort())
  assert.deepEqual(document, committed)

  const literals = [...source.matchAll(/route === '(\/[^']+)' && method === '([A-Z]+)'/gu)]
  for (const match of literals) {
    assert.ok(specKeys().includes(`${match[2]} ${match[1]}`), match[0])
  }
  const patterns = [...source.matchAll(/\/\^(.+)\$\/u\.exec\(route\)/gu)].map((match) => match[1])
  assert.equal(patterns.length, 7)
  for (const pattern of patterns) {
    assert.match(pattern, /\\\/(?:files|devices)/u)
  }
  for (const key of specKeys()) {
    const [method, path] = key.split(' ')
    const operation = document.paths[path][method.toLowerCase()]
    assert.notEqual(operation.summary, 'Sync route.')
    assert.equal(JSON.stringify(operation).includes('NOTEBODY'), false)
  }
  const text = JSON.stringify(document)
  assert.equal(text.includes('Bearer '), false)
  assert.equal(text.includes('/var/lib/fanotes-sync'), false)
  const ids = new Set()
  for (const methods of Object.values(document.paths)) {
    for (const operation of Object.values(methods)) {
      assert.equal(ids.has(operation.operationId), false, operation.operationId)
      ids.add(operation.operationId)
    }
  }
})
