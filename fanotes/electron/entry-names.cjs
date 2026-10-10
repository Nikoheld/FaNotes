'use strict'

const PROTECTED_ENTRY_NAMES = new Set(['.fanotes', '.lernwerk'])
// Win32 reserves these device names with or without an extension (CON.md, NUL.txt).
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu
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

module.exports = {
  PROTECTED_ENTRY_NAMES,
  safeEntryName,
}
