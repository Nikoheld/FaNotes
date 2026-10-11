import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sibling = fileURLToPath(new URL('../fanotes/electron/releaseVersion.cjs', import.meta.url))
const local = fileURLToPath(new URL('./releaseVersion.cjs', import.meta.url))

export const {
  DELTA_ROUTE_PATTERN,
  DOWNLOAD_ROUTE_PATTERN,
  EMPTY_NIGHTLY_CHANGELOG,
  LINUX_PACKAGE_PATTERN,
  UPDATE_CHANNELS,
  VERSION_PATTERN,
  WINDOWS_PACKAGE_PATTERN,
  compareSemanticVersions,
  deltaPathname,
  packagePathname,
  releaseVisibleOnChannel,
  versionChannel,
} = require(existsSync(sibling) ? sibling : local)
