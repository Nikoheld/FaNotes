import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickGithubPackage } from '../github-release.mjs'

const siteRoot = fileURLToPath(new URL('..', import.meta.url))
const stable = '2026.10.12'
const olderBeta = '2026.10.12-beta.4'
const newerBeta = '2026.10.13-beta.1'
const githubFile = (version, fileName) => `https://github.com/Nikoheld/FaNotes/releases/download/v${version}/${fileName}`
const release = (version, names, extras = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  assets: names.map((name) => ({ name, browser_download_url: 'https://evil.example/payload' })),
  ...extras,
})
const stableNames = [
  `FaNotes-${stable}-x86_64.AppImage`,
  `FaNotes-${stable}-x86_64.tar.gz`,
  `FaNotes-Setup-${stable}-x64.exe`,
  `FaNotes-Portable-${stable}-x64.exe`,
]
const stableRelease = release(stable, stableNames)
const olderBetaRelease = release(olderBeta, [`FaNotes-${olderBeta}-x86_64.AppImage`, `FaNotes-${olderBeta}-x86_64.tar.gz`])

const pickedStable = pickGithubPackage([
  { ...stableRelease, assets: stableRelease.assets },
  olderBetaRelease,
], 'beta', 'appimage')
assert.equal(pickedStable.url, githubFile(stable, `FaNotes-${stable}-x86_64.AppImage`))
assert.equal(pickGithubPackage([stableRelease, release(newerBeta, [`FaNotes-${newerBeta}-x86_64.AppImage`])], 'beta', 'appimage').version, newerBeta)
assert.equal(pickGithubPackage([stableRelease, release(newerBeta, [`FaNotes-${newerBeta}-x86_64.AppImage`])], 'stable', 'appimage').version, stable)
assert.equal(pickGithubPackage([release(newerBeta, [`FaNotes-${newerBeta}-x86_64.AppImage`])], 'nightly', 'appimage'), null)
assert.equal(pickGithubPackage([{ ...stableRelease, draft: true }], 'stable', 'appimage'), null)

const temporary = mkdtempSync(join(tmpdir(), 'fanotes-github-download-'))
const fixturePath = join(temporary, 'releases.json')
const enrollmentPath = join(temporary, 'enrollment-token')
mkdirSync(join(temporary, 'releases'), { recursive: true })
writeFileSync(enrollmentPath, randomBytes(36).toString('base64url'), { mode: 0o600 })
writeFileSync(fixturePath, JSON.stringify({ releases: [olderBetaRelease], latest: stableRelease }))
const port = 19000 + Math.floor(Math.random() * 2000)
let output = ''
const child = spawn(process.execPath, [join(siteRoot, 'server.mjs')], {
  cwd: siteRoot,
  env: {
    ...process.env,
    FANOTES_HOST: '127.0.0.1',
    FANOTES_PORT: String(port),
    FANOTES_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    FANOTES_PROFILE_DIR: join(temporary, 'profiles'),
    FANOTES_SHARE_DIR: join(temporary, 'shares'),
    FANOTES_BACKUP_DIR: join(temporary, 'backups'),
    FANOTES_BACKUP_ENROLLMENT_TOKEN_PATH: enrollmentPath,
    FANOTES_ANALYTICS_DIR: join(temporary, 'analytics'),
    FANOTES_RELEASE_DIR: join(temporary, 'releases'),
    FANOTES_GITHUB_RELEASES_FILE: fixturePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const waitForSite = async () => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`website exited ${child.exitCode}\n${output}`)
    if (output.includes('FaNotes website listening')) return
    await wait(100)
  }
  throw new Error(`website did not listen\n${output}`)
}

const fetchPath = (urlPath, method = 'GET') => new Promise((resolve, reject) => {
  const req = httpRequest({ hostname: '127.0.0.1', port, path: urlPath, method }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => resolve({
      status: response.statusCode,
      location: response.headers.location || '',
      version: response.headers['x-fanotes-version'] || '',
      body: Buffer.concat(chunks),
    }))
  })
  req.on('error', reject)
  req.end()
})

try {
  await waitForSite()
  const betaAppImage = await fetchPath('/download/beta/appimage')
  assert.equal(betaAppImage.status, 302)
  assert.equal(betaAppImage.location, githubFile(stable, `FaNotes-${stable}-x86_64.AppImage`))
  assert.equal(betaAppImage.version, stable)
  assert.equal(betaAppImage.body.length, 0)
  const stableAppImage = await fetchPath('/download/appimage', 'HEAD')
  assert.equal(stableAppImage.status, 302)
  assert.equal(stableAppImage.location, githubFile(stable, `FaNotes-${stable}-x86_64.AppImage`))
  const installer = await fetchPath('/download/windows-installer')
  assert.equal(installer.location, githubFile(stable, `FaNotes-Setup-${stable}-x64.exe`))
  assert.equal(installer.status, 302)

  writeFileSync(fixturePath, JSON.stringify({
    releases: [olderBetaRelease, release(newerBeta, [`FaNotes-${newerBeta}-x86_64.AppImage`, `FaNotes-${newerBeta}-x86_64.tar.gz`])],
    latest: stableRelease,
  }))
  const newerBetaDownload = await fetchPath('/download/beta/appimage')
  assert.equal(newerBetaDownload.status, 302)
  assert.equal(newerBetaDownload.location, githubFile(newerBeta, `FaNotes-${newerBeta}-x86_64.AppImage`))
  assert.equal(newerBetaDownload.version, newerBeta)
  const stableStill = await fetchPath('/download/appimage')
  assert.equal(stableStill.location, githubFile(stable, `FaNotes-${stable}-x86_64.AppImage`))
  assert.notEqual(stableStill.status, 200)

  writeFileSync(fixturePath, JSON.stringify({ releases: [], latest: null }))
  const fallback = await fetchPath('/download/appimage')
  assert.equal(fallback.status, 503)
  assert.equal(fallback.location, '')
  console.log('GitHub-Downloadprüfung erfolgreich: Beta folgt der neueren Stable-Datei, neuere Beta gewinnt, Weiterleitung zeigt nur auf GitHub.')
} finally {
  child.kill('SIGTERM')
  await wait(200)
  if (child.exitCode === null) child.kill('SIGKILL')
  rmSync(temporary, { recursive: true, force: true })
}
