#!/usr/bin/env node

// Android versionCode for a FaNotes calendar version. set-version.mjs writes it
// into both Android modules, and the release build checks the built Kanti+ app
// against it. Usage: node android-version-code.mjs <version> | --self-test

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_PATTERN = /^(\d{4})\.(\d{1,2})\.([1-9]\d*)(?:-beta\.([1-9]\d*))?$/u

// Android installs an update and Play accepts an upload only when versionCode
// increases, and Play rejects a code above 2_100_000_000. Concatenating
// YYYYMMNNBB crosses that cap for a beta of 2026.10.11, and it also sorts above
// every later 8-digit stable. Each future stable keeps 49 betas in the integers
// just below it. Every code stays above the published 2026.10.10 value 20261010.
export const androidVersionCode = (version) => {
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new Error('Use a version YYYY.M.N or YYYY.M.N-beta.B.')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const stableNumber = Number(match[3])
  const betaNumber = match[4] ? Number(match[4]) : 0
  if (betaNumber > 49) throw new Error('Android supports at most 49 betas for one stable release.')
  const monthIndex = (year - 2026) * 12 + (monthNumber - 1)
  if (monthIndex < 0 || monthNumber < 1 || monthNumber > 12 || stableNumber > 900) throw new Error(`Android versionCode cannot encode ${version}.`)
  const stableCode = 50_000_000 + monthIndex * 100_000 + stableNumber * 100
  const versionCode = betaNumber === 0 ? stableCode : stableCode - 50 + betaNumber
  if (versionCode <= 20_261_010 || versionCode > 2_100_000_000) {
    throw new Error(`Android versionCode ${versionCode} for ${version} is outside the installable range.`)
  }
  return versionCode
}

const selfTest = () => {
  // Codes already published for ch.fasrv.kantiplus and the desktop Android app.
  assert.equal(androidVersionCode('2026.10.13-beta.6'), 50_901_256)
  assert.equal(androidVersionCode('2026.11.1-beta.14'), 51_000_064)
  assert.equal(androidVersionCode('2026.11.1'), 51_000_100)
  assert.equal(androidVersionCode('2026.11.2-beta.13'), 51_000_163)
  assert.equal(androidVersionCode('2026.11.2-beta.16'), 51_000_166)
  // Release order: betas, their stable, the next stable's betas, the next month.
  const order = [
    '2026.11.2-beta.16', '2026.11.2-beta.17', '2026.11.2-beta.49', '2026.11.2',
    '2026.11.3-beta.1', '2026.11.3', '2026.11.900-beta.1', '2026.11.900',
    '2026.12.1-beta.1', '2026.12.1', '2027.1.1-beta.1', '2027.12.2',
  ]
  for (let index = 1; index < order.length; index += 1) {
    const previous = androidVersionCode(order[index - 1])
    const next = androidVersionCode(order[index])
    assert.ok(next > previous, `${order[index]} (${next}) must be above ${order[index - 1]} (${previous})`)
  }
  assert.throws(() => androidVersionCode('2026.11.2-beta.50'))
  assert.throws(() => androidVersionCode('2026.11.2-nightly.1'))
  console.log('Android versionCode order ok')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest()
  else console.log(androidVersionCode(process.argv[2] || ''))
}
