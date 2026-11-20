'use strict'

// Registration of the background updater: Windows Scheduled Task (schtasks
// mocked), systemd user timer and XDG autostart (systemctl mocked), removal
// when the setting is off, the NSIS uninstaller hook, and a real run of the
// generated Linux wrapper script that removes itself once the AppImage is gone.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  BACKGROUND_ARG,
  SYSTEMD_UNIT,
  createUpdateScheduler,
  windowsTaskName,
  windowsTaskXml,
} = require('../electron/update-scheduler.cjs')

const recorder = (answer = () => ({ code: 0, stdout: '', stderr: '' })) => {
  const calls = []
  const exec = async (command, args, options) => {
    const call = { command, args: [...args], options }
    calls.push(call)
    return answer(call)
  }
  return { calls, exec }
}

async function checkWindows(temporary) {
  const updaterRoot = path.join(temporary, 'win', 'updates')
  const env = { USERNAME: 'Fabio', USERDOMAIN: 'SCHULE' }
  const executable = 'C:\\Users\\Fabio\\AppData\\Local\\Programs\\FaNotes & Co\\FaNotes.exe'
  let registered = false
  let createdXml = null
  const { calls, exec } = recorder(({ args }) => {
    if (args[0] === '/Query') return { code: registered ? 0 : 1, stdout: '', stderr: '' }
    if (args[0] === '/Create') {
      createdXml = fs.readFileSync(args[args.indexOf('/XML') + 1])
      registered = true
    }
    if (args[0] === '/Delete') registered = false
    return { code: 0, stdout: '', stderr: '' }
  })
  const scheduler = createUpdateScheduler({ platform: 'win32', env, updaterRoot, executable, exec })
  assert.equal(scheduler.taskName, 'FaNotes Background Update (Fabio)')
  assert.equal(windowsTaskName('a/b:c'), 'FaNotes Background Update (a_b_c)')

  const first = await scheduler.sync(true)
  assert.deepEqual({ kind: first.kind, registered: first.registered, changed: first.changed }, { kind: 'task', registered: true, changed: true })
  const create = calls.find((call) => call.args[0] === '/Create')
  assert.equal(create.command, 'schtasks')
  assert.deepEqual(create.args.filter((arg) => !arg.endsWith('.xml')), ['/Create', '/TN', 'FaNotes Background Update (Fabio)', '/XML', '/F'])
  assert.deepEqual([...createdXml.subarray(0, 2)], [0xff, 0xfe], 'schtasks bekommt UTF-16 mit BOM.')
  const xml = createdXml.subarray(2).toString('utf16le')
  assert.equal(xml, windowsTaskXml({ executable, userId: 'SCHULE\\Fabio' }))
  for (const fragment of [
    '<LogonTrigger>', '<Delay>PT3M</Delay>', '<Interval>PT6H</Interval>',
    '<DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries>', '<StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>',
    '<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>', '<RunOnlyIfIdle>true</RunOnlyIfIdle>',
    '<StartWhenAvailable>true</StartWhenAvailable>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<Priority>8</Priority>', '<RunLevel>LeastPrivilege</RunLevel>', '<LogonType>InteractiveToken</LogonType>',
    '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT1H</ExecutionTimeLimit>', '<UserId>SCHULE\\Fabio</UserId>',
    `<Arguments>${BACKGROUND_ARG}</Arguments>`,
    '<Command>C:\\Users\\Fabio\\AppData\\Local\\Programs\\FaNotes &amp; Co\\FaNotes.exe</Command>',
  ]) assert.ok(xml.includes(fragment), `Die Aufgabe enthält ${fragment}.`)
  assert.equal(/&(?!amp;|lt;|gt;|quot;|apos;)/u.test(xml), false, 'Das XML ist korrekt maskiert.')
  assert.equal(xml.includes('HighestAvailable'), false, 'Keine Adminrechte.')
  assert.equal(fs.readdirSync(updaterRoot).some((name) => name.endsWith('.xml')), false, 'Die XML-Datei wird nach dem Anlegen entfernt.')

  // An unchanged registration costs one query, no rewrite.
  calls.length = 0
  const second = await scheduler.sync(true)
  assert.equal(second.changed, false)
  assert.deepEqual(calls.map((call) => call.args[0]), ['/Query'])

  // A new install path rewrites the task.
  calls.length = 0
  const moved = createUpdateScheduler({ platform: 'win32', env, updaterRoot, executable: 'D:\\FaNotes\\FaNotes.exe', exec })
  assert.equal((await moved.sync(true)).changed, true)
  assert.ok(calls.some((call) => call.args[0] === '/Create'))

  // Setting off: the task is deleted.
  calls.length = 0
  const off = await scheduler.sync(false)
  assert.equal(off.registered, false)
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3).join(' ')), ['/Query /TN FaNotes Background Update (Fabio)', '/Delete /TN FaNotes Background Update (Fabio)'])
  assert.ok(calls[1].args.includes('/F'))

  // A failing schtasks is reported, not thrown.
  const failing = createUpdateScheduler({ platform: 'win32', env, updaterRoot, executable, exec: async () => ({ code: 5, stdout: '', stderr: 'Zugriff verweigert' }) })
  const failed = await failing.sync(true)
  assert.equal(failed.registered, false)
  assert.match(failed.error, /geplante Aufgabe/u)
  assert.match((await createUpdateScheduler({ platform: 'win32', env, updaterRoot, executable: 'relative.exe', exec }).sync(true)).error, /Programmpfad/u)

  // The NSIS uninstaller removes the same task, but not during an update.
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8')
  assert.match(nsh, /!macro customUnInstall/u)
  assert.match(nsh, /\$\{ifNot\} \$\{isUpdated\}/u)
  assert.match(nsh, /ReadEnvStr \$0 USERNAME/u)
  assert.ok(nsh.includes('schtasks.exe /Delete /TN "FaNotes Background Update ($0)" /F'))
  assert.equal(`FaNotes Background Update (${'$0'})`, windowsTaskName('$0'), 'Uninstaller und App verwenden denselben Aufgabennamen.')

  // On a Windows CI runner: the real Task Scheduler accepts the definition.
  if (process.platform === 'win32' && process.env.CI) {
    const real = createUpdateScheduler({ platform: 'win32', env: process.env, updaterRoot: path.join(temporary, 'real-task'), executable: process.execPath })
    const registration = await real.sync(true)
    assert.equal(registration.registered, true, registration.error)
    assert.equal((await real.status()).registered, true)
    const exported = spawnSync('schtasks', ['/Query', '/TN', real.taskName, '/XML'], { encoding: 'utf8' })
    assert.equal(exported.status, 0, exported.stderr)
    for (const fragment of [BACKGROUND_ARG, '<DisallowStartIfOnBatteries>true', '<RunOnlyIfNetworkAvailable>true', '<RunOnlyIfIdle>true', '<Interval>PT6H</Interval>']) {
      assert.ok(exported.stdout.includes(fragment), `Die registrierte Aufgabe enthält ${fragment}.`)
    }
    assert.equal((await real.sync(true)).changed, false)
    await real.sync(false)
    assert.equal((await real.status()).registered, false)
  }
}

async function checkLinux(temporary) {
  const home = path.join(temporary, 'linux-home')
  const updaterRoot = path.join(home, '.config', 'FaNotes', 'updates')
  const appImage = path.join(home, "Apps $HOME's 100%", 'FaNotes.AppImage')
  await fsp.mkdir(path.dirname(appImage), { recursive: true })
  await fsp.writeFile(appImage, '#!/bin/sh\nprintf "%s\\n" "$@" >"$FANOTES_TEST_ARGS"\n', { mode: 0o755 })
  let enabled = false
  const systemd = recorder(({ args }) => {
    if (args[1] === 'show-environment') return { code: 0, stdout: 'HOME=/x\n', stderr: '' }
    if (args[1] === 'is-enabled') return { code: enabled ? 0 : 1, stdout: '', stderr: '' }
    if (args[1] === 'enable') enabled = true
    if (args[1] === 'disable') enabled = false
    return { code: 0, stdout: '', stderr: '' }
  })
  const env = {}
  const scheduler = createUpdateScheduler({ platform: 'linux', env, homeDir: home, updaterRoot, appImage, exec: systemd.exec })
  const { paths } = scheduler
  assert.equal(paths.timer, path.join(home, '.config', 'systemd', 'user', `${SYSTEMD_UNIT}.timer`))
  assert.equal(paths.script, path.join(home, '.local', 'share', 'fanotes', 'background-update.sh'))

  const first = await scheduler.sync(true)
  assert.deepEqual({ kind: first.kind, registered: first.registered, changed: first.changed }, { kind: 'systemd', registered: true, changed: true })
  assert.deepEqual(systemd.calls.map((call) => call.args.slice(1).join(' ')), [
    'show-environment', 'daemon-reload', 'is-enabled fanotes-background-update.timer', 'enable --now fanotes-background-update.timer',
  ])
  assert.ok(systemd.calls.every((call) => call.command === 'systemctl' && call.args[0] === '--user'))
  const service = await fsp.readFile(paths.service, 'utf8')
  const timer = await fsp.readFile(paths.timer, 'utf8')
  for (const fragment of ['Type=oneshot', 'Nice=19', 'CPUSchedulingPolicy=idle', 'IOSchedulingClass=idle', `ExecStart=/bin/sh "${paths.script}" timer`]) {
    assert.ok(service.includes(fragment), `Der Dienst enthält ${fragment}.`)
  }
  for (const fragment of ['OnStartupSec=3min', 'OnUnitActiveSec=6h', 'RandomizedDelaySec=15min', 'WantedBy=timers.target']) {
    assert.ok(timer.includes(fragment), `Der Timer enthält ${fragment}.`)
  }
  assert.equal((await fsp.stat(paths.script)).mode & 0o777, 0o700)
  assert.equal(fs.existsSync(paths.autostart), false)
  const analyze = spawnSync('systemd-analyze', ['verify', paths.service, paths.timer], { encoding: 'utf8' })
  if (!analyze.error) assert.equal(analyze.status, 0, `systemd-analyze verify: ${analyze.stderr}`)

  // Unchanged: only the availability and enablement queries.
  systemd.calls.length = 0
  assert.equal((await scheduler.sync(true)).changed, false)
  assert.deepEqual(systemd.calls.map((call) => call.args[1]), ['show-environment', 'is-enabled'])

  // A special path survives quoting: the wrapper starts exactly this file.
  const argsFile = path.join(temporary, 'args.txt')
  const run = spawnSync('/bin/sh', [paths.script, 'timer'], { env: { ...process.env, FANOTES_TEST_ARGS: argsFile }, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trim().split('\n'), [BACKGROUND_ARG, '--ozone-platform=headless'])

  // systemd specifiers and variables in the script path are escaped.
  const percentHome = path.join(temporary, 'percent %h $USER home')
  const percent = createUpdateScheduler({ platform: 'linux', env: {}, homeDir: percentHome, updaterRoot, appImage, exec: systemd.exec })
  await percent.sync(true)
  const percentService = await fsp.readFile(percent.paths.service, 'utf8')
  assert.ok(percentService.includes(`ExecStart=/bin/sh "${percent.paths.script.replaceAll('%', '%%').replaceAll('$', () => '$$')}" timer`))
  await percent.sync(false)

  // No systemd user manager: XDG autostart once per login; units are removed.
  const plain = recorder(({ args }) => ({ code: args[1] === 'show-environment' ? 1 : 0, stdout: '', stderr: '' }))
  const fallback = createUpdateScheduler({ platform: 'linux', env, homeDir: home, updaterRoot, appImage, exec: plain.exec })
  const autostart = await fallback.sync(true)
  assert.equal(autostart.kind, 'autostart')
  assert.equal(fs.existsSync(paths.timer), false)
  assert.equal(fs.existsSync(paths.service), false)
  const entry = await fsp.readFile(paths.autostart, 'utf8')
  assert.match(entry, /^\[Desktop Entry\]$/mu)
  assert.match(entry, /^NoDisplay=true$/mu)
  assert.match(entry, /^X-FaNotes-Managed=true$/mu)
  assert.ok(entry.includes(`Exec=/bin/sh "${paths.script.replaceAll('$', '\\$')}" autostart`))
  assert.equal((await fallback.status()).kind, 'autostart')
  const validate = spawnSync('desktop-file-validate', [paths.autostart], { encoding: 'utf8' })
  if (!validate.error) assert.equal(validate.status, 0, validate.stdout)

  // Back to systemd: the autostart entry goes away again.
  enabled = false
  await scheduler.sync(true)
  assert.equal(fs.existsSync(paths.autostart), false)

  // Setting off: timer disabled, files removed.
  systemd.calls.length = 0
  const off = await scheduler.sync(false)
  assert.equal(off.registered, false)
  assert.deepEqual(systemd.calls.map((call) => call.args.slice(1).join(' ')), [
    'show-environment', 'disable --now fanotes-background-update.timer', 'daemon-reload',
  ])
  for (const file of [paths.timer, paths.service, paths.autostart, paths.script]) assert.equal(fs.existsSync(file), false, file)
  assert.match((await createUpdateScheduler({ platform: 'linux', env, homeDir: home, updaterRoot, appImage: 'FaNotes.AppImage', exec: systemd.exec }).sync(true)).error, /AppImage-Pfad/u)

  // The AppImage was deleted: the next timer run disables the timer and removes everything.
  await scheduler.sync(true)
  await fsp.writeFile(paths.autostart, '[Desktop Entry]\nX-FaNotes-Managed=true\n')
  await fsp.rm(appImage)
  const bin = path.join(temporary, 'fake-bin')
  const log = path.join(temporary, 'systemctl.log')
  await fsp.mkdir(bin, { recursive: true })
  await fsp.writeFile(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >>${JSON.stringify(log)}\n`, { mode: 0o755 })
  const gone = spawnSync('/bin/sh', [paths.script, 'timer'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' })
  assert.equal(gone.status, 0, gone.stderr)
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['--user disable --now fanotes-background-update.timer', '--user daemon-reload'])
  for (const file of [paths.timer, paths.service, paths.autostart, paths.script]) assert.equal(fs.existsSync(file), false, `${file} ist entfernt.`)

  // Unsupported platforms register nothing.
  assert.deepEqual(await createUpdateScheduler({ platform: 'darwin', env, homeDir: home, updaterRoot }).status(), { kind: null, registered: false })
}

async function main() {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'fanotes-update-scheduler-'))
  try {
    await checkWindows(temporary)
    if (process.platform !== 'win32') await checkLinux(temporary)
    console.log('Update-Zeitplan erfolgreich: Windows-Aufgabe (Anmeldung, 6 h, Netz, Strom, Leerlauf, niedrige Priorität, ohne Adminrechte), Entfernen per Einstellung und Deinstallation, systemd-Benutzertimer, XDG-Autostart als Ersatz und ein Wrapper, der sich ohne AppImage selbst entfernt.')
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
