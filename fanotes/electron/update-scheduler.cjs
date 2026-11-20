'use strict'

// Registers the background updater with the operating system, per user and
// without admin rights:
//
//   Windows  a Scheduled Task (schtasks /XML) that runs `FaNotes.exe
//            --background-update` at logon and every 6 hours, only on AC
//            power, when the computer is idle and a network is available,
//            below normal priority.
//   Linux    a systemd user timer (at login and every 6 hours, idle CPU and
//            I/O class) when `systemctl --user` works, otherwise an XDG
//            autostart entry that runs once per login. Both start a small
//            wrapper script that removes the timer, the entry and itself when
//            the AppImage it points to is gone.
//
// The app calls sync() on every start: it registers when the setting is on,
// rewrites the registration when the AppImage or install path changed, and
// removes everything when the setting is off. The NSIS uninstaller deletes the
// task by the same name (build/installer.nsh).

const crypto = require('node:crypto')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')

const BACKGROUND_ARG = '--background-update'
const SYSTEMD_UNIT = 'fanotes-background-update'
const AUTOSTART_FILE = 'fanotes-background-update.desktop'
const SCRIPT_FILE = 'background-update.sh'
const SCHEDULER_STATE_FILE = 'scheduler.json'

const defaultExec = (command, args, { timeoutMs = 15_000 } = {}) => new Promise((resolve) => {
  execFile(command, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (Number.isInteger(error.code) ? error.code : -1) : 0
    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') })
  })
})

// Characters Windows forbids in user names include every character a task
// name cannot hold, so a real user name passes unchanged; the NSIS uninstaller
// builds the same name from %USERNAME%.
const windowsTaskName = (userName) => `FaNotes Background Update (${String(userName || 'user').replace(/[\\/:*?"<>|\0-\x1f]/gu, '_').slice(0, 64)})`

const xmlEscape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

const assertSafePath = (value, label, platform) => {
  const absolute = platform === 'win32' ? path.win32.isAbsolute(value ?? '') : path.posix.isAbsolute(value ?? '')
  if (typeof value !== 'string' || !absolute || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} kann nicht sicher für Hintergrund-Updates eingetragen werden.`)
  }
  return value
}

function windowsTaskXml({ executable, userId }) {
  const user = xmlEscape(userId)
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>FaNotes</Author>
    <Description>Installiert FaNotes-Updates still, solange FaNotes geschlossen ist.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT3M</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT6H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <RandomDelay>PT30M</RandomDelay>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <Duration>PT5M</Duration>
      <WaitTimeout>PT2H</WaitTimeout>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>true</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>8</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(executable)}</Command>
      <Arguments>${BACKGROUND_ARG}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

// systemd unquotes, expands specifiers (%) and environment variables ($).
const systemdQuote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`

// Desktop Entry Exec quoting: ", `, $ and \ are escaped inside double quotes.
const desktopQuote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('`', '\\`').replaceAll('$', '\\$')}"`

function linuxPaths({ env, homeDir }) {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homeDir, '.config')
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homeDir, '.local', 'share')
  const unitDirectory = path.join(configHome, 'systemd', 'user')
  return {
    unitDirectory,
    service: path.join(unitDirectory, `${SYSTEMD_UNIT}.service`),
    timer: path.join(unitDirectory, `${SYSTEMD_UNIT}.timer`),
    autostart: path.join(configHome, 'autostart', AUTOSTART_FILE),
    script: path.join(dataHome, 'fanotes', SCRIPT_FILE),
  }
}

function linuxWrapperScript({ appImage, paths }) {
  return `#!/bin/sh
# Managed by FaNotes: starts the FaNotes background updater (no window).
# When the AppImage below is gone, the timer, the autostart entry and this
# script remove themselves.
appimage=${shellQuote(appImage)}
script=${shellQuote(paths.script)}
timer_unit=${shellQuote(paths.timer)}
service_unit=${shellQuote(paths.service)}
autostart_entry=${shellQuote(paths.autostart)}

if [ ! -f "$appimage" ] || [ ! -x "$appimage" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now ${SYSTEMD_UNIT}.timer >/dev/null 2>&1 || true
  fi
  rm -f -- "$timer_unit" "$service_unit" "$autostart_entry"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f -- "$script"
  exit 0
fi

if [ "\${1:-}" = autostart ]; then
  # Once per login: let the desktop settle, then run at the lowest priority.
  sleep 120
  if command -v ionice >/dev/null 2>&1; then
    exec nice -n 19 ionice -c 3 "$appimage" ${BACKGROUND_ARG} --ozone-platform=headless
  fi
  exec nice -n 19 "$appimage" ${BACKGROUND_ARG} --ozone-platform=headless
fi
exec "$appimage" ${BACKGROUND_ARG} --ozone-platform=headless
`
}

function systemdService({ paths }) {
  return `# Managed by FaNotes.
[Unit]
Description=FaNotes background update
# Laptops: only on mains power. Systems without power-supply information pass.
ConditionACPower=true

[Service]
Type=oneshot
ExecStart=/bin/sh ${systemdQuote(paths.script)} timer
Nice=19
CPUSchedulingPolicy=idle
IOSchedulingClass=idle
TimeoutStartSec=1h
`
}

function systemdTimer() {
  return `# Managed by FaNotes.
[Unit]
Description=FaNotes background update at login and every 6 hours

[Timer]
OnStartupSec=3min
OnUnitActiveSec=6h
RandomizedDelaySec=15min
AccuracySec=10min

[Install]
WantedBy=timers.target
`
}

function autostartEntry({ paths }) {
  return `[Desktop Entry]
Type=Application
Name=FaNotes Hintergrund-Update
Comment=Installiert FaNotes-Updates, solange FaNotes geschlossen ist
Exec=/bin/sh ${desktopQuote(paths.script)} autostart
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
X-FaNotes-Managed=true
`
}

function createUpdateScheduler({
  platform = process.platform,
  env = process.env,
  homeDir,
  updaterRoot,
  executable = null,
  appImage = null,
  exec = defaultExec,
  fs = fsp,
} = {}) {
  const statePath = path.join(updaterRoot, SCHEDULER_STATE_FILE)
  const taskName = windowsTaskName(env.USERNAME)

  const readText = async (filePath) => {
    try {
      return await fs.readFile(filePath, 'utf8')
    } catch {
      return null
    }
  }

  const writeIfChanged = async (filePath, content, mode) => {
    if (await readText(filePath) === content) return false
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    const temporary = `${filePath}.${process.pid}.tmp`
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode })
    await fs.chmod(temporary, mode).catch(() => {})
    await fs.rename(temporary, filePath)
    return true
  }

  const readState = async () => {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const writeState = async (value) => {
    await fs.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
    await fs.writeFile(statePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  // ---------------------------------------------------------------- Windows
  const windowsStatus = async () => {
    const query = await exec('schtasks', ['/Query', '/TN', taskName])
    return { kind: query.code === 0 ? 'task' : null, registered: query.code === 0, name: taskName }
  }

  const windowsRegister = async () => {
    const program = assertSafePath(executable, 'Der FaNotes-Programmpfad', platform)
    const userId = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME || ''}` : String(env.USERNAME || '')
    const xml = windowsTaskXml({ executable: program, userId })
    const fingerprint = crypto.createHash('sha256').update(xml).digest('hex')
    const stored = await readState()
    if (stored.kind === 'task' && stored.fingerprint === fingerprint && (await windowsStatus()).registered) {
      return { kind: 'task', registered: true, name: taskName, changed: false }
    }
    const xmlPath = path.join(updaterRoot, 'background-task.xml')
    await fs.mkdir(updaterRoot, { recursive: true, mode: 0o700 })
    // schtasks reads the task definition as UTF-16 with a byte order mark.
    await fs.writeFile(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]), { mode: 0o600 })
    try {
      const created = await exec('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F'])
      if (created.code !== 0) throw new Error(`Die geplante Aufgabe für Hintergrund-Updates konnte nicht angelegt werden (${created.code}).`)
    } finally {
      await fs.rm(xmlPath, { force: true }).catch(() => {})
    }
    await writeState({ kind: 'task', fingerprint, name: taskName })
    return { kind: 'task', registered: true, name: taskName, changed: true }
  }

  const windowsUnregister = async () => {
    // Without a registration record there is nothing of ours to remove; this
    // keeps a disabled setting from starting schtasks on every launch.
    if (!(await readState()).kind) return { kind: null, registered: false, name: taskName, changed: false }
    const status = await windowsStatus()
    if (status.registered) await exec('schtasks', ['/Delete', '/TN', taskName, '/F'])
    await fs.rm(statePath, { force: true }).catch(() => {})
    return { kind: null, registered: false, name: taskName, changed: status.registered }
  }

  // ---------------------------------------------------------------- Linux
  const paths = platform === 'linux' && homeDir ? linuxPaths({ env, homeDir }) : null

  const systemctl = (...args) => exec('systemctl', ['--user', ...args], { timeoutMs: 8_000 })

  const systemdAvailable = async () => (await exec('systemctl', ['--user', 'show-environment'], { timeoutMs: 3_000 })).code === 0

  const linuxStatus = async () => {
    const [timer, autostart] = await Promise.all([readText(paths.timer), readText(paths.autostart)])
    if (timer !== null) return { kind: 'systemd', registered: true }
    if (autostart !== null) return { kind: 'autostart', registered: true }
    return { kind: null, registered: false }
  }

  const removeSystemd = async (useSystemctl) => {
    const present = (await readText(paths.timer)) !== null || (await readText(paths.service)) !== null
    if (!present) return false
    if (useSystemctl) await systemctl('disable', '--now', `${SYSTEMD_UNIT}.timer`)
    await Promise.all([fs.rm(paths.timer, { force: true }), fs.rm(paths.service, { force: true })])
    if (useSystemctl) await systemctl('daemon-reload')
    return true
  }

  const linuxRegister = async () => {
    const target = assertSafePath(appImage, 'Der AppImage-Pfad', platform)
    let changed = await writeIfChanged(paths.script, linuxWrapperScript({ appImage: target, paths }), 0o700)
    if (await systemdAvailable()) {
      const unitsChanged = (await writeIfChanged(paths.service, systemdService({ paths }), 0o644))
        | (await writeIfChanged(paths.timer, systemdTimer(), 0o644))
      if (unitsChanged) await systemctl('daemon-reload')
      const enabled = (await systemctl('is-enabled', `${SYSTEMD_UNIT}.timer`)).code === 0
      if (unitsChanged || !enabled) {
        const result = await systemctl('enable', '--now', `${SYSTEMD_UNIT}.timer`)
        if (result.code !== 0) throw new Error(`Der systemd-Timer für Hintergrund-Updates konnte nicht aktiviert werden (${result.code}).`)
      }
      changed = changed || Boolean(unitsChanged) || !enabled
      if (await readText(paths.autostart) !== null) {
        await fs.rm(paths.autostart, { force: true })
        changed = true
      }
      return { kind: 'systemd', registered: true, changed }
    }
    changed = (await writeIfChanged(paths.autostart, autostartEntry({ paths }), 0o644)) || changed
    changed = (await removeSystemd(false)) || changed
    return { kind: 'autostart', registered: true, changed }
  }

  const linuxUnregister = async () => {
    const before = await linuxStatus()
    const unitsPresent = (await readText(paths.timer)) !== null || (await readText(paths.service)) !== null
    if (unitsPresent) await removeSystemd(await systemdAvailable())
    await Promise.all([fs.rm(paths.autostart, { force: true }), fs.rm(paths.script, { force: true })])
    return { kind: null, registered: false, changed: before.registered }
  }

  const supportedPlatform = platform === 'win32' || (platform === 'linux' && paths)

  return {
    taskName,
    paths,
    async status() {
      if (!supportedPlatform) return { kind: null, registered: false }
      return platform === 'win32' ? windowsStatus() : linuxStatus()
    },
    async register() {
      if (!supportedPlatform) throw new Error('Hintergrund-Updates werden auf dieser Plattform nicht unterstützt.')
      return platform === 'win32' ? windowsRegister() : linuxRegister()
    },
    async unregister() {
      if (!supportedPlatform) return { kind: null, registered: false, changed: false }
      return platform === 'win32' ? windowsUnregister() : linuxUnregister()
    },
    /** Register when enabled, remove otherwise. Never throws; errors come back in `error`. */
    async sync(enabled) {
      try {
        return enabled ? await this.register() : await this.unregister()
      } catch (error) {
        return { kind: null, registered: false, error: String(error?.message || error).slice(0, 300) }
      }
    },
  }
}

module.exports = {
  AUTOSTART_FILE,
  BACKGROUND_ARG,
  SCRIPT_FILE,
  SYSTEMD_UNIT,
  autostartEntry,
  createUpdateScheduler,
  linuxPaths,
  linuxWrapperScript,
  systemdService,
  systemdTimer,
  windowsTaskName,
  windowsTaskXml,
}
