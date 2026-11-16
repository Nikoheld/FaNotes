#!/usr/bin/env node
// FaNotes request worker entry point.
import { loadConfig } from './config.mjs'
import { createLogger } from './log.mjs'
import { createApi } from './api.mjs'
import { Worker } from './worker.mjs'

let config
try { config = loadConfig() } catch (e) { process.stderr.write(`config error: ${e.message}\n`); process.exit(2) }
const log = createLogger([config.token])
if (process.argv.includes('--dry-run')) config.dryRun = true
if (process.argv.includes('--once')) config.once = true
const worker = new Worker({ config, api: createApi({ origin: config.origin, token: config.token }), log })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log.info(`${sig}: stopping`); worker.stop() })
log.info(`request worker started (origin ${config.origin}, dryRun=${config.dryRun})`)
await worker.loop()
log.info('request worker stopped')
