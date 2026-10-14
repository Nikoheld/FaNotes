#!/usr/bin/env node

// Set the calendar version used by the desktop app, the Tauri shell, and the
// Android client. GitHub Actions runs this before it tags a release.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const fanotesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(fanotesRoot, '..')
const VERSION_PATTERN = /^(\d{4})\.(\d{1,2})\.([1-9]\d*)(?:-beta\.([1-9]\d*))?$/u

const readArg = (name) => {
  const index = process.argv.indexOf(name)
  if (index === -1) return ''
  return process.argv[index + 1] || ''
}

const version = readArg('--version')
if (!VERSION_PATTERN.test(version)) {
  throw new Error('Use --version YYYY.M.N or YYYY.M.N-beta.B.')
}

const notes = (readArg('--notes') || `FaNotes ${version}`)
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => (line.startsWith('- ') ? line : `- ${line}`))

const dryRun = process.argv.includes('--dry-run')
const match = VERSION_PATTERN.exec(version)
const month = String(match[2]).padStart(2, '0')
const releaseNumber = String(match[3]).padStart(2, '0')
const beta = match[4] ? String(match[4]).padStart(2, '0') : ''
const versionCode = Number(`${match[1]}${month}${releaseNumber}${beta}`)

const write = (filePath, next) => {
  const current = fs.readFileSync(filePath, 'utf8')
  if (current === next) return false
  if (!dryRun) fs.writeFileSync(filePath, next)
  console.log(`${dryRun ? 'would update' : 'updated'} ${path.relative(repoRoot, filePath)}`)
  return true
}

const replaceJsonVersion = (filePath, times) => {
  const current = fs.readFileSync(filePath, 'utf8')
  let seen = 0
  const next = current.replace(/"version": "[^"]+"/g, (found) => {
    seen += 1
    return seen <= times ? `"version": "${version}"` : found
  })
  if (seen < times) throw new Error(`${filePath} does not contain ${times} version fields.`)
  write(filePath, next)
}

replaceJsonVersion(path.join(fanotesRoot, 'package.json'), 1)
replaceJsonVersion(path.join(fanotesRoot, 'package-lock.json'), 2)
replaceJsonVersion(path.join(fanotesRoot, 'src-tauri', 'tauri.conf.json'), 1)

const gradlePath = path.join(repoRoot, 'android', 'app', 'build.gradle.kts')
const gradle = fs.readFileSync(gradlePath, 'utf8')
  .replace(/orElse\("[^"]+"\)/u, `orElse("${version}")`)
  .replace(/versionCode = \d+/u, `versionCode = ${versionCode}`)
write(gradlePath, gradle)

const changelogPath = path.join(fanotesRoot, 'CHANGELOG.md')
let changelog = fs.readFileSync(changelogPath, 'utf8')
const heading = `## ${version}\n`
if (!changelog.includes(heading)) {
  const block = `${heading}\n${notes.join('\n')}\n\n`
  const title = '# Änderungsverlauf\n'
  if (!changelog.startsWith(title)) throw new Error('CHANGELOG.md is missing its title.')
  changelog = `${title}\n${block}${changelog.slice(title.length).replace(/^\n/u, '')}`
  write(changelogPath, changelog)
} else {
  console.log(`CHANGELOG.md already has ${version}`)
}

console.log(`${version} (Android versionCode ${versionCode})`)
