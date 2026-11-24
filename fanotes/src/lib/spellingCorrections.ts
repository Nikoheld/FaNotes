import { insertNewlineAndIndent, isolateHistory } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import {
  EditorSelection,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from '@codemirror/state'
import { Decoration, EditorView, keymap, showTooltip, tooltips, type DecorationSet, type Tooltip, type TooltipView } from '@codemirror/view'
import type { TextLanguage } from '../types'
import { languageTag, type LanguageEvidence } from './languageDetect'
import {
  addPersonalWord,
  declineAutocorrect,
  ignoreWordForSession,
  isAutocorrectDeclined,
  type SpellingSuggestion,
} from './spellingSuggest'
import type { SpellingEngine } from './spellingEngine'

/**
 * Corrections for the spellchecker: an autocorrect that fires when a word is
 * finished (space, punctuation, Enter) and a suggestion menu on a click,
 * right-click, or Ctrl+. — both fed by the same dictionaries as the red underline.
 */

type SpellingModule = typeof import('./spelling')
let spellingModule: SpellingModule | null = null
let spellingEngine: SpellingEngine | null = null
let primePromise: Promise<SpellingEngine> | null = null

/** Loads the dictionaries and the exact word lists once, off the main thread (a Web Worker with
 * the Rust wasm; the TypeScript lexicon if that cannot start). Autocorrect is silent until this
 * resolved. */
export const primeSpellingCorrections = () => {
  primePromise ??= Promise.all([import('./spelling'), import('./spellingEngine')])
    .then(async ([module, { loadSpellingEngine }]) => {
      const engine = await loadSpellingEngine()
      spellingModule = module
      spellingEngine = engine
      return engine
    })
    .catch((error) => {
      primePromise = null
      throw error
    })
  return primePromise
}

/** Gets the engine ready for the languages a note uses, so the first correction there is not lost to
 * loading the French word list (about 5 MB) while the user keeps typing. */
export const warmSpellingLanguages = (languages: readonly TextLanguage[]) => {
  if (!languages.includes('fr')) return
  void primeSpellingCorrections().then((engine) => engine.prepare?.(['fr'])).catch(() => undefined)
}

export type SpellingCorrectionsOptions = {
  autocorrectEnabled: () => boolean
}

/** The language profile of the note from the last spelling pass (`checkSpelling`); autocorrect and the menu read it. */
export const setLanguageProfile = StateEffect.define<LanguageEvidence>()
export const languageProfileField = StateField.define<LanguageEvidence | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setLanguageProfile)) return effect.value
    return value
  },
})

const ALL_LANGUAGES: readonly TextLanguage[] = ['de', 'en', 'fr']
const PARAGRAPH_LOOKBEHIND = 3
const PARAGRAPH_LOOKAHEAD = 2

/** What is known about the passage around `pos`, decided now from the text as it is: its language,
 * whether that is certain, and the languages a word there may be valid in. Null until the dictionaries loaded. */
export type PassageContext = {
  language: TextLanguage | null
  confident: boolean
  /** A language without dictionary (Italian, ...), or mostly unknown words: never autocorrected. */
  foreign: boolean
  unsupported: boolean
  allowed: TextLanguage[]
}

const passageContextAt = (state: EditorState, pos: number): PassageContext | null => {
  const module = spellingModule
  if (!module) return null
  const line = state.doc.lineAt(pos)
  const previous: string[] = []
  for (let number = line.number - 1; number >= 1 && previous.length < PARAGRAPH_LOOKBEHIND; number -= 1) {
    const text = state.doc.line(number).text
    if (!text.trim()) break
    previous.push(text)
  }
  const next: string[] = []
  for (let number = line.number + 1; number <= state.doc.lines && next.length < PARAGRAPH_LOOKAHEAD; number += 1) {
    const text = state.doc.line(number).text
    if (!text.trim()) break
    next.push(text)
  }
  const resolved = module.resolvePassageAt({
    text: line.text,
    offset: pos - line.from,
    previous,
    next,
    profile: state.field(languageProfileField, false) ?? null,
  })
  if (!resolved) return null
  return { ...resolved.passage, allowed: resolved.allowed }
}

/** French elision prefix: "l'" in "l'homem" stays while the word behind it is corrected. */
const FRENCH_ELISION = /^((?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu|quoiqu)['’])(\p{L}+)$/iu
const BOUNDARY = /^[\s.,;:!?]$/u
const IGNORED_NODE = /^(?:CodeBlock|FencedCode|InlineCode|CodeText|URL|LinkDestination|Autolink|HTMLBlock|HTMLTag|Comment|LinkTitle|Image)$/u
const LETTER = /[\p{L}\p{M}]/u
const WORD_INNER = /[\p{L}\p{M}'’\-]/u

type AutocorrectRecord = {
  from: number
  to: number
  original: string
  replacement: string
  /** Characters typed after the word since the correction (the boundary that triggered it). */
  boundary: number
}

const setAutocorrect = StateEffect.define<AutocorrectRecord | null>()
/** Dispatch this to make the spellchecker re-run (a word was ignored or added). */
export const rerunSpellingCheck = StateEffect.define<null>()

const autocorrectedMark = Decoration.mark({ class: 'cm-autocorrected' })

const lastAutocorrect = StateField.define<AutocorrectRecord | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setAutocorrect)) return effect.value
    // Any further edit ends the Backspace-revert window.
    return transaction.docChanged ? null : value
  },
  provide: (field) => EditorView.decorations.from(field, (value): DecorationSet => (
    value ? Decoration.set(autocorrectedMark.range(value.from, value.to)) : Decoration.none
  )),
})

const wordRangeAt = (state: EditorState, pos: number): { from: number; to: number; word: string } | null => {
  const line = state.doc.lineAt(pos)
  const text = line.text
  let start = pos - line.from
  let end = start
  while (start > 0 && WORD_INNER.test(text[start - 1])) start -= 1
  while (end < text.length && WORD_INNER.test(text[end])) end += 1
  while (start < end && !LETTER.test(text[start])) start += 1
  while (end > start && !LETTER.test(text[end - 1])) end -= 1
  if (start >= end) return null
  return { from: line.from + start, to: line.from + end, word: text.slice(start, end) }
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

const inIgnoredContext = (state: EditorState, from: number, to: number) => {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1)
  while (node) {
    if (IGNORED_NODE.test(node.name)) return true
    node = node.parent
  }
  const line = state.doc.lineAt(from)
  const ranges = spellingModule?.automaticIgnoredRanges({ from: line.from, text: line.text }) ?? []
  return ranges.some((range) => from < range.to && to > range.from)
}

const opensSentence = (state: EditorState, from: number) => {
  const line = state.doc.lineAt(from)
  const before = line.text.slice(0, from - line.from).replace(/^\s*(?:[-*+>]|\d+[.)]|#{1,6})?\s*/u, '')
  if (!before.trim()) return true
  return /[.!?:]\s*$/u.test(before)
}

type PlannedAutocorrect = { from: number; to: number; word: string; replacement: string }

/** A word that autocorrect may fix once the engine answered; everything the engine cannot know
 * (editor syntax, line language, sentence start) is decided here, synchronously. */
type AutocorrectRequest = {
  from: number
  to: number
  word: string
  language: TextLanguage
  sentenceStart: boolean
  properName: boolean
}

/** The misspelled word ending exactly at `wordEnd`, or null. Autocorrect only acts when the passage's
 * language is certain and the word is unknown in every language the note uses; with any doubt the
 * word stays underlined and untouched. */
const requestAutocorrect = (state: EditorState, wordEnd: number): AutocorrectRequest | null => {
  const module = spellingModule
  const engine = spellingEngine
  if (!module || !engine || state.readOnly) return null
  const line = state.doc.lineAt(wordEnd)
  const offset = wordEnd - line.from
  let start = offset
  while (start > 0 && LETTER.test(line.text[start - 1])) start -= 1
  if (start === offset) return null
  // Part of a tag, path, e-mail, hyphenated or apostrophised token: leave it.
  if (start > 0 && /[\p{L}\p{M}\d'’\-_#@/\\.:&+]/u.test(line.text[start - 1])) return null
  const word = line.text.slice(start, offset)
  if (isAutocorrectDeclined(word)) return null
  const from = line.from + start
  const passage = passageContextAt(state, from)
  // Reading the French word list takes a moment; start it as soon as a word is finished in a French passage,
  // so the first typo there is already corrected.
  if (passage?.language === 'fr') warmSpellingLanguages(['fr'])
  if (!passage?.language || !passage.confident || passage.foreign || passage.unsupported) return null
  // A word any dictionary knows is never rewritten, even one of a language this note has not shown yet
  // ("soir" in a German line that turns French): underlining follows the note's languages, autocorrect all of them.
  if (!engine.isMisspelled(word, ALL_LANGUAGES)) return null
  if (inIgnoredContext(state, from, wordEnd)) return null
  return {
    from,
    to: wordEnd,
    word,
    language: passage.language,
    sentenceStart: opensSentence(state, from),
    properName: module.isCanonicalProperName(word.normalize('NFC').toLocaleLowerCase('en-US')),
  }
}

/**
 * Applies a planned correction after the boundary (`boundary` characters long)
 * has already been inserted behind the word. The correction is its own undo
 * step, so Ctrl+Z takes back exactly the fix and keeps what was typed.
 */
const commitAutocorrect = (view: EditorView, plan: PlannedAutocorrect, boundary: number) => {
  const head = view.state.selection.main.head
  const delta = plan.replacement.length - plan.word.length
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.replacement },
    selection: EditorSelection.cursor(head + delta),
    effects: setAutocorrect.of({ from: plan.from, to: plan.from + plan.replacement.length, original: plan.word, replacement: plan.replacement, boundary }),
    annotations: [isolateHistory.of('full'), Transaction.userEvent.of('input.autocorrect')],
  })
}

/**
 * Asks the engine about `request` and applies the fix once it answered. The boundary typed after
 * the word has been inserted by the editor by then, so the fix follows as its own undo step. It
 * is dropped when the text moved on in the meantime. `boundaryAt` reports how many characters
 * the boundary is long, or null when the document no longer looks like it did.
 */
const decideRequest = (request: AutocorrectRequest) => {
  const engine = spellingEngine
  if (!engine) return Promise.resolve(null)
  return engine.planAutocorrect(request.word, [request.language], {
    language: request.language,
    sentenceStart: request.sentenceStart,
    properName: request.properName,
  })
}

/** What autocorrect would do for the word ending at `wordEnd` in `state`, or null. Same decision as
 * typing the boundary after the word; the check scripts drive it without a view. */
export const planAutocorrectAt = async (state: EditorState, wordEnd: number): Promise<PlannedAutocorrect | null> => {
  const request = requestAutocorrect(state, wordEnd)
  if (!request) return null
  const decision = await decideRequest(request)
  return decision ? { from: request.from, to: request.to, word: request.word, replacement: decision.word } : null
}

const resolveAutocorrect = (
  view: EditorView,
  request: AutocorrectRequest,
  options: SpellingCorrectionsOptions,
  boundaryAt: (state: EditorState) => number | null,
) => {
  decideRequest(request)
    .then((decision) => {
      if (!decision || !view.dom.isConnected || !readyForAutocorrect(view, options)) return
      const state = view.state
      if (state.doc.sliceString(request.from, request.to) !== request.word) return
      const boundary = boundaryAt(state)
      if (boundary === null) return
      commitAutocorrect(view, { from: request.from, to: request.to, word: request.word, replacement: decision.word }, boundary)
    })
    .catch(() => undefined)
}

const readyForAutocorrect = (view: EditorView, options: SpellingCorrectionsOptions) => (
  options.autocorrectEnabled() && !view.composing && view.state.selection.main.empty
)

/** Backspace right after an autocorrect restores what was typed and stops correcting that word. */
const revertAutocorrect = (view: EditorView): boolean => {
  const record = view.state.field(lastAutocorrect)
  const selection = view.state.selection.main
  if (!record || record.boundary === 0 || !selection.empty || selection.head !== record.to + record.boundary) return false
  declineAutocorrect(record.original)
  view.dispatch({
    changes: { from: record.from, to: record.to + record.boundary, insert: record.original },
    selection: EditorSelection.cursor(record.from + record.original.length),
    effects: setAutocorrect.of(null),
    annotations: Transaction.userEvent.of('delete.autocorrect'),
  })
  return true
}

/* ---------- suggestion menu ---------- */

type MenuState = {
  from: number
  to: number
  word: string
  language: TextLanguage | null
  /** null while suggestions are being computed */
  suggestions: SpellingSuggestion[] | null
  /** Set when the word is the result of an autocorrect, offering a revert. */
  autocorrected: AutocorrectRecord | null
  /** Right-click and Ctrl+. focus the first suggestion. A plain click leaves the caret. */
  focusOnOpen: boolean
}

const openMenu = StateEffect.define<MenuState | null>()
const menuSuggestions = StateEffect.define<{ word: string; suggestions: SpellingSuggestion[] }>()

const spellingMenu = StateField.define<MenuState | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(openMenu)) return effect.value
      if (effect.is(menuSuggestions) && value && value.word === effect.value.word) return { ...value, suggestions: effect.value.suggestions }
    }
    if (!value) return null
    if (transaction.docChanged) return null
    if (transaction.selection) {
      const head = transaction.selection.main.head
      if (head < value.from || head > value.to) return null
    }
    return value
  },
  provide: (field) => showTooltip.compute([field], (state) => menuTooltip(state.field(field))),
})

// One stable `create` so CodeMirror keeps the same tooltip DOM (and its focus)
// while the menu state changes from "loading" to "suggestions".
const createMenuView = (view: EditorView): TooltipView => {
  const dom = document.createElement('div')
  dom.className = 'cm-spelling-menu'
  dom.setAttribute('role', 'menu')
  dom.setAttribute('aria-label', 'Rechtschreibvorschläge')
  let rendered = view.state.field(spellingMenu)
  if (rendered) renderMenu(dom, view, rendered)
  const focusFirst = () => dom.querySelector<HTMLButtonElement>('button')?.focus()
  return {
    dom,
    mount: () => {
      if (view.state.field(spellingMenu)?.focusOnOpen) focusFirst()
    },
    update: (update) => {
      const next = update.state.field(spellingMenu)
      if (!next || next === rendered) return
      const hadFocus = dom.contains(document.activeElement)
      rendered = next
      renderMenu(dom, view, next)
      if (hadFocus) focusFirst()
    },
  }
}

const menuTooltip = (menu: MenuState | null): Tooltip | null => (
  menu ? { pos: menu.from, end: menu.to, above: false, strictSide: false, arrow: false, create: createMenuView, clip: false } : null
)

const menuButton = (label: string, className: string, onClick: () => void) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `cm-spelling-menu__item ${className}`
  button.setAttribute('role', 'menuitem')
  button.textContent = label
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', onClick)
  return button
}

const renderMenu = (dom: HTMLElement, view: EditorView, menu: MenuState) => {
  dom.replaceChildren()
  const close = () => view.dispatch({ effects: openMenu.of(null) })
  const replaceWith = (replacement: string) => {
    view.dispatch({
      changes: { from: menu.from, to: menu.to, insert: replacement },
      selection: EditorSelection.cursor(menu.from + replacement.length),
      effects: [openMenu.of(null), setAutocorrect.of(null)],
      annotations: Transaction.userEvent.of('input.complete'),
    })
    view.focus()
  }
  const rerun = (effects: StateEffect<unknown>[]) => {
    view.dispatch({ effects: [openMenu.of(null), ...effects, rerunSpellingCheck.of(null)] })
    view.focus()
  }

  const head = document.createElement('div')
  head.className = 'cm-spelling-menu__word'
  head.textContent = menu.word
  head.lang = languageTag(menu.language)
  dom.append(head)

  const list = document.createElement('div')
  list.className = 'cm-spelling-menu__suggestions'
  if (menu.suggestions === null) {
    const loading = document.createElement('div')
    loading.className = 'cm-spelling-menu__note'
    loading.textContent = 'Vorschläge werden gesucht …'
    list.append(loading)
  } else if (!menu.suggestions.length) {
    const empty = document.createElement('div')
    empty.className = 'cm-spelling-menu__note'
    empty.textContent = 'Keine Vorschläge'
    list.append(empty)
  } else {
    for (const suggestion of menu.suggestions) {
      const button = menuButton(suggestion.word, 'cm-spelling-menu__suggestion', () => replaceWith(suggestion.word))
      button.lang = languageTag(suggestion.language)
      list.append(button)
    }
  }
  dom.append(list)

  const actions = document.createElement('div')
  actions.className = 'cm-spelling-menu__actions'
  if (menu.autocorrected) {
    const original = menu.autocorrected.original
    actions.append(menuButton(`Autokorrektur rückgängig: „${original}“`, 'cm-spelling-menu__revert', () => {
      declineAutocorrect(original)
      replaceWith(original)
    }))
  }
  actions.append(menuButton('Ignorieren', 'cm-spelling-menu__ignore', () => {
    ignoreWordForSession(menu.word)
    rerun([])
  }))
  actions.append(menuButton('Zum Wörterbuch hinzufügen', 'cm-spelling-menu__learn', () => {
    addPersonalWord(menu.word)
    rerun([])
  }))
  dom.append(actions)

  dom.onkeydown = (event) => {
    const buttons = [...dom.querySelectorAll<HTMLButtonElement>('button')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      view.focus()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      buttons[(index + step + buttons.length) % buttons.length]?.focus()
    }
  }
}

const elementAt = (view: EditorView, pos: number, side: -1 | 1) => {
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length))
  const place = view.domAtPos(clamped, side)
  const node = place.node
  return node instanceof Element ? node : node.parentElement
}

/** True when `pos` sits on a red spelling mark or a just-autocorrected word. */
const markedWordAt = (view: EditorView, pos: number) => {
  if (elementAt(view, pos, 1)?.closest('.cm-spelling-error, .cm-autocorrected')) return true
  return Boolean(elementAt(view, pos, -1)?.closest('.cm-spelling-error, .cm-autocorrected'))
}

/**
 * The note scroller clips overflow, so a tooltip inside the editor is cut off
 * at the bottom and the right of the sheet. A zero-size host in the editor
 * stage stays in the theme, out of that clip, and out of the shell grid.
 */
const spellingTooltipParent = (): HTMLElement | undefined => {
  if (typeof document === 'undefined') return undefined
  const stage = document.querySelector('.editor-stage')
  if (!(stage instanceof HTMLElement)) return document.body
  const existing = stage.querySelector(':scope > .cm-spelling-tooltip-host')
  if (existing instanceof HTMLElement) return existing
  const host = document.createElement('div')
  host.className = 'cm-spelling-tooltip-host'
  host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:80;pointer-events:none;'
  stage.appendChild(host)
  return host
}

/** Opens the suggestion menu for the word around `pos`; suggestions arrive asynchronously. */
export const openSpellingMenuAt = (view: EditorView, pos: number, options: SpellingCorrectionsOptions, focusOnOpen = true): boolean => {
  const range = wordRangeAt(view.state, pos)
  if (!range) return false
  const record = view.state.field(lastAutocorrect)
  const autocorrected = record && record.from === range.from && record.to === range.to ? record : null
  const passage = passageContextAt(view.state, range.from)
  const language = passage?.language ?? null
  const open = view.state.field(spellingMenu, false)
  if (open && open.word === range.word && open.from === range.from && open.to === range.to) {
    if (open.focusOnOpen !== focusOnOpen) view.dispatch({ effects: openMenu.of({ ...open, focusOnOpen }) })
    return true
  }
  const menu: MenuState = { ...range, language, suggestions: null, autocorrected, focusOnOpen }
  view.dispatch({ effects: openMenu.of(menu) })
  void primeSpellingCorrections()
    .then(async (engine) => {
      const allowed = passage?.allowed ?? ['de', 'en']
      // The menu offers words of the passage's language; when that is unsure, of every language the note uses.
      const among = passage?.confident && language ? [language] : allowed
      const elided = among.includes('fr') ? FRENCH_ELISION.exec(range.word) : null
      let suggestions: SpellingSuggestion[] = []
      if (engine.isMisspelled(range.word, allowed)) {
        suggestions = await engine.suggest(elided ? elided[2] : range.word, among, { limit: 6 })
        // "l'homem": the elision stays, the word after it is corrected.
        if (elided) suggestions = suggestions.map((entry) => ({ ...entry, word: `${elided[1]}${entry.word}` }))
      }
      const current = view.state.field(spellingMenu, false)
      if (!current || current.word !== range.word) return
      view.dispatch({ effects: menuSuggestions.of({ word: range.word, suggestions }) })
    })
    .catch(() => {
      if (view.state.field(spellingMenu, false)?.word === range.word) view.dispatch({ effects: menuSuggestions.of({ word: range.word, suggestions: [] }) })
    })
  return true
}

export const closeSpellingMenu = (view: EditorView) => {
  if (!view.state.field(spellingMenu, false)) return false
  view.dispatch({ effects: openMenu.of(null) })
  return true
}

export function spellingCorrections(options: SpellingCorrectionsOptions): Extension {
  return [
    tooltips({ parent: spellingTooltipParent(), position: 'fixed' }),
    languageProfileField,
    lastAutocorrect,
    spellingMenu,
    EditorView.inputHandler.of((view, from, to, text) => {
      if (from !== to || !BOUNDARY.test(text) || !readyForAutocorrect(view, options)) return false
      if (view.state.selection.main.head !== from) return false
      const request = requestAutocorrect(view.state, from)
      if (!request) return false
      // The boundary is typed as usual; the fix follows as its own step once the engine answered.
      resolveAutocorrect(view, request, options, (state) => (
        state.selection.main.empty
        && state.selection.main.head === from + text.length
        && state.doc.sliceString(from, from + text.length) === text
          ? text.length
          : null
      ))
      return false
    }),
    Prec.highest(keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          if (!readyForAutocorrect(view, options)) return false
          const wordEnd = view.state.selection.main.head
          const request = requestAutocorrect(view.state, wordEnd)
          if (!request) return false
          // The newline is inserted by the regular Enter handling that runs after this one.
          resolveAutocorrect(view, request, options, (state) => {
            const head = state.selection.main.head
            return state.selection.main.empty
              && head > wordEnd
              && state.doc.sliceString(wordEnd, wordEnd + 1) === '\n'
              && state.doc.lineAt(head).number === state.doc.lineAt(wordEnd).number + 1
              ? head - wordEnd
              : null
          })
          return false
        },
      },
      { key: 'Backspace', run: revertAutocorrect },
      { key: 'Mod-.', preventDefault: true, run: (view) => openSpellingMenuAt(view, view.state.selection.main.head, options) },
      { key: 'Escape', run: closeSpellingMenu },
    ])),
    EditorView.domEventHandlers({
      // A click on the red word offers the same list Word shows on right-click.
      // Return false so the caret from this click stays put.
      click: (event, view) => {
        if (event.button !== 0 || !view.state.selection.main.empty) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null || !markedWordAt(view, pos)) return false
        openSpellingMenuAt(view, pos, options, false)
        return false
      },
      contextmenu: (event, view) => {
        const target = event.target instanceof Element ? event.target : null
        const onMark = Boolean(target?.closest('.cm-spelling-error, .cm-autocorrected'))
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null || (!onMark && !markedWordAt(view, pos))) return false
        event.preventDefault()
        return openSpellingMenuAt(view, pos, options, true)
      },
    }),
  ]
}
