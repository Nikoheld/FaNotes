/**
 * Turns a raw file-system or Electron IPC error into a short message for the
 * user. The raw text carries absolute temp paths ("rename 'C:\Users\...tmp'")
 * and the channel name; neither helps anyone and neither is shown.
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/u

const CODE_MESSAGES: Record<string, string> = {
  EPERM: 'Die Datei ist schreibgeschützt oder gesperrt.',
  EACCES: 'Kein Zugriff auf die Datei.',
  EBUSY: 'Die Datei wird von einem anderen Programm verwendet.',
  ENOENT: 'Die Datei wurde nicht gefunden.',
  ENOSPC: 'Auf dem Datenträger ist kein Speicherplatz mehr frei.',
}

export const fileErrorCode = (error: unknown): string | null => {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const match = /\b(EPERM|EACCES|EBUSY|ENOENT|ENOSPC)\b/u.exec(text)
  return match ? match[1] : null
}

/** A localizable German message, or `fallback` when the error is not a known file error. */
export const friendlyFileError = (error: unknown, fallback: string): string => {
  const code = fileErrorCode(error)
  if (code) return CODE_MESSAGES[code]
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const stripped = text.replace(IPC_PREFIX, '').trim()
  // A technical text that still names a path or an errno is replaced by the fallback.
  if (!stripped || /[A-Za-z]:\\|\/[\w.-]+\/|\bE[A-Z]{3,}\b|\.tmp\b/u.test(stripped)) return fallback
  return stripped
}

/** For toasts that receive an already-built message string. */
export const sanitizeToastMessage = (message: string): string => {
  if (!IPC_PREFIX.test(message) && !/\b(EPERM|EACCES|EBUSY|ENOENT|ENOSPC)\b/u.test(message)) return message
  return friendlyFileError(message, 'Die Aktion ist fehlgeschlagen.')
}

/** "file.js:12" from an ErrorEvent source (base name only), so reports can group errors by place. */
export const errorLocation = (filename: unknown, line: unknown): string | undefined => {
  const base = typeof filename === 'string' ? filename.split(/[\\/]/u).pop()?.split('?')[0] ?? '' : ''
  if (!/^[A-Za-z0-9_.-]{1,60}\.m?js$/u.test(base)) return undefined
  return `${base}:${Number.isInteger(line) && Number(line) > 0 ? Number(line) : 0}`
}
