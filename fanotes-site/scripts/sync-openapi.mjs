// Regenerate fanotes-site/openapi/sync-v1.json from the sync router.
//   node fanotes-site/scripts/sync-openapi.mjs
import { writeFileSync } from 'node:fs'
import { syncOpenApiDocument, readSyncOpenApiSource } from '../sync-openapi.mjs'

const document = syncOpenApiDocument(readSyncOpenApiSource())
writeFileSync(new URL('../openapi/sync-v1.json', import.meta.url), `${JSON.stringify(document, null, 2)}\n`)
