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
import { Decoration, EditorView, keymap, showTooltip, type DecorationSet, type Tooltip, type TooltipView } from '@codemirror/view'
import type { SpellingLanguage } from '../types'
import {
  addPersonalWord,
  decideAutocorrect,
  declineAutocorrect,
  ignoreWordForSession,
  isAutocorrectDeclined,
  suggestCorrections,
  type SpellingSuggestion,
} from './spellingSuggest'

/**
 * Corrections for the spellchecker: an autocorrect that fires when a word is
 * finished (space, punctuation, Enter) and a suggestion menu on a right-click or
 * Ctrl+. — both fed by the same dictionaries as the red underline.
 */

type SpellingModule = typeof import('./spelling')
let spellingModule: SpellingModule | null = null
let primePromise: Promise<SpellingModule> | null = null

/** Loads dictionaries and exact word lists once; autocorrect is silent until this resolved. */
export const primeSpellingCorrections = () => {
  primePromise ??= import('./spelling')
    .then(async (module) => {
      await module.loadSpellingLexicon()
      spellingModule = module
      return module
    })
    .catch((error) => {
      primePromise = null
      throw error
    })
  return primePromise
}

export type SpellingCorrectionsOptions = {
  autocorrectEnabled: () => boolean
  /** Language the spellchecker assigned to the line at `pos`, if it has run there. */
  languageAt: (state: EditorState, pos: number) => SpellingLanguage | null
}

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

/** The one sure fix for the word ending exactly at `wordEnd`, or null. */
const planAutocorrect = (state: EditorState, wordEnd: number, options: SpellingCorrectionsOptions): PlannedAutocorrect | null => {
  const module = spellingModule
  if (!module || state.readOnly) return null
  const lexicon = module.loadedSpellingLexicon()
  if (!lexicon) return null
  const line = state.doc.lineAt(wordEnd)
  const offset = wordEnd - line.from
  let start = offset
  while (start > 0 && LETTER.test(line.text[start - 1])) start -= 1
  if (start === offset) return null
  // Part of a tag, path, e-mail, hyphenated or apostrophised token: leave it.
  if (start > 0 && /[\p{L}\p{M}\d'’\-_#@/\\.:&+]/u.test(line.text[start - 1])) return null
  const word = line.text.slice(start, offset)
  if (isAutocorrectDeclined(word) || !lexicon.isMisspelled(word)) return null
  const from = line.from + start
  if (inIgnoredContext(state, from, wordEnd)) return null
  const language = options.languageAt(state, line.from)
  const suggestions = suggestCorrections(word, language ? [language] : lexicon.languages, lexicon, { limit: 4, maxDistance: 1 })
  const decision = decideAutocorrect(word, suggestions, {
    language,
    sentenceStart: opensSentence(state, from),
    isProperName: module.isCanonicalProperName,
  })
  return decision ? { from, to: wordEnd, word, replacement: decision.word } : null
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
  language: SpellingLanguage | null
  /** null while suggestions are being computed */
  suggestions: SpellingSuggestion[] | null
  /** Set when the word is the result of an autocorrect, offering a revert. */
  autocorrected: AutocorrectRecord | null
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
    mount: focusFirst,
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
  menu ? { pos: menu.from, end: menu.to, above: false, strictSide: false, arrow: false, create: createMenuView } : null
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
  head.lang = menu.language === 'en' ? 'en' : 'de-CH'
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
      button.lang = suggestion.language === 'en' ? 'en' : 'de-CH'
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

/** Opens the suggestion menu for the word around `pos`; suggestions arrive asynchronously. */
export const openSpellingMenuAt = (view: EditorView, pos: number, options: SpellingCorrectionsOptions): boolean => {
  const range = wordRangeAt(view.state, pos)
  if (!range) return false
  const record = view.state.field(lastAutocorrect)
  const autocorrected = record && record.from === range.from && record.to === range.to ? record : null
  const language = options.languageAt(view.state, range.from)
  const menu: MenuState = { ...range, language, suggestions: null, autocorrected }
  view.dispatch({ effects: openMenu.of(menu) })
  void primeSpellingCorrections()
    .then((module) => {
      const lexicon = module.loadedSpellingLexicon()
      const current = view.state.field(spellingMenu, false)
      if (!lexicon || !current || current.word !== range.word) return
      const suggestions = lexicon.isMisspelled(range.word)
        ? suggestCorrections(range.word, language ? [language] : lexicon.languages, lexicon, { limit: 6 })
        : []
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
    lastAutocorrect,
    spellingMenu,
    EditorView.inputHandler.of((view, from, to, text) => {
      if (from !== to || !BOUNDARY.test(text) || !readyForAutocorrect(view, options)) return false
      if (view.state.selection.main.head !== from) return false
      const plan = planAutocorrect(view.state, from, options)
      if (!plan) return false
      // The boundary goes in first as ordinary typing; the fix follows as its own step.
      view.dispatch({
        changes: { from, insert: text },
        selection: EditorSelection.cursor(from + text.length),
        scrollIntoView: true,
        userEvent: 'input.type',
      })
      commitAutocorrect(view, plan, text.length)
      return true
    }),
    Prec.highest(keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          if (!readyForAutocorrect(view, options)) return false
          const wordEnd = view.state.selection.main.head
          const plan = planAutocorrect(view.state, wordEnd, options)
          if (!plan) return false
          if (!insertNewlineAndIndent(view)) return false
          commitAutocorrect(view, plan, view.state.selection.main.head - wordEnd)
          return true
        },
      },
      { key: 'Backspace', run: revertAutocorrect },
      { key: 'Mod-.', preventDefault: true, run: (view) => openSpellingMenuAt(view, view.state.selection.main.head, options) },
      { key: 'Escape', run: closeSpellingMenu },
    ])),
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        const target = event.target instanceof Element ? event.target : null
        if (!target?.closest('.cm-spelling-error, .cm-autocorrected')) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return false
        event.preventDefault()
        return openSpellingMenuAt(view, pos, options)
      },
    }),
  ]
}
