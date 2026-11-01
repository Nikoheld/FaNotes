// Standalone poller. Enable this only when fanotes-site.service has
// FANOTES_SCHULNETZ_POLL=0. A lock file keeps a second poller from refreshing.
import { createSchulnetzRuntime } from './schulnetz-api.mjs'

const runtime = createSchulnetzRuntime()
runtime.start()
