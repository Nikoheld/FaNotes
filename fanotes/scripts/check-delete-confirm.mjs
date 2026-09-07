import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = await createServer({
  appType: 'custom',
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true },
})

const { confirmDialogKeyAction, confirmDialogTabTarget, deleteConfirmHost, shouldUseInAppDeleteConfirm } = await server.ssrLoadModule('/src/lib/confirmUx.ts')
const { linuxHyprlandRuntimeContext } = await server.ssrLoadModule('/src/lib/sendData.ts')

const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const treeSource = readFileSync(join(root, 'src/components/FileTree.tsx'), 'utf8')
const boardSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const dialogSource = readFileSync(join(root, 'src/components/ConfirmDialog.tsx'), 'utf8')
const styles = readFileSync(join(root, 'src/styles.css'), 'utf8')
const english = JSON.parse(readFileSync(join(root, 'resources/i18n/en.json'), 'utf8'))

// Report: “The delete screen when i click on delete is verry bugged.” The
// dialog reused the settings modal's class: a 760px-tall two-column grid with
// the message squeezed into the right column and the buttons stretched to the
// full height. Escape did nothing and focus stayed in the editor.
const checkDialogLayout = () => {
  assert.doesNotMatch(dialogSource, /settings-modal/, 'the confirm card must not inherit the settings modal layout')
  const card = styles.match(/^\.confirm-dialog \{([^\n]*)\}/mu)
  assert.ok(card, 'standalone .confirm-dialog rule')
  assert.match(card[1], /height: auto/)
  assert.match(card[1], /display: grid/)
  assert.doesNotMatch(card[1], /grid-template-columns/, 'one column')
  assert.match(card[1], /border-radius/)
  assert.match(card[1], /background: var\(--panel\)/)
  assert.match(dialogSource, /cancelRef\.current\?\.focus\(\)/, 'the safe action takes focus when the dialog opens')
  assert.match(dialogSource, /window\.addEventListener\('keydown', onWindowKeyDown, true\)/, 'Escape cancels from anywhere in the window')
  assert.match(dialogSource, /if \(opener\?\.isConnected\) opener\.focus\(\)/, 'focus returns to where the request came from')
  assert.match(dialogSource, /confirmDialogTabTarget\(/, 'Tab stays inside the dialog')
  assert.equal(confirmDialogKeyAction('Escape'), 'cancel')
  assert.equal(confirmDialogKeyAction('Esc'), 'cancel')
  assert.equal(confirmDialogKeyAction('Enter'), null, 'Enter is left to the focused button — never a blind confirm')
  assert.equal(confirmDialogKeyAction('Delete'), null)
  assert.equal(confirmDialogTabTarget(2, 0, false), 1)
  assert.equal(confirmDialogTabTarget(2, 1, false), 0, 'Tab wraps to the first button')
  assert.equal(confirmDialogTabTarget(2, 0, true), 1, 'Shift+Tab wraps to the last button')
  assert.equal(confirmDialogTabTarget(2, -1, false), 0, 'focus outside the dialog enters at the first button')
  assert.equal(confirmDialogTabTarget(2, -1, true), 1)
  assert.equal(confirmDialogTabTarget(0, 0, false), null)
  for (const source of ['Achtung', 'Bestätigen', 'In den Papierkorb', 'Verschieben', 'Ja', 'Training löschen', 'Arbeitsblatt entfernen']) {
    assert.ok(typeof english[source] === 'string' && english[source].length > 0, `English UI: ${source}`)
  }
}

const runOnce = () => {
  const hyprland = linuxHyprlandRuntimeContext({
    platform: 'linux',
    env: {
      XDG_CURRENT_DESKTOP: 'Hyprland',
      HYPRLAND_INSTANCE_SIGNATURE: 'instance-1',
    },
  })
  assert.equal(hyprland.hyprland, true)
  const host = deleteConfirmHost({ sendDataEnabled: true, linux: hyprland })
  assert.equal(host, 'fanotes')
  assert.equal(shouldUseInAppDeleteConfirm({ sendDataEnabled: true, linux: hyprland }), true)
  assert.equal(deleteConfirmHost({ sendDataEnabled: false, linux: hyprland }), 'fanotes')

  assert.match(dialogSource, /role="alertdialog"/)
  assert.match(dialogSource, /confirm-dialog/)
  assert.match(appSource, /<ConfirmDialog/)
  assert.match(appSource, /deleteConfirmHost\(/)
  assert.match(appSource, /confirmTrash=/)
  assert.match(treeSource, /confirmTrash/)
  assert.doesNotMatch(treeSource, /window\.confirm/)
  assert.doesNotMatch(appSource, /window\.confirm/)
  assert.doesNotMatch(boardSource, /window\.confirm/)
  checkDialogLayout()
  return { host, hyprland: hyprland.hyprland, dialogLayout: 'card' }
}

try {
  const first = runOnce()
  const second = runOnce()
  assert.deepEqual(first, second)
  console.log(JSON.stringify(first))
  console.log('delete-confirm ok')
} finally {
  await server.close()
}
