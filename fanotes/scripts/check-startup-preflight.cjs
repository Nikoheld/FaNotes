'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  ALLOWED_MEMORY_BUDGETS_MB,
  cleanupStaleSingletonLocks,
  configureDesktopGpu,
  configureLeanChromiumStartup,
  configureLinuxGraphics,
  configureLinuxInputPlatform,
  linuxWindowFrameOptions,
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

  const ozone = mockCommandLine({ 'ozone-platform-hint': 'wayland', 'disable-features': 'ExistingFeature' })
  const ozoneResult = configureLinuxInputPlatform({ commandLine: ozone }, { HOME: '' })
  assert.equal(ozoneResult.ozone, 'x11')
  assert.equal(ozone.getSwitchValue('ozone-platform'), 'x11')
  assert.equal(ozone.getSwitchValue('ozone-platform-hint'), 'x11', 'a leftover Wayland hint must not keep Ozone on Wayland')
  assert.equal(ozone.hasSwitch('force-device-scale-factor'), false, 'must not blindly force scale 2')

  const hyprConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-hypr-')), 'hyprland.conf')
  temporaryProfiles.push(path.dirname(hyprConfig))
  fs.writeFileSync(hyprConfig, 'xwayland {\n  force_zero_scaling = true\n}\n')
  const scaled = mockCommandLine()
  const scaledResult = configureLinuxInputPlatform(
    { commandLine: scaled },
    { FANOTES_HYPRLAND_CONFIG: hyprConfig, HOME: '' },
  )
  assert.equal(scaledResult.hyprlandZeroScaling, true)
  assert.equal(scaledResult.scaleFactor, 2)
  assert.equal(scaled.getSwitchValue('force-device-scale-factor'), '2')

  const sourcedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-hypr-'))
  temporaryProfiles.push(sourcedDir)
  const sourcedMain = path.join(sourcedDir, 'hyprland.conf')
  const sourcedExtra = path.join(sourcedDir, 'looks.conf')
  fs.writeFileSync(sourcedMain, 'source = ./looks.conf\nmonitor = ,preferred,auto,2\n')
  fs.writeFileSync(sourcedExtra, 'xwayland {\n  force_zero_scaling = true\n}\n')
  const sourced = mockCommandLine()
  const sourcedResult = configureLinuxInputPlatform(
    { commandLine: sourced },
    { FANOTES_HYPRLAND_CONFIG: sourcedMain, HOME: '' },
  )
  assert.equal(sourcedResult.hyprlandZeroScaling, true, 'force_zero_scaling in a sourced Hyprland file must apply')
  assert.equal(sourced.getSwitchValue('force-device-scale-factor'), '2')

  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-hypr-home-'))
  temporaryProfiles.push(homeDir)
  const defaultHypr = path.join(homeDir, '.config', 'hypr')
  fs.mkdirSync(defaultHypr, { recursive: true })
  fs.writeFileSync(path.join(defaultHypr, 'hyprland.conf'), 'source = ~/.config/hypr/monitors.conf\n')
  fs.writeFileSync(path.join(defaultHypr, 'monitors.conf'), 'force_zero_scaling = true\n')
  const homeScaled = mockCommandLine()
  const homeResult = configureLinuxInputPlatform(
    { commandLine: homeScaled },
    { HOME: homeDir },
  )
  assert.equal(homeResult.hyprlandZeroScaling, true, 'the usual ~/.config/hypr source = include must apply')
  assert.equal(homeScaled.getSwitchValue('force-device-scale-factor'), '2')

  const commentedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-hypr-')), 'hyprland.conf')
  temporaryProfiles.push(path.dirname(commentedFile))
  fs.writeFileSync(commentedFile, '# force_zero_scaling = true\nsource = ./missing.conf\n')
  const commented = mockCommandLine()
  const commentedResult = configureLinuxInputPlatform(
    { commandLine: commented },
    { FANOTES_HYPRLAND_CONFIG: commentedFile, HOME: '' },
  )
  assert.equal(commentedResult.hyprlandZeroScaling, false, 'a commented force_zero_scaling line must not force scale 2')
  assert.equal(commented.hasSwitch('force-device-scale-factor'), false)

  const plainHypr = mockCommandLine()
  const plainFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fanotes-hypr-')), 'hyprland.conf')
  temporaryProfiles.push(path.dirname(plainFile))
  fs.writeFileSync(plainFile, 'xwayland {\n  force_zero_scaling = false\n}\n')
  const plainResult = configureLinuxInputPlatform(
    { commandLine: plainHypr },
    { FANOTES_HYPRLAND_CONFIG: plainFile, HOME: '' },
  )
  assert.equal(plainResult.hyprlandZeroScaling, false)
  assert.equal(plainResult.scaleFactor, null)
  assert.equal(plainHypr.hasSwitch('force-device-scale-factor'), false)

  const missingHypr = mockCommandLine()
  const missingResult = configureLinuxInputPlatform(
    { commandLine: missingHypr },
    { HOME: path.join(os.tmpdir(), 'fanotes-no-hypr-home') },
  )
  assert.equal(missingResult.hyprlandZeroScaling, false)
  assert.equal(missingHypr.hasSwitch('force-device-scale-factor'), false)

  const chrome = linuxWindowFrameOptions()
  assert.equal(chrome.frame, true, 'Hyprland must own the real window frame')
  assert.equal(chrome.titleBarStyle, 'default', 'no custom in-app title bar')
  assert.notEqual(chrome.titleBarStyle, 'hidden')
  assert.equal(chrome.autoHideMenuBar, true)

  const leanChromium = mockCommandLine({ 'disable-features': 'ExistingFeature' })
  configureLeanChromiumStartup({ commandLine: leanChromium })
  assert.equal(leanChromium.hasSwitch('disable-background-networking'), true)
  assert.equal(leanChromium.hasSwitch('disable-component-update'), true)
  assert.ok(leanChromium.getSwitchValue('disable-features').includes('OptimizationHints'))
  const gpuChromium = mockCommandLine()
  assert.equal(configureDesktopGpu({ commandLine: gpuChromium }).gpuRasterization, true)
  assert.equal(gpuChromium.hasSwitch('enable-gpu-rasterization'), true)
  assert.ok(gpuChromium.getSwitchValue('enable-features').includes('CanvasOopRasterization'))

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
  const installArch = fs.readFileSync(path.join(root, 'packaging', 'INSTALL_ARCH.md'), 'utf8')
  assert.match(installArch, /Ozone X11/u, 'Arch notes must describe Ozone X11 as the Linux seat-sharing path')
  assert.match(installArch, /source =/u, 'Arch notes must mention Hyprland source includes for force_zero_scaling')
  assert.doesNotMatch(installArch, /Electron erkennt eine Wayland-Sitzung/u)
  assert.doesNotMatch(installArch, /fanotes --ozone-platform=x11/u, 'X11 is the built-in default, not an optional fallback')
  assert.match(mainSource, /configureLinuxInputPlatform\(app\)/)
  assert.match(mainSource, /linuxWindowFrameOptions\(\)/, 'the shipped window chrome helper must create the Linux window')
  assert.doesNotMatch(mainSource, /titleBarStyle:\s*'hidden'|titleBarOverlay/u, 'Hyprland decorations need the compositor-owned frame')
  assert.doesNotMatch(mainSource, /evdev|uinput|virtual tablet/i)
  const preloadSource = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.deepEqual(packageMetadata.build.asarUnpack, ['dist/ocr/pylaia-iam.onnx'])
  const hardeningSource = fs.readFileSync(path.join(root, 'scripts', 'harden-appimage.cjs'), 'utf8')
  assert.doesNotMatch(mainSource.slice(0, 4000), /require\('\.\/updater\.cjs'\)/u, 'Der Updater darf den Main-Prozess nicht vor dem Fenster blockieren.')
  assert.doesNotMatch(mainSource.slice(0, 4000), /onnxruntime-node/u, 'Die native OCR-Laufzeit darf nicht während des Starts geladen werden.')
  assert.match(mainSource, /function ensureUpdateManager\(\)[\s\S]*require\('\.\/updater\.cjs'\)/u)
  assert.match(mainSource, /show:\s*false/u, 'Das Fenster darf nicht vor dem ersten gerenderten Frame aufblitzen.')
  assert.match(mainSource, /ready-to-show/u, 'Das Fenster erscheint erst wenn der Renderer bereit ist.')
  assert.match(mainSource, /configureDesktopGpu\(app\)/u, 'GPU-Rasterisierung muss vor dem Fenster aktiv sein.')
  assert.match(mainSource, /render-process-gone/u, 'Ein abgestürztes Notizfenster muss sich selbst neu laden.')
  assert.match(mainSource, /unhandledRejection/u, 'Unbehandelte Main-Promises dürfen den Prozess nicht still beenden.')
  assert.match(mainSource, /const \{ createEnhancedMathService \} = require\('\.\/enhanced-math\.cjs'\)/u, 'Formel-OCR darf den Main-Prozess nicht vor der ersten Nutzung laden.')
  assert.match(mainSource, /const \{ createQwenVisionService \} = require\('\.\/qwen-vision\.cjs'\)/u, 'Qwen darf den Main-Prozess nicht vor der ersten Nutzung laden.')
  assert.doesNotMatch(mainSource.slice(0, 2500), /require\('\.\/enhanced-math\.cjs'\)/u, 'enhanced-math.cjs darf nicht oben in main.cjs stehen.')
  assert.match(mainSource, /spellcheck:\s*false/u, 'Die lokale FaNotes-Prüfung darf Chromiums native Wörterbuchprozesse beim Start nicht laden.')
  assert.doesNotMatch(mainSource, /setSpellCheckerLanguages|configureSpellChecker/u, 'Native Chromium-Wörterbücher würden CPU und I/O doppelt zur lokalen Prüfung verbrauchen.')
  assert.match(mainSource, /const updaterTimer = setTimeout\(\(\) => \{[\s\S]*?\}, 5_000\)/u, 'Der Auto-Updater muss weit außerhalb des interaktiven Startfensters bleiben.')
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
  assert.match(appSource, /STARTUP_DOCUMENT_LAYER_DELAY_MS\s*=\s*160/u, 'Tinte der ersten Notiz lädt schnell, ohne den Editor zu blockieren.')
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
