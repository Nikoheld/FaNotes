// OpenAPI document for the sync router. Paths and methods are read from
// sync-api.mjs, so a new route shows up here instead of in a second list.
import { readFileSync } from 'node:fs'

const PUBLIC = new Set(['POST /prelogin', 'POST /register', 'POST /login'])

const SUMMARY = {
  'POST /prelogin': 'Return the KDF parameters for a username or an email.',
  'POST /register': 'Create an account and a device session.',
  'POST /login': 'Open a device session.',
  'GET /account': 'Return the account, its devices, and its usage.',
  'DELETE /account': 'Delete the account after the auth key is checked.',
  'POST /username': 'Claim a unique username for an account that has none, and publish its sharing key. Cannot be changed later.',
  'POST /email': 'Add or replace the optional recovery e-mail. The current auth key is required.',
  'POST /userkey': 'Publish the sharing public key once for an account that has a username but no key.',
  'POST /logout': 'End this session.',
  'POST /password': 'Replace the auth key and sign out every other session.',
  'GET /changes': 'List file-table entries newer than a revision.',
  'GET /integrity': 'Report ciphertext hashes and orphans. Reads only.',
  'DELETE /devices/{deviceId}': 'Remove one device and its sessions.',
  'GET /files/{fileId}/revisions': 'List archived revisions of one file.',
  'POST /files/{fileId}/restore': 'Put an archived revision back as the live blob.',
  'POST /files/{fileId}/uploads': 'Start a resumable upload. The live note is unchanged.',
  'GET /files/{fileId}/uploads/{uploadId}': 'Return how many bytes a partial upload has stored.',
  'PATCH /files/{fileId}/uploads/{uploadId}': 'Append one chunk at the current offset.',
  'DELETE /files/{fileId}/uploads/{uploadId}': 'Drop a partial upload. The live note stays.',
  'POST /files/{fileId}/uploads/{uploadId}/complete': 'Store the partial only when its size, checksum, and merge guard accept it.',
  'GET /files/{fileId}': 'Download one ciphertext blob.',
  'HEAD /files/{fileId}': 'Return the blob headers without the body.',
  'PUT /files/{fileId}': 'Store one ciphertext blob when the base revision and the merge guard accept it.',
  'DELETE /files/{fileId}': 'Tombstone one file. The previous blob is archived first.',
}

const openApiPath = (body) => body
  .replace(/\\\//gu, '/')
  .replace(/\(\[a-f0-9\]\{64\}\)/gu, '{fileId}')
  .replace(/\(\[a-f0-9\]\{32\}\)/gu, '{uploadId}')
  .replace(/\(\[a-f0-9\]\{24\}\)/gu, '{deviceId}')

/** Routes the sync router actually dispatches. `source` is the text of sync-api.mjs. */
export const syncOperationsFromSource = (source) => {
  const router = source.slice(source.indexOf('export const handleSyncRequest'))
  const operations = []
  const patterns = new Map()
  let inFile = false
  for (const line of router.split('\n')) {
    const literal = /route === '(\/[^']*)' && method === '([A-Z]+)'/u.exec(line)
    if (literal) {
      operations.push({ method: literal[2], path: literal[1] })
      continue
    }
    const named = /const (\w+) = \/\^(.+)\$\/u\.exec\(route\)/u.exec(line)
    if (named) {
      patterns.set(named[1], openApiPath(named[2]))
      continue
    }
    const single = /if \((\w+) && method === '([A-Z]+)'\)/u.exec(line)
    if (single && patterns.has(single[1])) {
      operations.push({ method: single[2], path: patterns.get(single[1]) })
      continue
    }
    if (/if \(fileMatch\)/u.test(line)) {
      inFile = true
      continue
    }
    if (!inFile) continue
    for (const match of line.matchAll(/method === '([A-Z]+)'/gu)) {
      operations.push({ method: match[1], path: patterns.get('fileMatch') })
    }
    if (line.includes('fail(404')) inFile = false
  }
  return operations
}

const parameter = (ref) => ({ $ref: `#/components/parameters/${ref}` })

const pathParameters = (path) => [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => parameter(match[1]))

const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
})

const operationObject = (operation) => {
  const key = `${operation.method} ${operation.path}`
  const parameters = [...pathParameters(operation.path), parameter('requestId')]
  if (operation.path === '/changes') parameters.push(parameter('since'))
  if (['PUT', 'DELETE'].includes(operation.method) && operation.path === '/files/{fileId}') parameters.push(parameter('ifMatch'))
  if (operation.method === 'POST' && (operation.path.endsWith('/restore') || operation.path.endsWith('/complete'))) parameters.push(parameter('ifMatch'))
  if (operation.method === 'PUT' || operation.path.endsWith('/complete') || operation.path === '/files/{fileId}/uploads') {
    parameters.push(parameter('meta'), parameter('sha256'), parameter('blank'), parameter('clear'))
  }
  if (operation.method === 'DELETE' && operation.path === '/files/{fileId}') parameters.push(parameter('confirmDelete'))
  if (operation.method === 'PATCH') parameters.push(parameter('uploadOffset'))
  const spec = {
    operationId: operation.method.toLowerCase() + operation.path.replace(/\{|\}/gu, '').replace(/\/(.)/gu, (_, letter) => letter.toUpperCase()),
    summary: SUMMARY[key] || 'Sync route.',
    parameters,
    responses: {
      default: errorResponse('An error object. The text is a fixed sentence, with no note body.'),
    },
  }
  if (!PUBLIC.has(key)) spec.security = [{ bearerAuth: [], accountHeader: [] }]
  else spec.security = []
  if (operation.method === 'PUT' || operation.method === 'PATCH') {
    spec.requestBody = {
      required: true,
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary', description: 'Ciphertext. The server does not interpret it.' } } },
    }
  }
  if (operation.method === 'POST' && operation.path === '/files/{fileId}/uploads') {
    spec.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadCreate' } } } }
  }
  if (operation.method === 'POST' && ['/register', '/login', '/password', '/prelogin'].includes(operation.path)) {
    const schema = operation.path === '/prelogin' ? 'PreloginRequest' : operation.path === '/password' ? 'PasswordRequest' : operation.path === '/register' ? 'RegisterRequest' : 'SessionRequest'
    spec.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } } }
  }
  if (operation.method === 'POST' && ['/username', '/email', '/userkey'].includes(operation.path)) {
    spec.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/IdentityRequest' } } } }
  }
  if (operation.method === 'DELETE' && operation.path === '/account') {
    spec.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthKeyBody' } } } }
  }
  if (operation.path.endsWith('/restore')) {
    spec.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RestoreRequest' } } } }
  }
  const success = successResponse(operation)
  spec.responses[success.status] = success.body
  if (operation.method === 'PUT' || operation.method === 'PATCH' || operation.path.endsWith('/complete') || operation.path.endsWith('/restore') || operation.method === 'DELETE' && operation.path === '/files/{fileId}') {
    spec.responses['409'] = {
      description: 'stale: the base revision is not current. guard: the body would replace a note with an empty or collapsed one. The live blob is unchanged.',
      headers: { 'X-FaNotes-Rejected': { schema: { type: 'string', enum: ['guard'] } } },
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } },
    }
  }
  return spec
}

const successResponse = (operation) => {
  if (operation.method === 'GET' && operation.path === '/files/{fileId}') {
    return { status: '200', body: { description: 'The ciphertext.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } }
  }
  if (operation.method === 'HEAD' || operation.method === 'POST' && ['/logout', '/password'].includes(operation.path) || operation.method === 'DELETE') {
    return { status: operation.method === 'HEAD' ? '200' : '204', body: { description: 'No body.' } }
  }
  if (operation.method === 'GET' && operation.path === '/changes') {
    return { status: '200', body: { description: 'A page of file-table entries.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Changes' } } } } }
  }
  if (operation.method === 'GET' && operation.path === '/integrity') {
    return { status: '200', body: { description: 'A read-only integrity report. It contains hashes and ids, not note bytes or metadata.', content: { 'application/json': { schema: { $ref: '#/components/schemas/IntegrityReport' } } } } }
  }
  if (operation.method === 'GET' && operation.path === '/account') {
    return { status: '200', body: { description: 'The account summary.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } } } }
  }
  if (operation.method === 'GET' && operation.path.endsWith('/revisions')) {
    return { status: '200', body: { description: 'Archived revisions.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RevisionList' } } } } }
  }
  if (operation.path.includes('/uploads/') && operation.method !== 'POST') {
    return { status: '200', body: { description: 'The partial upload.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Upload' } } } } }
  }
  if (operation.method === 'POST' && operation.path === '/files/{fileId}/uploads') {
    return { status: '201', body: { description: 'The upload id and a zero offset.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Upload' } } } } }
  }
  if (operation.method === 'POST' && operation.path === '/register') {
    return { status: '201', body: { description: 'The new session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } } }
  }
  if (operation.method === 'POST' && operation.path === '/login') {
    return { status: '200', body: { description: 'The device session.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } } }
  }
  if (operation.method === 'POST' && operation.path === '/prelogin') {
    return { status: '200', body: { description: 'KDF parameters. Unknown emails receive a stable fake salt.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Prelogin' } } } } }
  }
  if (operation.method === 'PUT' || operation.path.endsWith('/complete') || operation.path.endsWith('/restore')) {
    return { status: '200', body: { description: 'The new file revision. The body is stored only after the guard accepts it.', content: { 'application/json': { schema: { $ref: '#/components/schemas/WriteResult' } } } } }
  }
  return { status: '200', body: { description: 'The result.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } }
}

const hexParam = (name, length, description) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', pattern: `^[a-f0-9]{${length}}$` },
})

const headerParam = (name, description, required = false) => ({
  name,
  in: 'header',
  required,
  description,
  schema: { type: 'string' },
})

export const buildSyncOpenApi = (operations) => {
  const paths = {}
  const order = ['get', 'head', 'post', 'put', 'patch', 'delete']
  for (const operation of operations) {
    const method = operation.method.toLowerCase()
    paths[operation.path] ??= {}
    paths[operation.path][method] = operationObject(operation)
  }
  const sortedPaths = {}
  for (const path of Object.keys(paths).sort()) {
    const methods = {}
    for (const method of order) if (paths[path][method]) methods[method] = paths[path][method]
    sortedPaths[path] = methods
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'FaNotes Sync API',
      version: '1',
      description: 'End-to-end encrypted file sync. Bodies and X-FaNotes-Meta are ciphertext. The server stores a scrypt hash of the auth key and never sees a password, a note, a file name, or the vault key. File ids are 64 hex characters. A write that would replace a newer note with an empty or collapsed body is refused.',
    },
    servers: [{ url: 'https://fanotes.fasrv.ch/api/v1/sync' }],
    tags: [{ name: 'sync' }],
    paths: sortedPaths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        accountHeader: { type: 'apiKey', in: 'header', name: 'X-FaNotes-Account' },
      },
      parameters: {
        fileId: hexParam('fileId', 64, 'HMAC of the file path, as 64 hex characters.'),
        uploadId: hexParam('uploadId', 32, 'Id of one partial upload.'),
        deviceId: hexParam('deviceId', 24, 'Id of one device.'),
        requestId: headerParam('X-Request-Id', 'Optional client id, 8 to 64 characters of letters, digits, dot, underscore, or hyphen. A value that repeats the token or metadata is ignored.'),
        since: { name: 'since', in: 'query', required: false, description: 'Return entries with a higher revision.', schema: { type: 'integer', minimum: 0 } },
        ifMatch: headerParam('If-Match', 'The file revision this write is based on.', true),
        meta: headerParam('X-FaNotes-Meta', 'Encrypted file metadata, base64. The server does not read it.', true),
        sha256: headerParam('X-FaNotes-Sha256', 'Hex SHA-256 of the ciphertext.', true),
        blank: headerParam('X-FaNotes-Blank', '1 when the client says the note is empty, 0 when it still has content.'),
        clear: headerParam('X-FaNotes-Clear', '1 is the only header that may store an empty or collapsed body over a note.'),
        confirmDelete: headerParam('X-FaNotes-Delete', 'Must be 1. A delete without it does not tombstone the file.', true),
        uploadOffset: headerParam('Upload-Offset', 'Must equal the number of bytes already stored for this upload.', true),
      },
      schemas: {
        Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, reason: { type: 'string' } } },
        AuthKeyBody: { type: 'object', required: ['authKey'], properties: { authKey: { type: 'string', description: 'Base64 auth key derived by the client. Not a password.' } } },
        Kdf: { type: 'object', required: ['algorithm', 'iterations', 'salt'], properties: { algorithm: { type: 'string', enum: ['pbkdf2-sha256'] }, iterations: { type: 'integer', minimum: 300000 }, salt: { type: 'string' } } },
        KeyWrap: { type: 'object', required: ['iv', 'data'], properties: { iv: { type: 'string' }, data: { type: 'string' } } },
        PreloginRequest: { type: 'object', properties: { username: { type: 'string' }, email: { type: 'string', format: 'email' } }, description: 'Send either a username or an email.' },
        IdentityRequest: {
          type: 'object',
          properties: {
            username: { type: 'string', description: '3 to 32 ASCII letters, digits, dot, underscore or hyphen. Unique ignoring case.' },
            email: { type: 'string', format: 'email' },
            authKey: { type: 'string', description: 'Required by /email.' },
            publicKey: { type: 'string', description: 'Base64 raw P-256 public key used to wrap share keys.' },
            userKeyWrap: { $ref: '#/components/schemas/KeyWrap' },
          },
        },
        Prelogin: { type: 'object', properties: { kdf: { $ref: '#/components/schemas/Kdf' } } },
        SessionRequest: {
          type: 'object',
          required: ['authKey'],
          properties: {
            username: { type: 'string' },
            email: { type: 'string', format: 'email' },
            authKey: { type: 'string' },
            device: { type: 'object', properties: { name: { type: 'string' }, platform: { type: 'string' } } },
          },
        },
        RegisterRequest: {
          type: 'object',
          required: ['authKey', 'kdf', 'vaultKeyWrap', 'device'],
          description: 'A username or an email is required. A device-key account has no password: its keys come from a random key kept in the device keychain.',
          properties: {
            username: { type: 'string' },
            email: { type: 'string', format: 'email' },
            credential: { type: 'string', enum: ['password', 'device-key'] },
            publicKey: { type: 'string' },
            userKeyWrap: { $ref: '#/components/schemas/KeyWrap' },
            authKey: { type: 'string' },
            kdf: { $ref: '#/components/schemas/Kdf' },
            vaultKeyWrap: { $ref: '#/components/schemas/KeyWrap' },
            device: { type: 'object', required: ['name', 'platform'], properties: { name: { type: 'string' }, platform: { type: 'string' } } },
          },
        },
        PasswordRequest: {
          type: 'object',
          required: ['authKey', 'newAuthKey', 'kdf', 'vaultKeyWrap'],
          properties: {
            authKey: { type: 'string' },
            newAuthKey: { type: 'string' },
            kdf: { $ref: '#/components/schemas/Kdf' },
            vaultKeyWrap: { $ref: '#/components/schemas/KeyWrap' },
          },
        },
        Session: { type: 'object', properties: { accountId: { type: 'string' }, deviceId: { type: 'string' }, token: { type: 'string' }, expiresAt: { type: 'string' }, revision: { type: 'integer' }, kdf: { $ref: '#/components/schemas/Kdf' }, vaultKeyWrap: { $ref: '#/components/schemas/KeyWrap' } } },
        WriteResult: { type: 'object', properties: { revision: { type: 'integer' }, tableRevision: { type: 'integer' }, uploadId: { type: 'string' }, size: { type: 'integer' } } },
        Account: { type: 'object', properties: { accountId: { type: 'string' }, revision: { type: 'integer' }, usage: { type: 'object', additionalProperties: true }, devices: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
        FileEntry: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            revision: { type: 'integer' },
            deleted: { type: 'boolean' },
            size: { type: 'integer' },
            sha256: { type: 'string', nullable: true },
            meta: { type: 'string', nullable: true, description: 'Encrypted metadata.' },
            updatedAt: { type: 'string', nullable: true },
            deviceId: { type: 'string', nullable: true },
          },
        },
        Changes: { type: 'object', properties: { revision: { type: 'integer' }, entries: { type: 'array', items: { $ref: '#/components/schemas/FileEntry' } }, more: { type: 'boolean' }, nextSince: { type: 'integer' } } },
        Conflict: { type: 'object', required: ['reason'], properties: { error: { type: 'string' }, reason: { type: 'string', enum: ['stale', 'guard', 'offset', 'incomplete'] }, entry: { $ref: '#/components/schemas/FileEntry' }, offset: { type: 'integer' }, size: { type: 'integer' } } },
        UploadCreate: { type: 'object', required: ['size'], properties: { size: { type: 'integer', minimum: 28 } } },
        Upload: { type: 'object', properties: { uploadId: { type: 'string' }, fileId: { type: 'string' }, offset: { type: 'integer' }, size: { type: 'integer' } } },
        RestoreRequest: { type: 'object', required: ['revision'], properties: { revision: { type: 'integer', minimum: 0 } } },
        RevisionList: { type: 'object', properties: { revisions: { type: 'array', items: { type: 'object', properties: { revision: { type: 'integer' }, size: { type: 'integer' }, collapse: { type: 'boolean' } } } } } },
        IntegrityReport: {
          type: 'object',
          properties: {
            accountId: { type: 'string' },
            ok: { type: 'boolean' },
            filesChecked: { type: 'integer' },
            blobsMissing: { type: 'array', items: { type: 'object', additionalProperties: true } },
            hashMismatch: { type: 'array', items: { type: 'object', additionalProperties: true } },
            blobsOrphan: { type: 'array', items: { type: 'object', additionalProperties: true } },
            revisionsOrphan: { type: 'array', items: { type: 'object', additionalProperties: true } },
            incoming: { type: 'array', items: { type: 'object', additionalProperties: true } },
            uploads: { type: 'array', items: { type: 'object', additionalProperties: true } },
            quarantine: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }
}

export const syncOpenApiDocument = (source) => buildSyncOpenApi(syncOperationsFromSource(source))

export const readSyncOpenApiSource = () => readFileSync(new URL('./sync-api.mjs', import.meta.url), 'utf8')
