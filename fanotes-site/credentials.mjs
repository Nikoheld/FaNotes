import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Prefer a systemd LoadCredential file when that credential was provided. */
export const credentialOr = (name, fallback) => {
  const directory = process.env.CREDENTIALS_DIRECTORY
  if (!directory || !name) return fallback
  const candidate = join(directory, name)
  try {
    if (existsSync(candidate)) return candidate
  } catch {
    return fallback
  }
  return fallback
}
