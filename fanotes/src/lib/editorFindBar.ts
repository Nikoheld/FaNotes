import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, setSearchQuery } from '@codemirror/search'
import type { EditorState } from '@codemirror/state'
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view'

const MATCH_LIMIT = 999

/** Label for the find bar: the current hit, the hit count, or an invalid pattern. */
export const findMatchStatus = (state: EditorState, query: SearchQuery): string => {
  if (!query.search) return ''
  if (!query.valid) return 'Ungültiger Ausdruck'
  const selected = state.selection.main
  const cursor = query.getCursor(state)
  let count = 0
  let index = 0
  for (;;) {
    const step = cursor.next()
    if (step.done) break
    count += 1
    const match = step.value
    if (!index && match.from === selected.from && match.to === selected.to) index = count
    if (count === MATCH_LIMIT && !cursor.next().done) return `${MATCH_LIMIT}+`
  }
  if (!count) return 'Keine Treffer'
  if (index) return `${index} / ${count}`
  return count === 1 ? '1 Treffer' : `${count} Treffer`
}

const svg = (paths: string[]) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  element.setAttribute('viewBox', '0 0 24 24')
  element.setAttribute('width', '14')
  element.setAttribute('height', '14')
  element.setAttribute('fill', 'none')
  element.setAttribute('stroke', 'currentColor')
  element.setAttribute('stroke-width', '2')
  element.setAttribute('stroke-linecap', 'round')
  element.setAttribute('stroke-linejoin', 'round')
  element.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    element.append(path)
  }
  return element
}

/**
 * Find and replace bar for the note editor. It follows the PDF search row
 * (field, count, previous, next, close) and adds replace on a second row.
 * The bar is positioned by CSS so it does not push the paper sheet down.
 */
export const createEditorFindPanel = (view: EditorView): Panel => {
  let query = getSearchQuery(view.state)
  let statusFrame = 0

  const searchField = document.createElement('input')
  searchField.type = 'text'
  searchField.name = 'search'
  searchField.placeholder = 'Suchen'
  searchField.setAttribute('aria-label', 'Suchbegriff')
  searchField.setAttribute('main-field', 'true')
  searchField.autocomplete = 'off'
  searchField.spellcheck = false
  searchField.setAttribute('form', '')

  const replaceField = document.createElement('input')
  replaceField.type = 'text'
  replaceField.name = 'replace'
  replaceField.placeholder = 'Ersetzen'
  replaceField.setAttribute('aria-label', 'Ersatztext')
  replaceField.autocomplete = 'off'
  replaceField.spellcheck = false
  replaceField.setAttribute('form', '')

  const count = document.createElement('small')
  count.className = 'fanotes-find__count'

  const pressed = (button: HTMLButtonElement) => button.getAttribute('aria-pressed') === 'true'
  const toggle = (button: HTMLButtonElement) => {
    const on = !pressed(button)
    button.setAttribute('aria-pressed', on ? 'true' : 'false')
    button.classList.toggle('is-active', on)
    commit()
  }

  const iconButton = (name: string, label: string, graphic: SVGSVGElement | string, onClick: () => void) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.name = name
    button.className = 'fanotes-find__icon'
    button.setAttribute('aria-label', label)
    button.title = label
    if (typeof graphic === 'string') button.textContent = graphic
    else button.append(graphic)
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', onClick)
    return button
  }

  const caseButton = iconButton('case', 'Gross- und Kleinschreibung', 'Aa', () => toggle(caseButton))
  const wordButton = iconButton('word', 'Ganzes Wort', 'ab', () => toggle(wordButton))
  const regexpButton = iconButton('re', 'Regulärer Ausdruck', '.*', () => toggle(regexpButton))
  caseButton.setAttribute('aria-pressed', 'false')
  wordButton.setAttribute('aria-pressed', 'false')
  regexpButton.setAttribute('aria-pressed', 'false')

  const textButton = (name: string, label: string, onClick: () => void) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.name = name
    button.className = 'fanotes-find__action'
    button.textContent = label
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', onClick)
    return button
  }

  const dom = document.createElement('div')
  dom.className = 'fanotes-find'
  dom.setAttribute('role', 'search')
  dom.setAttribute('aria-label', 'Suchen und ersetzen')

  const searchRow = document.createElement('div')
  searchRow.className = 'fanotes-find__row'
  const searchLabel = document.createElement('label')
  searchLabel.className = 'fanotes-find__field'
  searchLabel.append(
    svg(['M21 21l-4.3-4.3', 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z']),
    searchField,
  )
  searchRow.append(
    searchLabel,
    count,
    iconButton('prev', 'Vorheriger Treffer', svg(['M15 18l-6-6 6-6']), () => { findPrevious(view) }),
    iconButton('next', 'Nächster Treffer', svg(['M9 18l6-6-6-6']), () => { findNext(view) }),
    caseButton,
    wordButton,
    regexpButton,
    iconButton('close', 'Suche schließen', svg(['M18 6L6 18', 'M6 6l12 12']), () => { closeSearchPanel(view) }),
  )

  const replaceRow = document.createElement('div')
  replaceRow.className = 'fanotes-find__row fanotes-find__replace'
  const replaceLabel = document.createElement('label')
  replaceLabel.className = 'fanotes-find__field'
  replaceLabel.append(replaceField)
  replaceRow.append(
    replaceLabel,
    textButton('replace', 'Ersetzen', () => { if (!view.state.readOnly) replaceNext(view) }),
    textButton('replaceAll', 'Alle ersetzen', () => { if (!view.state.readOnly) replaceAll(view) }),
  )
  dom.append(searchRow, replaceRow)

  const paintStatus = () => {
    const text = findMatchStatus(view.state, query)
    if (count.dataset.source === text) return
    count.dataset.source = text
    count.textContent = text
  }

  const scheduleStatus = () => {
    if (statusFrame) return
    statusFrame = requestAnimationFrame(() => {
      statusFrame = 0
      paintStatus()
    })
  }

  const applyQuery = (next: SearchQuery) => {
    query = next
    if (searchField.value !== next.search) searchField.value = next.search
    if (replaceField.value !== next.replace) replaceField.value = next.replace
    const flags: Array<[HTMLButtonElement, boolean]> = [
      [caseButton, next.caseSensitive],
      [wordButton, next.wholeWord],
      [regexpButton, next.regexp],
    ]
    for (const [button, on] of flags) {
      button.setAttribute('aria-pressed', on ? 'true' : 'false')
      button.classList.toggle('is-active', on)
    }
    searchField.classList.toggle('is-invalid', Boolean(next.search) && !next.valid)
  }

  const commit = () => {
    const next = new SearchQuery({
      search: searchField.value,
      replace: replaceField.value,
      caseSensitive: pressed(caseButton),
      wholeWord: pressed(wordButton),
      regexp: pressed(regexpButton),
    })
    searchField.classList.toggle('is-invalid', Boolean(next.search) && !next.valid)
    if (!next.eq(query)) {
      query = next
      view.dispatch({ effects: setSearchQuery.of(next) })
    }
    scheduleStatus()
  }

  searchField.addEventListener('input', commit)
  replaceField.addEventListener('input', commit)
  dom.addEventListener('keydown', (event) => {
    if (runScopeHandlers(view, event, 'search-panel')) {
      event.preventDefault()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.target === replaceField) {
      if (!view.state.readOnly) replaceNext(view)
      return
    }
    if (event.shiftKey) findPrevious(view)
    else findNext(view)
  })

  applyQuery(query)
  dom.classList.toggle('is-readonly', view.state.readOnly)

  return {
    dom,
    top: true,
    mount() {
      searchField.select()
      paintStatus()
    },
    update(update: ViewUpdate) {
      dom.classList.toggle('is-readonly', update.view.state.readOnly)
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) applyQuery(effect.value)
        }
      }
      if (update.docChanged || update.selectionSet) scheduleStatus()
    },
    destroy() {
      if (statusFrame) cancelAnimationFrame(statusFrame)
    },
  }
}
