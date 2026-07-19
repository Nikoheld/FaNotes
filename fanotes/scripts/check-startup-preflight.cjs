'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  ALLOWED_MEMORY_BUDGETS_MB,
  cleanupStaleSingletonLocks,
  configureLeanChromiumStartup,
  configureLinuxGraphics,
  readStartupResourceLimits,
  VULKAN_FEATURES,
} = require('../electron/startup-preflight.cjs')

if (process.platform !== 'linux') {
  console.log('Startup-Preflight ist nur für die Linux-Auslieferung relevant.')
  process.exit(0)
}

const temporaryProfiles = []

function linkExists(target) {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function makeProfile(owner) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-lock-test-'))
  temporaryProfiles.push(directory)
  fs.symlinkSync(owner, path.join(directory, 'SingletonLock'))
  fs.symlinkSync('cookie', path.join(directory, 'SingletonCookie'))
  fs.symlinkSync(path.join(directory, 'missing', 'SingletonSocket'), path.join(directory, 'SingletonSocket'))
  return directory
}

function mockCommandLine(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    appendSwitch(name, value = '') { values.set(name, value) },
    removeSwitch(name) { values.delete(name) },
    getSwitchValue(name) { return values.get(name) ?? '' },
    hasSwitch(name) { return values.has(name) },
  }
}

try {
  const dead = makeProfile(`${os.hostname()}-2147483646`)
  assert.deepEqual(
    cleanupStaleSingletonLocks(dead).removed.sort(),
    ['SingletonCookie', 'SingletonLock', 'SingletonSocket'],
  )
  assert.equal(linkExists(path.join(dead, 'SingletonLock')), false)

  const live = makeProfile(`${os.hostname()}-${process.pid}`)
  assert.equal(cleanupStaleSingletonLocks(live).reason, 'owner-active-or-uncertain')
  assert.equal(linkExists(path.join(live, 'SingletonLock')), true)

  const foreignFresh = makeProfile(`anderer-host-${process.pid}`)
  assert.equal(cleanupStaleSingletonLocks(foreignFresh).reason, 'owner-active-or-uncertain')
  assert.equal(linkExists(path.join(foreignFresh, 'SingletonLock')), true)

  const foreignOld = makeProfile(`alter-host-${process.pid}`)
  const oldTime = new Date(Date.now() - 10 * 60 * 1000)
  fs.lutimesSync(path.join(foreignOld, 'SingletonLock'), oldTime, oldTime)
  assert.equal(cleanupStaleSingletonLocks(foreignOld).reason, 'owner-active-or-uncertain')
  assert.equal(linkExists(path.join(foreignOld, 'SingletonLock')), true)

  const regular = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-lock-test-'))
  temporaryProfiles.push(regular)
  fs.writeFileSync(path.join(regular, 'SingletonLock'), 'do-not-delete')
  assert.equal(cleanupStaleSingletonLocks(regular).reason, 'no-symlink-lock')
  assert.equal(fs.readFileSync(path.join(regular, 'SingletonLock'), 'utf8'), 'do-not-delete')

  const wayland = mockCommandLine({ 'disable-features': 'ExistingFeature' })
  assert.equal(
    configureLinuxGraphics({ commandLine: wayland }, { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1' }).mode,
    'wayland-vulkan-disabled',
  )
  assert.equal(wayland.getSwitchValue('use-angle'), '')
  assert.ok(wayland.getSwitchValue('disable-features').split(',').includes('ExistingFeature'))
  for (const feature of VULKAN_FEATURES) {
    assert.ok(wayland.getSwitchValue('disable-features').split(',').includes(feature))
  }

  const manualVulkan = mockCommandLine({ 'use-angle': 'vulkan', 'enable-features': 'Vulkan,ExistingFeature' })
  assert.equal(
    configureLinuxGraphics({ commandLine: manualVulkan }, { XDG_SESSION_TYPE: 'wayland' }).mode,
    'wayland-vulkan-overridden',
  )
  assert.equal(manualVulkan.getSwitchValue('use-angle'), 'gl')
  assert.equal(manualVulkan.getSwitchValue('enable-features'), 'ExistingFeature')
  for (const feature of VULKAN_FEATURES) {
    assert.ok(manualVulkan.getSwitchValue('disable-features').split(',').includes(feature))
  }

  const environmentOverride = mockCommandLine()
  assert.equal(
    configureLinuxGraphics({ commandLine: environmentOverride }, { XDG_SESSION_TYPE: 'wayland', FANOTES_ENABLE_VULKAN: '1' }).mode,
    'wayland-vulkan-explicit',
  )

  const x11 = mockCommandLine({ 'ozone-platform': 'x11' })
  assert.equal(
    configureLinuxGraphics({ commandLine: x11 }, { XDG_SESSION_TYPE: 'wayland' }).mode,
    'platform-default',
  )
  assert.equal(x11.getSwitchValue('use-angle'), '')

  const leanChromium = mockCommandLine({ 'disable-features': 'ExistingFeature' })
  configureLeanChromiumStartup({ commandLine: leanChromium })
  assert.equal(leanChromium.hasSwitch('disable-background-networking'), true)
  assert.equal(leanChromium.hasSwitch('disable-component-update'), true)
  assert.ok(leanChromium.getSwitchValue('disable-features').includes('OptimizationHints'))

  const resourceProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-resource-test-'))
  temporaryProfiles.push(resourceProfile)
  fs.writeFileSync(path.join(resourceProfile, 'config.json'), JSON.stringify({ settings: { memoryBudgetMb: 3072 } }))
  assert.deepEqual(readStartupResourceLimits(resourceProfile), { memoryBudgetMb: 3072 })
  assert.deepEqual(ALLOWED_MEMORY_BUDGETS_MB, [1536, 2048, 3072, 4096, 6144, 8192])
  const limitedChromium = mockCommandLine({ 'js-flags': '--expose-gc --max-old-space-size=9999' })
  assert.equal(configureLeanChromiumStartup({ commandLine: limitedChromium }, { memoryBudgetMb: 3072 }).memoryBudgetMb, 3072)
  assert.equal(limitedChromium.getSwitchValue('js-flags'), '--expose-gc --max-old-space-size=3072')
  fs.writeFileSync(path.join(resourceProfile, 'config.json'), JSON.stringify({ settings: { memoryBudgetMb: '3072' } }))
  assert.deepEqual(readStartupResourceLimits(resourceProfile), { memoryBudgetMb: 0 }, 'Ein typfremder RAM-Wert darf nicht als Startflag übernommen werden.')
  fs.writeFileSync(path.join(resourceProfile, 'config.json'), JSON.stringify({ settings: { memoryBudgetMb: 1024 } }))
  assert.deepEqual(readStartupResourceLimits(resourceProfile), { memoryBudgetMb: 0 }, 'Nicht angebotene oder manipulierte RAM-Werte müssen ignoriert werden.')

  const symlinkProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-resource-test-'))
  temporaryProfiles.push(symlinkProfile)
  fs.symlinkSync(path.join(resourceProfile, 'config.json'), path.join(symlinkProfile, 'config.json'))
  assert.deepEqual(readStartupResourceLimits(symlinkProfile), { memoryBudgetMb: 0 }, 'Die Startkonfiguration darf keinem Symlink folgen.')

  const root = path.resolve(__dirname, '..')
  const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.deepEqual(packageMetadata.build.asarUnpack, ['dist/ocr/pylaia-iam.onnx'])
  const hardeningSource = fs.readFileSync(path.join(root, 'scripts', 'harden-appimage.cjs'), 'utf8')
  assert.doesNotMatch(mainSource.slice(0, 4000), /require\('\.\/updater\.cjs'\)/u, 'Der Updater darf den Main-Prozess nicht vor dem Fenster blockieren.')
  assert.doesNotMatch(mainSource.slice(0, 4000), /onnxruntime-node/u, 'Die native OCR-Laufzeit darf nicht während des Starts geladen werden.')
  assert.match(mainSource, /function ensureUpdateManager\(\)[\s\S]*require\('\.\/updater\.cjs'\)/u)
  assert.match(mainSource, /spellcheck:\s*false/u, 'Die lokale FaNotes-Prüfung darf Chromiums native Wörterbuchprozesse beim Start nicht laden.')
  assert.doesNotMatch(mainSource, /setSpellCheckerLanguages|configureSpellChecker/u, 'Native Chromium-Wörterbücher würden CPU und I/O doppelt zur lokalen Prüfung verbrauchen.')
  assert.match(mainSource, /\},\s*24_000\)/u, 'Der Auto-Updater muss weit außerhalb des interaktiven Startfensters bleiben.')
  assert.match(mainSource, /protectedSettingsOnDisk/u, 'Geschützte AI-Schlüssel dürfen den Linux-Keyring nicht während des normalen Starts wecken.')
  assert.match(mainSource, /handle\(IPC\.loadSecureSettings/u, 'Geschützte AI-Schlüssel werden erst beim Öffnen des AI-Menüs geladen.')
  assert.match(mainSource, /async function readFastTreeDirectory/u)
  assert.match(mainSource, /function treeCachePath/u)
  assert.match(mainSource, /LEGACY_MIGRATION_COMPLETE/u, 'Die einmalige Altprofil-Suche braucht einen persistenten Abschlussmarker.')
  assert.match(mainSource, /ROOT_VALIDATION_LEASE_MS/u, 'Doppelte Root-Prüfungen desselben Startvorgangs müssen zusammengefasst werden.')
  assert.match(mainSource, /handle\(IPC\.getCachedTree[\s\S]*ensureQuickBootstrap\(\)/u, 'Der lokale Baum-Cache darf nicht auf den NAS-Vault warten.')
  assert.match(preloadSource, /getCachedTree:\s*\(\)/u)
  assert.match(preloadSource, /getFastTree:\s*\(\)/u)
  assert.match(preloadSource, /reportRendererReady:\s*\(\)/u)
  assert.match(appSource, /startupBootstrap\s*\?\?\s*window\.fanotes\.bootstrap\(\)/u, 'Lokale Config und englischer Katalog sollen parallel laden.')
  assert.match(appSource, /cachedTree\s*\?\?\s*await window\.fanotes\.getFastTree\(\)/u)
  assert.match(appSource, /markdownEditorModulePromise/u, 'Der Editor-Chunk soll beim parallelen Warmup nur einmal angefordert werden.')
  assert.match(appSource, /const FirstRunOnboarding = lazy/u, 'Die einmalige Fächerauswahl darf normale Starts nicht vergrößern.')
  assert.match(appSource, /requestIdleCallback[\s\S]*loadFreshTree/u)
  assert.match(appSource, /STARTUP_TREE_REFRESH_DELAY_MS\s*=\s*18_000/u, 'Der vollständige Vault-Abgleich darf nicht in die Startphase fallen.')
  assert.match(appSource, /STARTUP_DOCUMENT_LAYER_DELAY_MS\s*=\s*900/u, 'Tinte und Arbeitsblätter der ersten Notiz dürfen nicht mit dem Editor konkurrieren.')
  assert.match(mainSource, /require\('\.\/onenote-importer\.cjs'\)/u, 'Der OneNote-Importer muss explizit und verzögert geladen werden.')
  assert.match(mainSource, /new Worker\(path\.join\(__dirname, 'native-ocr-worker\.cjs'\)/u, 'Native ONNX-Inferenz muss ausserhalb des Electron-Hauptthreads laufen.')
  assert.match(mainSource, /currentSettings\.ocrModelKeepAliveSeconds/u, 'Der native Modellworker muss das konfigurierbare RAM-Freigabeintervall verwenden.')
  assert.deepEqual(packageMetadata.dependencies ?? {}, {}, 'Vollständig gebündelte Renderer-Abhängigkeiten dürfen nicht nochmals als Laufzeit-node_modules ausgeliefert werden.')
  assert.deepEqual(
    packageMetadata.build?.electronLanguages,
    ['de', 'en-US'],
    'FaNotes darf nicht alle Chromium-Sprachpakete ausliefern; die Oberfläche unterstützt Deutsch und Englisch.',
  )
  assert.equal(packageMetadata.build?.compression, 'normal', 'Die Linux-Auslieferung darf nicht mit CPU-intensiver Maximum-/XZ-Kompression starten.')
  const nativeFilters = [
    ...(packageMetadata.build?.linux?.extraResources?.flatMap((entry) => entry.filter ?? []) ?? []),
    ...(packageMetadata.build?.win?.extraResources?.flatMap((entry) => entry.filter ?? []) ?? []),
  ]
  assert.doesNotMatch(nativeFilters.join('\n'), /cuda|tensorrt|directml/iu, 'FaNotes darf keine ungenutzten GPU-Runtimes in den nativen CPU-Pfad packen.')
  assert.match(hardeningSource, /'-comp',\s*'gzip'/u, 'Die AppImage-Härtung darf die startfreundliche Gzip-Kompression nicht wieder durch XZ ersetzen.')
  assert.doesNotMatch(hardeningSource, /'-comp',\s*'xz'/u, 'XZ verursacht bei AppImage-Fallback-Starts unnötig hohe CPU-Last.')

  console.log('Startup-Preflight: Lock-/Grafik-Szenarien sowie schlanker Chromium-Start, lokaler Cache, lazy Keyring, Editor-Warmup, startfreundliches AppImage und stark verzögerte Hintergrundarbeit bestanden.')
} finally {
  temporaryProfiles.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
}
