'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SINGLETON_NAMES = Object.freeze(['SingletonCookie', 'SingletonSocket', 'SingletonLock'])
const VULKAN_FEATURES = Object.freeze(['Vulkan', 'DefaultANGLEVulkan', 'VulkanFromANGLE'])
const UNUSED_CHROMIUM_FEATURES = Object.freeze([
  'AutofillServerCommunication',
  'CertificateTransparencyComponentUpdater',
  'GlobalMediaControls',
  'InterestFeedContentSuggestions',
  'MediaRouter',
  'OptimizationHints',
  'Translate',
])
const DESKTOP_GPU_FEATURES = Object.freeze([
  'CanvasOopRasterization',
])
const ALLOWED_MEMORY_BUDGETS_MB = Object.freeze([1536, 2048, 3072, 4096, 6144, 8192])

function commaSeparated(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

function mergeSwitchValues(commandLine, name, additions) {
  const values = new Set(commaSeparated(commandLine.getSwitchValue(name)))
  additions.forEach((value) => values.add(value))
  commandLine.appendSwitch(name, [...values].join(','))
}

function removeSwitchValues(commandLine, name, removals) {
  const blocked = new Set(removals.map((value) => value.toLocaleLowerCase('en-US')))
  const values = commaSeparated(commandLine.getSwitchValue(name))
    .filter((value) => !blocked.has(value.toLocaleLowerCase('en-US')))
  commandLine.removeSwitch?.(name)
  if (values.length) commandLine.appendSwitch(name, values.join(','))
}

const HYPRLAND_MAX_FILES = 24
const HYPRLAND_MAX_BYTES = 256 * 1024

function stripHyprlandComment(line) {
  const hash = String(line).indexOf('#')
  return hash === -1 ? String(line) : String(line).slice(0, hash)
}

function expandHyprlandPath(raw, environment, fromDir) {
  let value = String(raw ?? '').trim().replace(/^['"]|['"]$/gu, '')
  if (!value) return ''
  const home = typeof environment.HOME === 'string' ? environment.HOME : ''
  const xdg = typeof environment.XDG_CONFIG_HOME === 'string' && environment.XDG_CONFIG_HOME
    ? environment.XDG_CONFIG_HOME
    : (home ? path.join(home, '.config') : '')
  if (value === '~') {
    value = home
  } else if (value.startsWith('~/')) {
    value = home ? path.join(home, value.slice(2)) : ''
  }
  value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced, bare) => {
    const name = braced || bare
    if (name === 'HOME') return home
    if (name === 'XDG_CONFIG_HOME') return xdg
    const found = environment[name]
    return typeof found === 'string' ? found : ''
  })
  if (!value) return ''
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(fromDir, value)
}

function resolveHyprlandSourceTargets(pattern, environment, fromDir) {
  const expanded = expandHyprlandPath(pattern, environment, fromDir)
  if (!expanded) return []
  if (!/[*?\[]/u.test(expanded)) return [expanded]
  try {
    return fs.globSync(expanded).filter(Boolean).sort()
  } catch {
    return []
  }
}

function scanHyprlandForceZeroScaling(filePath, environment, readFile, visited) {
  const resolved = path.resolve(filePath)
  if (visited.has(resolved) || visited.size >= HYPRLAND_MAX_FILES) return null
  visited.add(resolved)
  let text
  try {
    const info = fs.statSync(resolved)
    if (!info.isFile() || info.size <= 0 || info.size > HYPRLAND_MAX_BYTES) return null
    text = readFile(resolved, 'utf8')
  } catch {
    return null
  }
  let last = null
  const fromDir = path.dirname(resolved)
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = stripHyprlandComment(rawLine).trim()
    if (!line) continue
    const source = /^source\s*=\s*(.+)$/iu.exec(line)
    if (source) {
      for (const target of resolveHyprlandSourceTargets(source[1], environment, fromDir)) {
        const nested = scanHyprlandForceZeroScaling(target, environment, readFile, visited)
        if (nested !== null) last = nested
      }
      continue
    }
    const scaling = /^force_zero_scaling\s*=\s*(true|false)\b/iu.exec(line)
    if (scaling) last = scaling[1].toLocaleLowerCase('en-US') === 'true'
  }
  return last
}

function readHyprlandForceZeroScaling(environment = process.env, readFile = fs.readFileSync) {
  const configured = typeof environment.FANOTES_HYPRLAND_CONFIG === 'string'
    ? environment.FANOTES_HYPRLAND_CONFIG.trim()
    : ''
  const home = typeof environment.HOME === 'string' ? environment.HOME : ''
  const roots = configured
    ? [configured]
    : (home ? [path.join(home, '.config', 'hypr', 'hyprland.conf')] : [])
  for (const file of roots) {
    if (scanHyprlandForceZeroScaling(file, environment, readFile, new Set())) return true
  }
  return false
}

function linuxWindowFrameOptions() {
  return Object.freeze({
    frame: true,
    titleBarStyle: 'default',
    autoHideMenuBar: true,
  })
}

function linuxOzoneLaunchPlan() {
  return {
    platform: 'x11',
    env: Object.freeze({ ELECTRON_OZONE_PLATFORM_HINT: 'x11' }),
    argv: Object.freeze(['--ozone-platform=x11', '--ozone-platform-hint=x11']),
  }
}

function linuxOzoneDesktopExec(binary = 'fanotes') {
  return `${binary} ${linuxOzoneLaunchPlan().argv.join(' ')}`
}

function linuxOzoneAppRunExecLine(binaryExpression) {
  const plan = linuxOzoneLaunchPlan()
  const exports = Object.entries(plan.env).map(([name, value]) => `export ${name}=${value}`).join('\n')
  return `${exports}\nexec ${binaryExpression} ${plan.argv.join(' ')} "$@"`
}

function applyLinuxOzoneLaunchEnvironment(environment = process.env, argv = process.argv) {
  if (process.platform !== 'linux') {
    return { ozone: null, environment, argv }
  }
  const plan = linuxOzoneLaunchPlan()
  for (const [name, value] of Object.entries(plan.env)) environment[name] = value
  for (const flag of plan.argv) {
    const separator = flag.indexOf('=')
    const name = separator === -1 ? flag : flag.slice(0, separator)
    const prefix = `${name}=`
    const present = argv.some((item) => (
      item === flag || item === name || (typeof item === 'string' && item.startsWith(prefix))
    ))
    if (!present) argv.push(flag)
  }
  return { ozone: plan.platform, environment, argv }
}

function configureLinuxInputPlatform(electronApp, environment = process.env) {
  if (process.platform !== 'linux') {
    return { ozone: null, scaleFactor: null, hyprlandZeroScaling: false }
  }
  const commandLine = electronApp.commandLine
  commandLine.appendSwitch('ozone-platform', 'x11')
  commandLine.appendSwitch('ozone-platform-hint', 'x11')
  const hyprlandZeroScaling = readHyprlandForceZeroScaling(environment)
  if (hyprlandZeroScaling) commandLine.appendSwitch('force-device-scale-factor', '2')
  return {
    ozone: 'x11',
    scaleFactor: hyprlandZeroScaling ? 2 : null,
    hyprlandZeroScaling,
  }
}

function configureLinuxGraphics(electronApp, environment = process.env) {
  if (process.platform !== 'linux') return { mode: 'platform-default' }
  const commandLine = electronApp.commandLine
  const ozonePlatform = commandLine.getSwitchValue('ozone-platform').toLocaleLowerCase('en-US')
  const ozoneHint = commandLine.getSwitchValue('ozone-platform-hint').toLocaleLowerCase('en-US')
  const sessionType = String(environment.XDG_SESSION_TYPE ?? '').toLocaleLowerCase('en-US')
  const explicitX11 = ozonePlatform === 'x11' || ozoneHint === 'x11'
  const nativeWayland = !explicitX11 && (
    ozonePlatform === 'wayland' ||
    ozoneHint === 'wayland' ||
    sessionType === 'wayland' ||
    Boolean(environment.WAYLAND_DISPLAY)
  )

  if (!nativeWayland) return { mode: 'platform-default' }
  if (environment.FANOTES_ENABLE_VULKAN === '1') return { mode: 'wayland-vulkan-explicit' }

  const angleBackend = commandLine.getSwitchValue('use-angle').toLocaleLowerCase('en-US')
  const glBackend = commandLine.getSwitchValue('use-gl').toLocaleLowerCase('en-US')
  const forcedVulkan = angleBackend === 'vulkan'
  const explicitBackend = Boolean(angleBackend || glBackend || commandLine.hasSwitch('disable-gpu'))

  removeSwitchValues(commandLine, 'enable-features', VULKAN_FEATURES)
  mergeSwitchValues(commandLine, 'disable-features', VULKAN_FEATURES)
  // A stale desktop entry or ELECTRON flags must not re-introduce Vulkan into
  // a native Wayland session. OpenGL/EGL remains GPU accelerated. The explicit
  // FANOTES_ENABLE_VULKAN escape hatch above is retained for diagnostics.
  if (forcedVulkan) commandLine.appendSwitch('use-angle', 'gl')
  return { mode: forcedVulkan ? 'wayland-vulkan-overridden' : explicitBackend ? 'wayland-user-backend' : 'wayland-vulkan-disabled' }
}

function readStartupResourceLimits(userDataPath) {
  const fallback = { memoryBudgetMb: 0 }
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) return fallback
  const target = path.join(userDataPath, 'config.json')
  try {
    const info = fs.lstatSync(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 2 * 1024 * 1024) return fallback
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'))
    const memoryBudgetMb = parsed?.settings?.memoryBudgetMb
    return {
      memoryBudgetMb: Number.isSafeInteger(memoryBudgetMb) && ALLOWED_MEMORY_BUDGETS_MB.includes(memoryBudgetMb)
        ? memoryBudgetMb
        : 0,
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('FaNotes-Ressourcenlimit konnte beim Start nicht gelesen werden:', error?.message ?? error)
    return fallback
  }
}

function configureDesktopGpu(electronApp) {
  const commandLine = electronApp.commandLine
  commandLine.appendSwitch('enable-gpu-rasterization')
  mergeSwitchValues(commandLine, 'enable-features', DESKTOP_GPU_FEATURES)
  // Older school laptops often sit on Chromium's GPU blocklist even though
  // their Intel/AMD chips still composite a notes app correctly.
  if (process.platform === 'win32') commandLine.appendSwitch('ignore-gpu-blocklist')
  return { gpuRasterization: true, ignoreGpuBlocklist: process.platform === 'win32' }
}

function configureLeanChromiumStartup(electronApp, resourceLimits = {}) {
  const commandLine = electronApp.commandLine
  for (const name of [
    'disable-background-networking',
    'disable-breakpad',
    'disable-component-extensions-with-background-pages',
    'disable-component-update',
    'disable-default-apps',
    'disable-domain-reliability',
    'disable-hang-monitor',
    'disable-sync',
    'metrics-recording-only',
    'no-first-run',
  ]) commandLine.appendSwitch(name)
  mergeSwitchValues(commandLine, 'disable-features', UNUSED_CHROMIUM_FEATURES)
  const memoryBudgetMb = ALLOWED_MEMORY_BUDGETS_MB.includes(resourceLimits.memoryBudgetMb)
    ? resourceLimits.memoryBudgetMb
    : 0
  if (memoryBudgetMb) {
    const existingFlags = commandLine.getSwitchValue('js-flags')
      .replace(/(?:^|\s)--max-old-space-size(?:=\d+|\s+\d+)/gu, ' ')
      .trim()
    commandLine.appendSwitch(
      'js-flags',
      [existingFlags, `--max-old-space-size=${memoryBudgetMb}`].filter(Boolean).join(' '),
    )
  }
  return { disabledFeatures: [...UNUSED_CHROMIUM_FEATURES], memoryBudgetMb }
}

function readLinkIfPresent(target) {
  try {
    const info = fs.lstatSync(target)
    if (!info.isSymbolicLink()) return null
    return { info, value: fs.readlinkSync(target) }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

function lockIsProvablyStale(lock) {
  const owner = /^(.*)-(\d+)$/.exec(lock.value)
  if (!owner || owner[1] !== os.hostname()) return false
  const ownerPid = Number(owner[2])
  return Number.isSafeInteger(ownerPid) && ownerPid > 1 && !processExists(ownerPid)
}

function unlinkSymlinkIfPresent(target) {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return false
    fs.unlinkSync(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function cleanupStaleSingletonLocks(userDataPath) {
  if (process.platform !== 'linux' || typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
    return { removed: [], reason: 'not-applicable' }
  }
  const lockPath = path.join(userDataPath, 'SingletonLock')
  const lock = readLinkIfPresent(lockPath)
  if (!lock) return { removed: [], reason: 'no-symlink-lock' }
  if (!lockIsProvablyStale(lock)) return { removed: [], reason: 'owner-active-or-uncertain' }

  const removed = []
  // Keep the lock itself until the end. This prevents another starting process
  // from creating fresh cookie/socket links while stale auxiliaries are removed.
  for (const name of SINGLETON_NAMES) {
    const target = path.join(userDataPath, name)
    if (name === 'SingletonLock') {
      const current = readLinkIfPresent(target)
      if (!current || current.value !== lock.value) return { removed, reason: 'lock-changed' }
    }
    if (unlinkSymlinkIfPresent(target)) removed.push(name)
  }
  return { removed, reason: removed.length ? 'stale-owner' : 'nothing-removed' }
}

module.exports = {
  SINGLETON_NAMES,
  VULKAN_FEATURES,
  DESKTOP_GPU_FEATURES,
  ALLOWED_MEMORY_BUDGETS_MB,
  cleanupStaleSingletonLocks,
  configureDesktopGpu,
  configureLeanChromiumStartup,
  applyLinuxOzoneLaunchEnvironment,
  configureLinuxGraphics,
  configureLinuxInputPlatform,
  linuxOzoneAppRunExecLine,
  linuxOzoneDesktopExec,
  linuxOzoneLaunchPlan,
  linuxWindowFrameOptions,
  readHyprlandForceZeroScaling,
  readStartupResourceLimits,
}
