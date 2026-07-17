'use strict'

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')
const asar = require('@electron/asar')
const { inspectDeltaPatch } = require('../electron/delta.cjs')

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u

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

const regularFile = async (filePath) => {
  const stats = await fsp.lstat(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`Release-Eingabe ist keine sichere reguläre Datei: ${filePath}`)
  }
  return stats
}

void (async () => {
  const args = argumentsFrom(process.argv.slice(2))
  const root = path.resolve(__dirname, '..')
  const buildStage = path.resolve(args.stage || '')
  const output = path.resolve(args.output || '')
  const baseVersion = args['base-version']
  const packageJson = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'))
  const version = packageJson.version
  if (!VERSION_PATTERN.test(version) || !VERSION_PATTERN.test(baseVersion)) {
    throw new Error('Basis- und Zielversion müssen semantische Versionen sein.')
  }
  if (!buildStage || !output || buildStage === output) throw new Error('Getrennte Build- und Ausgabeverzeichnisse werden benötigt.')

  const linuxAsar = path.join(buildStage, 'linux-unpacked', 'resources', 'app.asar')
  const windowsAsar = path.join(buildStage, 'win-unpacked', 'resources', 'app.asar')
  for (const candidate of [linuxAsar, windowsAsar]) {
    await regularFile(candidate)
    const packagedVersion = JSON.parse(asar.extractFile(candidate, 'package.json')).version
    if (packagedVersion !== version) throw new Error(`Falsche app.asar-Version ${packagedVersion} in ${candidate}`)
  }

  const deltaFiles = {
    linux: path.join(buildStage, `FaNotes-Delta-linux-x64-${baseVersion}-to-${version}.fndelta`),
    windows: path.join(buildStage, `FaNotes-Delta-windows-x64-${baseVersion}-to-${version}.fndelta`),
  }
  for (const [platform, candidate] of Object.entries(deltaFiles)) {
    const { header } = await inspectDeltaPatch(candidate)
    if (header.platform !== platform || header.baseVersion !== baseVersion || header.targetVersion !== version) {
      throw new Error(`Das ${platform}-Delta gehört nicht zu ${baseVersion} → ${version}.`)
    }
  }

  const sources = new Map([
    [`FaNotes-${version}-x86_64.AppImage`, path.join(buildStage, `FaNotes-${version}-x86_64.AppImage`)],
    [`FaNotes-${version}-x86_64.tar.gz`, path.join(buildStage, `FaNotes-${version}-x86_64.tar.gz`)],
    [`FaNotes-Setup-${version}-x64.exe`, path.join(buildStage, `FaNotes-Setup-${version}-x64.exe`)],
    [`FaNotes-Setup-${version}-x64.exe.blockmap`, path.join(buildStage, `FaNotes-Setup-${version}-x64.exe.blockmap`)],
    [`FaNotes-Portable-${version}-x64.exe`, path.join(buildStage, `FaNotes-Portable-${version}-x64.exe`)],
    [path.basename(deltaFiles.linux), deltaFiles.linux],
    [path.basename(deltaFiles.windows), deltaFiles.windows],
    [`app-${version}-linux.asar`, linuxAsar],
    [`app-${version}-windows.asar`, windowsAsar],
    ['CHANGELOG.md', path.join(root, 'CHANGELOG.md')],
    ['README.md', path.join(root, 'README.md')],
    ['INSTALL_ARCH.md', path.join(root, 'packaging', 'INSTALL_ARCH.md')],
    ['INSTALL_WINDOWS.md', path.join(root, 'packaging', 'INSTALL_WINDOWS.md')],
    ['PKGBUILD', path.join(root, 'packaging', 'PKGBUILD')],
    ['LICENSE', path.join(root, 'packaging', 'LICENSE')],
    ['THIRD_PARTY_NOTICES.md', path.join(root, 'packaging', 'THIRD_PARTY_NOTICES.md')],
    ['LICENSE-OFL-1.1.txt', path.join(root, 'packaging', 'LICENSE-OFL-1.1.txt')],
    ['LICENSE-ONNXRUNTIME-MIT.txt', path.join(root, 'packaging', 'LICENSE-ONNXRUNTIME-MIT.txt')],
    ['LICENSE-PYLAIA-MIT.txt', path.join(root, 'packaging', 'LICENSE-PYLAIA-MIT.txt')],
    ['LICENSE-TRANSFORMERS-APACHE-2.0.txt', path.join(root, 'packaging', 'LICENSE-TRANSFORMERS-APACHE-2.0.txt')],
    ['LICENSE-TROCR-MIT.txt', path.join(root, 'packaging', 'LICENSE-TROCR-MIT.txt')],
    ['fanotes.desktop', path.join(root, 'packaging', 'fanotes.desktop')],
    ['fanotes.svg', path.join(root, 'packaging', 'fanotes.svg')],
  ])

  await fsp.mkdir(output, { recursive: true, mode: 0o700 })
  for (const [fileName, source] of sources) {
    await regularFile(source)
    const target = path.join(output, fileName)
    await fsp.copyFile(source, target)
    await fsp.chmod(target, fileName.endsWith('.AppImage') ? 0o755 : 0o644)
  }

  const sums = new Map()
  if (args['previous-sums']) {
    const previousText = await fsp.readFile(path.resolve(args['previous-sums']), 'utf8')
    for (const line of previousText.split(/\r?\n/u)) {
      const match = /^([a-f0-9]{64})\s+\*?([^/\\]+)$/iu.exec(line.trim())
      if (match) sums.set(match[2], match[1].toLowerCase())
    }
  }
  for (const fileName of [...sources.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    sums.set(fileName, await sha256File(path.join(output, fileName)))
  }
  const sumLines = [...sums]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([fileName, digest]) => `${digest}  ${fileName}`)
  const temporarySums = path.join(output, `.SHA256SUMS-${process.pid}.tmp`)
  await fsp.writeFile(temporarySums, `${sumLines.join('\n')}\n`, { mode: 0o600 })
  await fsp.rename(temporarySums, path.join(output, 'SHA256SUMS'))
  console.log(`Release ${version} vorbereitet: ${sources.size} Dateien, ${sums.size} SHA-256-Prüfsummen einschließlich der weiterhin gültigen Basisdateien.`)
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
