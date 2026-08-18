import packageJson from '../../package.json'

/** Shipped product version. Always read from package.json — never a stale literal. */
export const APP_VERSION = String(packageJson.version)
