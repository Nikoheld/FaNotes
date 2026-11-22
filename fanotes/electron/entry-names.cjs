'use strict'

const PROTECTED_ENTRY_NAMES = new Set(['.fanotes', '.lernwerk'])
// Win32 reserves these device names with or without an extension (CON.md, NUL.txt).
// COM/LPT also exist with the superscript digits, and CONIN$/CONOUT$ are console handles.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/iu
const WINDOWS_ILLEGAL_CHARACTERS = /[<>:"|?*]/u

function safeEntryName(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const name = raw || fallback
  if (
    !name ||
    name.length > 180 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\0-\x1f\x7f]/u.test(name) ||
    PROTECTED_ENTRY_NAMES.has(name.toLocaleLowerCase('en-US'))
  ) {
    throw new Error('Dieser Name ist nicht erlaubt.')
  }
  const cleaned = name.replace(/[. ]+$/u, '').trim()
  if (
    !cleaned ||
    cleaned === '.' ||
    cleaned === '..' ||
    PROTECTED_ENTRY_NAMES.has(cleaned.toLocaleLowerCase('en-US')) ||
    WINDOWS_ILLEGAL_CHARACTERS.test(cleaned) ||
    WINDOWS_DEVICE_NAME.test(cleaned.split('.')[0].trim())
  ) {
    throw new Error('Dieser Name ist nicht erlaubt.')
  }
  return cleaned
}

/**
 * True when Windows cannot hold a file or folder with this name: an illegal character (a colon even
 * opens an NTFS alternate data stream, `C:x` is a drive-relative path), a reserved device name with or
 * without extension, or a trailing dot or space (Win32 silently strips them, so two names collide).
 */
function isWindowsUnsafeSegment(segment) {
  if (typeof segment !== 'string' || !segment) return true
  return WINDOWS_ILLEGAL_CHARACTERS.test(segment)
    || /[\0-\x1f]/u.test(segment)
    || /[. ]$/u.test(segment)
    || WINDOWS_DEVICE_NAME.test(segment.split('.')[0].trim())
}

/** Same for a slash-separated vault path. */
function isWindowsUnsafePath(logicalPath) {
  return String(logicalPath).split('/').some(isWindowsUnsafeSegment)
}

/** Path equality for the platform's file system: NTFS ignores case. */
function samePhysicalPath(left, right, platform = process.platform) {
  const pathModule = platform === 'win32' ? require('node:path').win32 : require('node:path').posix
  const a = pathModule.resolve(left)
  const b = pathModule.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

module.exports = {
  PROTECTED_ENTRY_NAMES,
  isWindowsUnsafePath,
  isWindowsUnsafeSegment,
  samePhysicalPath,
  safeEntryName,
}
