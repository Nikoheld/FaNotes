import { readFile } from 'node:fs/promises'
import { VERSION_PATTERN, compareSemanticVersions, releaseVisibleOnChannel } from './releaseVersion.mjs'

const GITHUB_API_RELEASES = 'https://api.github.com/repos/Nikoheld/FaNotes/releases'
const GITHUB_REPOSITORY = 'Nikoheld/FaNotes'
const CACHE_MS = 10 * 60 * 1000
const FILE_NAME_PATTERN = /^[\w.+-]{1,180}$/u
const PACKAGE_FILE = Object.freeze({
  appimage: (version) => `FaNotes-${version}-x86_64.AppImage`,
  portable: (version) => `FaNotes-${version}-x86_64.tar.gz`,
  'windows-installer': (version) => `FaNotes-Setup-${version}-x64.exe`,
  'windows-portable': (version) => `FaNotes-Portable-${version}-x64.exe`,
})

let cachedReleases = null

const githubPackageUrl = (version, fileName) => {
  if (!VERSION_PATTERN.test(version) || !FILE_NAME_PATTERN.test(fileName)) return null
  return `https://github.com/${GITHUB_REPOSITORY}/releases/download/v${version}/${fileName}`
}

const normalizeReleaseList = (parsed) => {
  if (Array.isArray(parsed)) return parsed
  const releases = Array.isArray(parsed?.releases) ? parsed.releases.slice() : []
  if (parsed?.latest && typeof parsed.latest === 'object' && !Array.isArray(parsed.latest)) releases.push(parsed.latest)
  return releases
}

// The asset name only proves the file exists on that release. The redirect
// target is always the canonical GitHub URL, never browser_download_url.
export const pickGithubPackage = (releases, channel, kind) => {
  const fileNameFor = PACKAGE_FILE[kind]
  if (!fileNameFor || !Array.isArray(releases)) return null
  let best = null
  for (const item of releases) {
    if (!item || item.draft === true || !Array.isArray(item.assets)) continue
    const tagVersion = typeof item.tag_name === 'string' && item.tag_name.startsWith('v') ? item.tag_name.slice(1) : ''
    if (!VERSION_PATTERN.test(tagVersion) || !releaseVisibleOnChannel(tagVersion, channel)) continue
    const fileName = fileNameFor(tagVersion)
    const asset = item.assets.find((entry) => entry?.name === fileName)
    if (!asset) continue
    const url = githubPackageUrl(tagVersion, fileName)
    if (!url) continue
    if (!best || compareSemanticVersions(tagVersion, best.version) > 0) best = { version: tagVersion, fileName, url }
  }
  return best
}

export const loadGithubReleases = async () => {
  const fixture = process.env.FANOTES_GITHUB_RELEASES_FILE
  if (fixture) return normalizeReleaseList(JSON.parse(await readFile(fixture, 'utf8')))
  const now = Date.now()
  if (cachedReleases && now - cachedReleases.at < CACHE_MS) return cachedReleases.releases
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'FaNotes-Website',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const listResponse = await fetch(`${GITHUB_API_RELEASES}?per_page=100`, { headers, signal: controller.signal })
    if (!listResponse.ok) throw new Error(`GitHub antwortet mit HTTP ${listResponse.status}.`)
    const listed = await listResponse.json()
    const releases = Array.isArray(listed) ? listed.slice() : []
    try {
      const latestResponse = await fetch(`${GITHUB_API_RELEASES}/latest`, { headers, signal: controller.signal })
      if (latestResponse.ok) {
        const latest = await latestResponse.json()
        if (latest && typeof latest === 'object' && !Array.isArray(latest)) releases.push(latest)
      }
    } catch {
      // The first page still contains Stable when few prereleases were published.
    }
    cachedReleases = { at: now, releases }
    return releases
  } finally {
    clearTimeout(timer)
  }
}
