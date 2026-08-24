import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const runOnce = () => {
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  const css = readFileSync(join(root, 'src/styles.css'), 'utf8')
  const formatting = readFileSync(join(root, 'src/components/FormattingToolbar.tsx'), 'utf8')

  assert.match(app, /className=\{`editor-toolbar \$\{drawingOpen \? 'is-ink' : 'is-type'\}`\}/)
  assert.match(app, /aria-label="Eingabemodus"/)
  assert.match(app, /<span>Tastatur<\/span>/)
  assert.match(app, /<span>Stift<\/span>/)
  assert.match(app, /className=\{!drawingOpen \? 'is-active' : ''\}/)
  assert.match(app, /penModeToolbarSlot\(drawingOpen, isPdfActive\)/)
  assert.match(app, /INK_TOOLBAR_SLOT_ID/)
  assert.match(app, /<FormattingToolbar/)
  assert.match(formatting, /className="formatting-toolbar"/)
  assert.match(formatting, /aria-label="Markdown formatieren"/)

  const typeStart = css.indexOf('.editor-toolbar.is-type {')
  assert.ok(typeStart >= 0, 'keyboard mode must have its own .editor-toolbar.is-type styles')
  const inkDock = css.indexOf('.lw-draw-toolbar.is-docked-chrome {')
  assert.ok(inkDock > typeStart, 'type-mode chrome must sit next to the docked-ink rules')
  const typeBlock = css.slice(typeStart, inkDock)

  assert.match(typeBlock, /display:\s*flex/)
  assert.match(typeBlock, /align-items:\s*center/)
  assert.match(typeBlock, /min-height:\s*36px/)
  assert.match(typeBlock, /height:\s*36px/)
  assert.match(typeBlock, /background:\s*var\(--bg\)/)
  assert.match(typeBlock, /color:\s*var\(--text\)/)
  assert.doesNotMatch(typeBlock, /color:\s*#/)
  assert.doesNotMatch(typeBlock, /background:\s*#/)

  assert.match(typeBlock, /\.editor-toolbar\.is-type \.mode-switch \{/)
  assert.match(typeBlock, /\.editor-toolbar\.is-type \.mode-switch button\.is-active \{/)
  const activeStart = typeBlock.indexOf('.editor-toolbar.is-type .mode-switch button.is-active {')
  assert.ok(activeStart >= 0)
  const activeBlock = typeBlock.slice(activeStart, typeBlock.indexOf('}', activeStart) + 1)
  assert.match(activeBlock, /color:\s*var\(--text\)/)
  assert.match(activeBlock, /background:\s*var\(--panel-active\)/)
  assert.match(activeBlock, /var\(--accent\)/)
  assert.doesNotMatch(activeBlock, /\.is-ink/)

  assert.match(typeBlock, /\.editor-toolbar\.is-type \.formatting-toolbar \{/)
  const formatStart = typeBlock.indexOf('.editor-toolbar.is-type .formatting-toolbar {')
  const formatBlock = typeBlock.slice(formatStart, typeBlock.indexOf('}', formatStart) + 1)
  assert.match(formatBlock, /height:\s*28px/)
  assert.match(formatBlock, /mask-image:\s*none/)
  assert.match(typeBlock, /\.editor-toolbar\.is-type \.formatting-toolbar button \{/)
  assert.match(typeBlock, /height:\s*28px/)

  const inkActive = css.slice(
    css.indexOf('.editor-toolbar.is-ink .mode-switch button.is-active {'),
    css.indexOf('.editor-toolbar.is-ink .mode-switch button.is-active {') + 220,
  )
  assert.match(inkActive, /background:\s*var\(--accent\)/)
  assert.match(css, /\.lw-draw-toolbar\.is-docked-chrome \{/)
  assert.doesNotMatch(typeBlock, /lw-draw-toolbar/)

  const row = css.slice(css.indexOf('.editor-toolbar {'), css.indexOf('.editor-toolbar.is-ink {') + 80)
  assert.match(row, /display:\s*flex/)
  assert.match(row, /align-items:\s*center/)

  return {
    typeMode: true,
    tastaturActive: true,
    formattingUnmasked: true,
    inkDockKept: true,
  }
}

const first = runOnce()
const second = runOnce()
assert.deepEqual(first, second)
console.log(JSON.stringify(first))
console.log('keyboard-toolbar ok')
