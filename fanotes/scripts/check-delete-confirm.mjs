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

const { deleteConfirmHost, shouldUseInAppDeleteConfirm } = await server.ssrLoadModule('/src/lib/confirmUx.ts')
const { linuxHyprlandRuntimeContext } = await server.ssrLoadModule('/src/lib/sendData.ts')

const appSource = readFileSync(join(root, 'src/App.tsx'), 'utf8')
const treeSource = readFileSync(join(root, 'src/components/FileTree.tsx'), 'utf8')
const boardSource = readFileSync(join(root, 'src/components/DrawingBoard.tsx'), 'utf8')
const dialogSource = readFileSync(join(root, 'src/components/ConfirmDialog.tsx'), 'utf8')

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
  return { host, hyprland: hyprland.hyprland }
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
