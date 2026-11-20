import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { isTouchLongPressEvent } from './touchInput'

/**
 * Finger text selection for the Markdown editor. Desktop Chromium has no
 * touch selection handles, so a finger could only place the caret. A long press
 * selects the word under the finger; moving the finger before lifting extends
 * the selection; two handles move either end; a small bar offers Cut, Copy,
 * Paste and Select all. Mouse and pen selection is untouched.
 */

const HANDLE_SIZE = 44
const MENU_ITEMS = [
  { id: 'cut', label: 'Ausschneiden' },
  { id: 'copy', label: 'Kopieren' },
  { id: 'paste', label: 'Einfügen' },
  { id: 'all', label: 'Alles auswählen' },
] as const
type MenuAction = (typeof MENU_ITEMS)[number]['id']

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    document.execCommand('copy')
  }
}

async function readClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}

class TouchSelectionPlugin {
  private active = false
  private extending: { pointerId: number; anchor: number } | null = null
  private handleDrag: { pointerId: number; fixed: number; handle: HTMLElement } | null = null
  private readonly start: HTMLElement
  private readonly end: HTMLElement
  private readonly menu: HTMLElement
  private frame = 0

  constructor(private readonly view: EditorView) {
    this.start = this.createHandle('start')
    this.end = this.createHandle('end')
    this.menu = this.createMenu()
    this.hide()
    window.addEventListener('scroll', this.schedule, true)
    window.addEventListener('resize', this.schedule)
    window.addEventListener('pointerdown', this.onWindowPointerDown, true)
  }

  /** Called by the contextmenu handler when a long press lands in the text. */
  longPress(event: MouseEvent): boolean {
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null || this.view.state.readOnly) return false
    const word = this.view.state.wordAt(pos)
    const range = word ?? EditorSelection.cursor(pos)
    this.view.focus()
    this.view.dispatch({ selection: range, userEvent: 'select.pointer' })
    this.active = true
    this.extending = { pointerId: this.lastPointerId, anchor: range.anchor }
    window.addEventListener('pointermove', this.onExtendMove, true)
    window.addEventListener('pointerup', this.endExtend, true)
    window.addEventListener('pointercancel', this.endExtend, true)
    window.addEventListener('touchmove', this.blockScroll, { capture: true, passive: false })
    this.schedule()
    return true
  }

  private lastPointerId = 0
  private readonly onWindowPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') this.lastPointerId = event.pointerId
    if (!this.active) return
    const target = event.target
    if (target instanceof Node && (this.menu.contains(target) || this.start.contains(target) || this.end.contains(target))) return
    // A tap or a click elsewhere ends the touch selection UI; the editor moves the caret itself.
    this.hide()
  }

  private readonly blockScroll = (event: TouchEvent): void => {
    if (this.extending && event.cancelable) event.preventDefault()
  }

  private readonly onExtendMove = (event: PointerEvent): void => {
    const state = this.extending
    if (!state || event.pointerType !== 'touch') return
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
    this.view.dispatch({ selection: EditorSelection.range(state.anchor, pos), userEvent: 'select.pointer' })
    this.menu.hidden = true
  }

  private readonly endExtend = (): void => {
    this.extending = null
    window.removeEventListener('pointermove', this.onExtendMove, true)
    window.removeEventListener('pointerup', this.endExtend, true)
    window.removeEventListener('pointercancel', this.endExtend, true)
    window.removeEventListener('touchmove', this.blockScroll, true)
    this.schedule()
  }

  private createHandle(kind: 'start' | 'end'): HTMLElement {
    const handle = document.createElement('div')
    handle.className = `cm-touch-handle cm-touch-handle--${kind}`
    handle.setAttribute('data-touch-native', '')
    handle.innerHTML = '<span></span>'
    handle.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return
      event.preventDefault()
      event.stopPropagation()
      const main = this.view.state.selection.main
      this.handleDrag = { pointerId: event.pointerId, fixed: kind === 'start' ? main.to : main.from, handle }
      handle.setPointerCapture(event.pointerId)
      this.menu.hidden = true
    })
    handle.addEventListener('pointermove', (event) => {
      const drag = this.handleDrag
      if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return
      // The finger sits below the line; aim at the line the handle belongs to.
      const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY - HANDLE_SIZE / 2 }, false)
      this.view.dispatch({ selection: EditorSelection.range(drag.fixed, pos), userEvent: 'select.pointer' })
    })
    const finish = (event: PointerEvent): void => {
      if (this.handleDrag?.pointerId !== event.pointerId) return
      this.handleDrag = null
      this.schedule()
    }
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
    document.body.append(handle)
    return handle
  }

  private createMenu(): HTMLElement {
    const menu = document.createElement('div')
    menu.className = 'cm-touch-menu'
    menu.setAttribute('role', 'toolbar')
    menu.setAttribute('data-touch-native', '')
    for (const item of MENU_ITEMS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.action = item.id
      button.textContent = item.label
      button.addEventListener('pointerdown', (event) => event.preventDefault())
      button.addEventListener('click', () => void this.run(item.id))
      menu.append(button)
    }
    document.body.append(menu)
    return menu
  }

  private async run(action: MenuAction): Promise<void> {
    const { view } = this
    const main = view.state.selection.main
    view.focus()
    if (action === 'all') {
      view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length), userEvent: 'select' })
      this.schedule()
      return
    }
    if (action === 'copy' || action === 'cut') {
      if (main.empty) return
      await writeClipboard(view.state.sliceDoc(main.from, main.to))
      if (action === 'cut') view.dispatch(view.state.replaceSelection(''), { userEvent: 'delete.cut' })
    } else {
      const text = await readClipboard()
      if (text === null) document.execCommand('paste')
      else view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.paste' })
    }
    this.hide()
  }

  private readonly schedule = (): void => {
    if (this.frame) return
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0
      this.place()
    })
  }

  private place(): void {
    if (!this.active) return
    const main = this.view.state.selection.main
    const from = this.view.coordsAtPos(main.from)
    const to = this.view.coordsAtPos(main.to)
    if (!from || !to) { this.hide(); return }
    const show = (handle: HTMLElement, x: number, y: number): void => {
      handle.hidden = main.empty && handle === this.end
      handle.style.left = `${x - HANDLE_SIZE / 2}px`
      handle.style.top = `${y}px`
    }
    show(this.start, from.left, from.bottom)
    show(this.end, to.left, to.bottom)
    if (main.empty) this.start.hidden = false
    this.menu.hidden = this.extending !== null || this.handleDrag !== null
    if (!this.menu.hidden) {
      const width = this.menu.offsetWidth || 280
      const left = Math.min(Math.max(8, (from.left + to.left) / 2 - width / 2), window.innerWidth - width - 8)
      const top = from.top - 52
      this.menu.style.left = `${left}px`
      this.menu.style.top = `${top < 8 ? to.bottom + HANDLE_SIZE + 6 : top}px`
    }
  }

  private hide(): void {
    this.active = false
    this.start.hidden = true
    this.end.hidden = true
    this.menu.hidden = true
  }

  update(update: ViewUpdate): void {
    if (!this.active) return
    if (update.docChanged && update.state.selection.main.empty && !this.extending) this.hide()
    else if (update.selectionSet || update.geometryChanged || update.viewportChanged || update.docChanged) this.schedule()
  }

  destroy(): void {
    window.cancelAnimationFrame(this.frame)
    window.removeEventListener('scroll', this.schedule, true)
    window.removeEventListener('resize', this.schedule)
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true)
    this.endExtend()
    this.start.remove()
    this.end.remove()
    this.menu.remove()
  }
}

const plugin = ViewPlugin.fromClass(TouchSelectionPlugin, {
  eventHandlers: {
    contextmenu(event: MouseEvent) {
      if (!isTouchLongPressEvent(event)) return false
      if (!this.longPress(event)) return false
      event.preventDefault()
      return true
    },
  },
})

export const touchSelection: Extension = plugin
