'use strict'

const path = require('node:path')
const { companionNotePath } = require('./famd.cjs')

const lowerName = (name) => String(name).normalize('NFC').toLocaleLowerCase('de-DE')

const extensionOf = (name) => path.extname(String(name || '').replace(/\\/gu, '/')).toLocaleLowerCase('en-US')

/**
 * The other files of this note. A `.famd` belongs to `.md` or `.markdown`
 * prose. A prose note or a PDF belongs to one `.famd`.
 */
const companionPaths = (relativePath) => {
  const extension = extensionOf(relativePath)
  if (extension === '.famd') return ['.md', '.markdown'].map((prose) => companionNotePath(relativePath, prose))
  if (extension === '.md' || extension === '.markdown' || extension === '.pdf') return [companionNotePath(relativePath, '.famd')]
  return []
}

/** A `.famd` next to prose or a PDF is that note's companion, not a second document. */
const famdSiblingPaths = (relativePath) => {
  if (extensionOf(relativePath) !== '.famd') return []
  return ['.md', '.markdown', '.pdf'].map((extension) => companionNotePath(relativePath, extension))
}

const numberedName = (name, number) => {
  if (number === 1) return name
  const extension = path.extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  return `${stem} ${number}${extension}`
}

/**
 * Basenames a rename of `currentName` to `candidateName` would also write.
 * The companion keeps its own extension, so `.markdown` stays `.markdown`.
 */
const companionDestinationNames = (currentName, candidateName) => (
  companionPaths(currentName).map((source) => path.basename(companionNotePath(candidateName, extensionOf(source))))
)

/**
 * True when the candidate would land on a companion that is not this note's.
 * `occupied` and `ownNames` are NFC lowercase basenames. `ownNames` is set
 * only for a rename in the same folder, where this note's companion is
 * already in the directory and will move with it.
 * POSIX rename replaces an existing file, so a taken companion is data loss.
 */
const companionNameTaken = (currentName, candidateName, occupied, ownNames = null) => (
  companionDestinationNames(currentName, candidateName).some((base) => {
    const key = lowerName(base)
    return occupied.has(key) && !(ownNames && ownNames.has(key))
  })
)

const firstFreeName = (desiredName, occupied, taken = () => false) => {
  for (let number = 1; number <= 10000; number += 1) {
    const candidate = numberedName(desiredName, number)
    if (occupied.has(lowerName(candidate))) continue
    if (taken(candidate)) continue
    return candidate
  }
  throw new Error('Es konnte kein eindeutiger Name erzeugt werden.')
}

module.exports = {
  companionDestinationNames,
  companionNameTaken,
  companionPaths,
  famdSiblingPaths,
  firstFreeName,
  lowerName,
  numberedName,
}
