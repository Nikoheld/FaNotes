// Select assets from the last beta that actually built each platform.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'

const betaTag = /^v\d{4}\.\d{1,2}\.\d+-beta\.\d+$/u
export const packages = {
  linux: v => [`FaNotes-${v}-x86_64.AppImage`, `FaNotes-${v}-x86_64.tar.gz`],
  windows: v => [`FaNotes-Setup-${v}-x64.exe`, `FaNotes-Portable-${v}-x64.exe`],
  android: v => [`FaNotes-${v}-android.apk`],
  companion: v => [`Kanti-Plus-${v}-android.apk`, `Kanti-Plus-${v}-android.aab`, `Kanti-Plus-${v}-native-debug-symbols.zip`],
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const desktop = platform => platform === 'linux' || platform === 'windows'
const documentation = /^(?:(?:fanotes\/)?[^/]+\.md$|fanotes\/docs\/|android\/(?:README|ARCHITECTURE)\.md$)/u
const versionFiles = new Set([
  'fanotes/package.json',
  'fanotes/package-lock.json',
  'fanotes/src-tauri/tauri.conf.json',
  'android/app/build.gradle.kts',
  'android/companion/build.gradle.kts',
])

function versionIndependent(file, data) {
  if (file === 'fanotes/package.json' || file === 'fanotes/package-lock.json' || file === 'fanotes/src-tauri/tauri.conf.json') {
    const value = JSON.parse(data)
    delete value.version
    if (file.endsWith('package-lock.json') && value.packages?.['']) delete value.packages[''].version
    return JSON.stringify(value)
  }
  if (/^android\/(app|companion)\/build\.gradle\.kts$/u.test(file)) {
    return data.replace(/orElse\("\d{4}\.\d+\.\d+(?:-beta\.\d+)?"\)/u, 'orElse("VERSION")')
      .replace(/versionCode = \d+/u, 'versionCode = VERSION_CODE')
  }
  return null
}

function affects(platform, file) {
  if (documentation.test(file) || file.startsWith('.github/') ||
      /^fanotes\/scripts\/(?:check-|beta-platform-assets\.mjs$|next-beta-version\.mjs$|write-update-manifests\.mjs$)/u.test(file)) return false
  if (desktop(platform)) {
    if (file.startsWith('android/') || file.startsWith('fanotes-site/')) return false
    const other = platform === 'linux' ? 'win32-x64' : 'linux-x64'
    return !file.startsWith(`fanotes/native-ocr/${other}/`) && !file.startsWith(`fanotes/native-math/${other}/`)
  }
  if (platform === 'companion') {
    return !file.startsWith('android/app/') &&
      (!file.startsWith('fanotes/') || file === 'fanotes/scripts/android-version-code.mjs')
  }
  return !file.startsWith('android/companion/') && !file.startsWith('fanotes-site/') &&
    !file.startsWith('fanotes/electron/') && !file.startsWith('fanotes/native-') &&
    !file.startsWith('fanotes/src-tauri/')
}

export function unchanged(platform, tag, sha) {
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', tag, sha])
  if (ancestry.status !== 0) return false
  const files = git('diff', '--name-only', '--no-renames', '-z', tag, sha, '--').split('\0').filter(Boolean)
  return files.every(file => {
    if (!affects(platform, file)) return true
    if (!versionFiles.has(file)) return false
    try {
      const previous = versionIndependent(file, git('show', `${tag}:${file}`))
      return previous !== null && previous === versionIndependent(file, git('show', `${sha}:${file}`))
    } catch {
      return false
    }
  })
}

async function plan(sha) {
  // Leave a margin inside the updater's 100-release discovery window.
  const releases = JSON.parse(gh('api', 'repos/{owner}/{repo}/releases?per_page=80'))
    .filter(release => !release.draft && release.prerelease && betaTag.test(release.tag_name))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name, 'en', { numeric: true }))
  for (const [platform, names] of Object.entries(packages)) {
    const previous = releases.find(release => {
      const expected = [...names(release.tag_name.slice(1)), 'SHA256SUMS']
      if (desktop(platform)) expected.push(`FaNotes-update-${platform}-x64-beta.json`)
      return expected.every(name => release.assets.some(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0))
    })
    const tag = previous && unchanged(platform, previous.tag_name, sha) ? previous.tag_name : ''
    console.log(tag ? `${platform}: reuse ${tag}` : `${platform}: build`)
    await appendFile(process.env.GITHUB_OUTPUT, `${platform}=${tag}\n`)
  }
}

async function download(directory, selections) {
  for (const [platform, tag] of Object.entries(selections)) {
    if (!tag) continue
    if (!betaTag.test(tag) || !Object.hasOwn(packages, platform)) throw new Error('Invalid beta asset selection')
    const names = packages[platform](tag.slice(1))
    const args = names.flatMap(name => ['--pattern', name])
    gh('release', 'download', tag, '--dir', directory, '--clobber', ...args)
    const sums = gh('release', 'download', tag, '--pattern', 'SHA256SUMS', '--output', '-')
    for (const name of names) {
      const expected = sums.split(/\r?\n/u).find(line => line.endsWith(`  ${name}`))?.slice(0, 64)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk)
      if (!expected || hash.digest('hex') !== expected) throw new Error(`Checksum mismatch for ${tag}/${name}`)
    }
  }
}

if (process.argv[2] === '--plan') await plan(process.argv[3])
if (process.argv[2] === '--download') await download(process.argv[3], JSON.parse(process.argv[4]))
