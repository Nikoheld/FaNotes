'use strict'

const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const argumentsFrom = (values) => {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`Ungültiges Argument: ${key ?? ''}`)
    result[key.slice(2)] = value
  }
  return result
}

const sha256File = async (filePath) => {
  const hash = crypto.createHash('sha256')
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

void (async () => {
  const args = argumentsFrom(process.argv.slice(2))
  const stage = path.resolve(args.stage || '')
  const target = path.resolve(args.target || '')
  const version = args.version
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(version) || !stage || !target || stage === target) {
    throw new Error('Stage, Ziel und semantische Version werden benötigt.')
  }
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN fehlt. FaNotes veröffentlicht keinen Server-Release ohne denselben vollständigen GitHub-Release.')
  }

  const checksumsText = await fsp.readFile(path.join(stage, 'SHA256SUMS'), 'utf8')
  const checksums = new Map(checksumsText.split(/\r?\n/u).flatMap((line) => {
    const match = /^([a-f0-9]{64})\s+\*?([^/\\]+)$/iu.exec(line.trim())
    return match ? [[match[2], match[1].toLowerCase()]] : []
  }))
  const linuxPackages = [`FaNotes-${version}-x86_64.AppImage`, `FaNotes-${version}-x86_64.tar.gz`]
  const windowsPackages = [`FaNotes-Portable-${version}-x64.exe`, `FaNotes-Setup-${version}-x64.exe`]
  const required = [
    ...linuxPackages,
    ...windowsPackages,
    `FaNotes-Setup-${version}-x64.exe.blockmap`,
    `FaNotes-Delta-linux-x64-${args['base-version']}-to-${version}.fndelta`,
    `FaNotes-Delta-windows-x64-${args['base-version']}-to-${version}.fndelta`,
    `app-${version}-linux.asar`,
    `app-${version}-windows.asar`,
  ]
  if (required.some((fileName) => !checksums.has(fileName))) throw new Error('Der vorbereitete Release ist unvollständig.')

  const stageEntries = (await fsp.readdir(stage, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS')
    .map((entry) => entry.name)
  for (const fileName of stageEntries) {
    const stats = await fsp.lstat(path.join(stage, fileName))
    if (!stats.isFile() || stats.isSymbolicLink() || !checksums.has(fileName)) {
      throw new Error(`Unsichere oder nicht signierte Stage-Datei: ${fileName}`)
    }
  }

  await fsp.mkdir(target, { recursive: true, mode: 0o750 })
  const published = []
  const atomicCopy = async (fileName) => {
    const source = path.join(stage, fileName)
    const destination = path.join(target, fileName)
    const temporary = path.join(target, `.fanotes-publish-${process.pid}-${fileName}.tmp`)
    await fsp.copyFile(source, temporary)
    await fsp.chmod(temporary, fileName.endsWith('.AppImage') ? 0o755 : 0o640)
    if (fileName !== 'SHA256SUMS') {
      const digest = await sha256File(temporary)
      if (digest !== checksums.get(fileName)) throw new Error(`SHA-256-Prüfung vor Veröffentlichung fehlgeschlagen: ${fileName}`)
    }
    await fsp.rename(temporary, destination)
    published.push(fileName)
  }

  const packageNames = new Set([...linuxPackages, ...windowsPackages])
  for (const fileName of stageEntries.filter((name) => !packageNames.has(name)).sort()) await atomicCopy(fileName)
  await atomicCopy('SHA256SUMS')

  const githubPublisher = path.join(__dirname, 'publish-github-releases.py')
  const githubResult = await execFileAsync('python3', [githubPublisher, '--version', version], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, FANOTES_RELEASE_DIR: stage },
    maxBuffer: 8 * 1024 * 1024,
  })
  if (githubResult.stdout) process.stdout.write(githubResult.stdout)
  if (githubResult.stderr) process.stderr.write(githubResult.stderr)
  // Platform packages are copied last. The server cannot discover the new
  // release until the complete GitHub publication has succeeded.
  for (const fileName of windowsPackages) await atomicCopy(fileName)
  for (const fileName of linuxPackages) await atomicCopy(fileName)

  console.log(`Release ${version} atomar auf Server und GitHub veröffentlicht: ${published.length} Dateien; Prüfsummen lagen vor den vollständigen Plattformpaketen bereit.`)
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
