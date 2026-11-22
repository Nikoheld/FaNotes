// Loaded into the Electron main process with `electron -r scripts/electron-test-stub.cjs` by the desktop
// flow checks only. It stands in for the native dialogs: the open/save dialogs answer with the paths in the
// JSON file named by FANOTES_TEST_DIALOGS ({ open: [paths], save: path }). Downloads started by the
// renderer are captured by playwright-core (page 'download' event), so nothing is stubbed for them.
const fs = require('node:fs')
const { dialog } = require('electron')

const answers = () => {
  try { return JSON.parse(fs.readFileSync(process.env.FANOTES_TEST_DIALOGS, 'utf8')) } catch { return {} }
}
dialog.showOpenDialog = async () => {
  const open = answers().open
  return open?.length ? { canceled: false, filePaths: open } : { canceled: true, filePaths: [] }
}
dialog.showSaveDialog = async () => {
  const save = answers().save
  return save ? { canceled: false, filePath: save } : { canceled: true }
}
