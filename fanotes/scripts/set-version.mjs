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
// Android installs an update only when versionCode increases, and Play rejects
// a code above 2_100_000_000. Concatenating YYYYMMNNBB crosses that cap for a
// beta of 2026.10.11, and it also sorts above every later 8-digit stable.
// Each future stable keeps 49 betas in the integers just below it. Every code
// stays above the published 2026.10.10 value 20261010.
const year = Number(match[1])
const monthNumber = Number(match[2])
const stableNumber = Number(match[3])
const betaNumber = match[4] ? Number(match[4]) : 0
if (betaNumber > 49) throw new Error('Android supports at most 49 betas for one stable release.')
const monthIndex = (year - 2026) * 12 + (monthNumber - 1)
if (monthIndex < 0 || stableNumber > 900) throw new Error(`Android versionCode cannot encode ${version}.`)
const stableCode = 50_000_000 + monthIndex * 100_000 + stableNumber * 100
const versionCode = betaNumber === 0 ? stableCode : stableCode - 50 + betaNumber
if (versionCode <= 20_261_010 || versionCode > 2_100_000_000) {
  throw new Error(`Android versionCode ${versionCode} for ${version} is outside the installable range.`)
}

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
