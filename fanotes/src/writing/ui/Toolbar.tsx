import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowLeft, Bold, BookOpen, ChevronDown, Download, Focus, Italic, LayoutGrid, ListTree, Columns2, Eye, FileText,
  CalendarRange, MapPin, MessageSquarePlus, Minus, PanelRight, Plus, Redo2, Search, SlidersHorizontal, SpellCheck, Strikethrough, Subscript, Superscript, Target, TextCursor, Underline, Undo2, Users, X,
} from 'lucide-react'
import { memo, type Dispatch, type SetStateAction } from 'react'
import type { setMark } from '../editor/commands'
import type { Align, FontFamilyId, Marks, ParagraphStyle, StoryLanguage } from '../model/types'
import { L, styleName } from './i18n'
import type { InspectorTab } from './Inspector'
import type { PageTheme, ViewMode } from './PageView'

export type Area = 'manuscript' | 'board' | 'outline' | 'characters' | 'places' | 'timeline' | 'goals'

const FONT_CHOICES: Array<{ id: FontFamilyId; label: string }> = [
  { id: 'literata', label: 'Literata' },
  { id: 'garamond', label: 'EB Garamond' },
  { id: 'courier', label: 'Courier Prime' },
  { id: 'atkinson', label: 'Atkinson' },
]
const SIZES = [8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40]
export const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const COLORS = ['#1f2937', '#7f1d1d', '#9a3412', '#166534', '#1e3a8a', '#6b21a8', '#6b7280']
const HIGHLIGHTS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa']
const LANGUAGES: Array<{ id: StoryLanguage; label: string }> = [
  { id: 'de', label: 'DE' },
  { id: 'de-CH', label: 'DE-CH' },
  { id: 'en-US', label: 'EN-US' },
  { id: 'en-GB', label: 'EN-GB' },
]

/** Stable callbacks (see useStableActions); the toolbar never receives a new function. */
export type ToolbarActions = {
  close: () => Promise<void> | void
  refocus: () => void
  undo: () => void
  redo: () => void
  setStyle: (style: string) => void
  setMarkValue: (patch: Parameters<typeof setMark>[1]) => void
  setAlignment: (align: Align) => void
  toggleMark: (key: 'b' | 'i' | 'u' | 's' | 'sup' | 'sub' | 'sc') => void
  insertBreak: (kind: 'page' | 'scene' | 'chapter') => void
  addFootnote: () => void
  addComment: () => void
  changeLanguage: (language: StoryLanguage) => void
  toggleReference: () => void
}

type Props = {
  act: ToolbarActions
  title: string
  binderOpen: boolean
  setBinderOpen: Dispatch<SetStateAction<boolean>>
  area: Area
  setArea: (area: Area) => void
  canUndo: boolean
  canRedo: boolean
  styles: Record<string, ParagraphStyle>
  currentStyle: string
  marks: Marks
  align: Align | undefined
  findOpen: boolean
  setFind: Dispatch<SetStateAction<{ open: boolean; replace: boolean; query: string; replacement: string; caseSensitive: boolean; wholeWord: boolean; regex: boolean; current: number }>>
  language: StoryLanguage
  view: ViewMode
  setView: (view: ViewMode) => void
  theme: PageTheme
  setTheme: (theme: PageTheme) => void
  setExportOpen: (open: boolean) => void
  typewriter: boolean
  setTypewriter: Dispatch<SetStateAction<boolean>>
  referenceOpen: boolean
  inspectorOpen: boolean
  setInspectorOpen: Dispatch<SetStateAction<boolean>>
  inspectorTab: InspectorTab
  setInspectorTab: (tab: InspectorTab) => void
  focusMode: boolean
  setFocusMode: Dispatch<SetStateAction<boolean>>
  zoom: number
  setZoom: Dispatch<SetStateAction<number>>
}

/** The formatting toolbar. Memoized: it only re-renders when one of its (primitive or stable) props changes, not per keystroke. */
export const Toolbar = memo(function Toolbar({ act, title, binderOpen, setBinderOpen, area, setArea, canUndo, canRedo, styles, currentStyle, marks, align, findOpen, setFind, language, view, setView, theme, setTheme, setExportOpen, typewriter, setTypewriter, referenceOpen, inspectorOpen, setInspectorOpen, inspectorTab, setInspectorTab, focusMode, setFocusMode, zoom, setZoom }: Props) {
  const styleIds = Object.keys(styles)
  return (
  <header className="wm-toolbar" onMouseDown={(event) => { if ((event.target as HTMLElement).closest('button')) event.preventDefault() }}>
    <button type="button" className="wm-icon" title={L('Zurück zu den Notizen', 'Back to notes')} onClick={() => void act.close()}><ArrowLeft size={16} /></button>
    <button type="button" className={`wm-icon${binderOpen ? ' is-on' : ''}`} title={L('Gliederung', 'Binder')} onClick={() => setBinderOpen((value) => !value)}><BookOpen size={16} /></button>
    <strong className="wm-title" data-i18n-ignore>{title}</strong>
    <div className="wm-segmented wm-areas" role="tablist" aria-label={L('Bereich', 'Area')}>
      {([
        ['manuscript', FileText, L('Manuskript', 'Manuscript')],
        ['board', LayoutGrid, L('Pinnwand', 'Corkboard')],
        ['outline', ListTree, L('Übersicht', 'Outline')],
        ['characters', Users, L('Figuren', 'Characters')],
        ['places', MapPin, L('Orte', 'Places')],
        ['timeline', CalendarRange, L('Zeitleiste', 'Timeline')],
        ['goals', Target, L('Ziele', 'Goals')],
      ] as const).map(([id, Icon, label]) => (
        <button key={id} type="button" role="tab" aria-selected={area === id} className={area === id ? 'is-on' : ''} title={label} aria-label={label} onClick={() => { setArea(id); if (id === 'manuscript') act.refocus() }}><Icon size={15} /></button>
      ))}
    </div>
    <span className="wm-sep" />
    {area === 'manuscript' && (<>
    <button type="button" className="wm-icon" title={L('Rückgängig (Strg+Z)', 'Undo (Ctrl+Z)')} disabled={!canUndo} onClick={() => { act.undo(); act.refocus() }}><Undo2 size={16} /></button>
    <button type="button" className="wm-icon" title={L('Wiederholen (Strg+Y)', 'Redo (Ctrl+Y)')} disabled={!canRedo} onClick={() => { act.redo(); act.refocus() }}><Redo2 size={16} /></button>
    <span className="wm-sep" />
    <select className="wm-select wm-style" value={currentStyle} title={L('Absatzformat', 'Paragraph style')} onChange={(event) => { act.setStyle(event.target.value); act.refocus() }}>
      {styleIds.map((id) => <option key={id} value={id}>{styleName(styles[id])}</option>)}
    </select>
    <select className="wm-select" value={marks.font ?? styles[currentStyle]?.font ?? 'literata'} title={L('Schrift', 'Font')} onChange={(event) => { act.setMarkValue({ font: event.target.value as FontFamilyId }); act.refocus() }}>
      {FONT_CHOICES.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
    </select>
    <select className="wm-select wm-size" value={String(marks.size ?? styles[currentStyle]?.size ?? 11)} title={L('Schriftgrösse', 'Font size')} onChange={(event) => { act.setMarkValue({ size: Number(event.target.value) }); act.refocus() }}>
      {[...new Set([...SIZES, marks.size ?? styles[currentStyle]?.size ?? 11])].sort((a, b) => a - b).map((size) => <option key={size} value={size}>{size}</option>)}
    </select>
    <span className="wm-sep" />
    {([['b', Bold, L('Fett (Strg+B)', 'Bold (Ctrl+B)')], ['i', Italic, L('Kursiv (Strg+I)', 'Italic (Ctrl+I)')], ['u', Underline, L('Unterstrichen (Strg+U)', 'Underline (Ctrl+U)')], ['s', Strikethrough, L('Durchgestrichen', 'Strikethrough')], ['sup', Superscript, L('Hochgestellt', 'Superscript')], ['sub', Subscript, L('Tiefgestellt', 'Subscript')]] as const).map(([key, Icon, label]) => (
      <button key={key} type="button" className={`wm-icon${marks[key] ? ' is-on' : ''}`} title={label} aria-pressed={Boolean(marks[key])} onClick={() => { act.toggleMark(key); act.refocus() }}><Icon size={16} /></button>
    ))}
    <button type="button" className={`wm-icon wm-text-icon${marks.sc ? ' is-on' : ''}`} title={L('Kapitälchen (Strg+Umschalt+K)', 'Small caps (Ctrl+Shift+K)')} onClick={() => { act.toggleMark('sc'); act.refocus() }}>Kᴀᴘ</button>
    <details className="wm-menu">
      <summary className="wm-icon" title={L('Farbe und Markierung', 'Colour and highlight')}><span className="wm-color-dot" style={{ background: marks.color ?? 'currentColor' }} /><ChevronDown size={12} /></summary>
      <div className="wm-popover">
        <small>{L('Schriftfarbe', 'Text colour')}</small>
        <div className="wm-swatches">{COLORS.map((color) => <button key={color} type="button" style={{ background: color }} aria-label={color} onClick={() => { act.setMarkValue({ color }); act.refocus() }} />)}<button type="button" className="wm-swatch-clear" onClick={() => { act.setMarkValue({ color: null }); act.refocus() }}><X size={12} /></button></div>
        <small>{L('Markierung', 'Highlight')}</small>
        <div className="wm-swatches">{HIGHLIGHTS.map((color) => <button key={color} type="button" style={{ background: color }} aria-label={color} onClick={() => { act.setMarkValue({ hl: color }); act.refocus() }} />)}<button type="button" className="wm-swatch-clear" onClick={() => { act.setMarkValue({ hl: null }); act.refocus() }}><X size={12} /></button></div>
      </div>
    </details>
    <span className="wm-sep" />
    {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight], ['justify', AlignJustify]] as const).map(([align, Icon]) => (
      <button key={align} type="button" className={`wm-icon${(align ?? styles[currentStyle]?.align) === align ? ' is-on' : ''}`} title={{ left: L('Linksbündig (Strg+L)', 'Align left (Ctrl+L)'), center: L('Zentriert (Strg+E)', 'Centre (Ctrl+E)'), right: L('Rechtsbündig (Strg+R)', 'Align right (Ctrl+R)'), justify: L('Blocksatz (Strg+J)', 'Justify (Ctrl+J)') }[align]} onClick={() => { act.setAlignment(align); act.refocus() }}><Icon size={16} /></button>
    ))}
    <span className="wm-sep" />
    <details className="wm-menu">
      <summary className="wm-icon" title={L('Einfügen', 'Insert')}><Plus size={16} /><ChevronDown size={12} /></summary>
      <div className="wm-popover wm-list">
        <button type="button" onClick={() => { act.addFootnote(); act.refocus() }}>{L('Fussnote', 'Footnote')} <kbd>Strg+Alt+F</kbd></button>
        <button type="button" onClick={() => { act.addComment(); act.refocus() }}><MessageSquarePlus size={14} /> {L('Kommentar', 'Comment')} <kbd>Strg+Alt+M</kbd></button>
        <button type="button" onClick={() => { act.insertBreak('page'); act.refocus() }}>{L('Seitenumbruch', 'Page break')} <kbd>Strg+Enter</kbd></button>
        <button type="button" onClick={() => { act.insertBreak('scene'); act.refocus() }}>{L('Neue Szene ab hier', 'New scene from here')} <kbd>Strg+⇧+Enter</kbd></button>
        <button type="button" onClick={() => { act.insertBreak('chapter'); act.refocus() }}>{L('Neues Kapitel ab hier', 'New chapter from here')} <kbd>Strg+Alt+Enter</kbd></button>
      </div>
    </details>
    <button type="button" className={`wm-icon${findOpen ? ' is-on' : ''}`} title={L('Suchen und Ersetzen (Strg+F / Strg+H)', 'Find and replace (Ctrl+F / Ctrl+H)')} onClick={() => setFind((value) => ({ ...value, open: !value.open }))}><Search size={16} /></button>
    </>)}
    <span className="wm-grow" />
    <select className="wm-select" value={language} title={L('Sprache der Geschichte', 'Story language')} onChange={(event) => act.changeLanguage(event.target.value as StoryLanguage)}>
      {LANGUAGES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <div className="wm-segmented" role="group" aria-label={L('Ansicht', 'View')}>
      <button type="button" className={view === 'page' ? 'is-on' : ''} title={L('Seitenansicht', 'Print layout')} onClick={() => setView('page')}><FileText size={15} /></button>
      <button type="button" className={view === 'spread' ? 'is-on' : ''} title={L('Doppelseite', 'Two-page spread')} onClick={() => setView('spread')}><Columns2 size={15} /></button>
      <button type="button" className={view === 'draft' ? 'is-on' : ''} title={L('Entwurf (fortlaufend)', 'Draft (continuous)')} onClick={() => setView('draft')}><Eye size={15} /></button>
    </div>
    <select className="wm-select wm-theme" value={theme} title={L('Papier', 'Paper')} onChange={(event) => setTheme(event.target.value as PageTheme)}>
      <option value="paper">{L('Papier', 'Paper')}</option>
      <option value="sepia">{L('Sepia', 'Sepia')}</option>
      <option value="night">{L('Nacht', 'Night')}</option>
      <option value="contrast">{L('Hoher Kontrast', 'High contrast')}</option>
    </select>
    <button type="button" className="wm-icon" title={L('Exportieren: PDF, Word, EPUB, Markdown, Text', 'Export: PDF, Word, EPUB, Markdown, text')} onClick={() => setExportOpen(true)}><Download size={16} /></button>
    <button type="button" className={`wm-icon${typewriter ? ' is-on' : ''}`} title={L('Schreibmaschinen-Modus: die aktuelle Zeile bleibt auf gleicher Höhe', 'Typewriter mode: the current line stays at the same height')} aria-pressed={typewriter} onClick={() => { setTypewriter((value) => !value); act.refocus() }}><TextCursor size={16} /></button>
    <button type="button" className={`wm-icon${referenceOpen ? ' is-on' : ''}`} title={L('Geteilte Ansicht: Szene, Figur oder Notiz daneben', 'Split view: a scene, character or note alongside')} aria-pressed={referenceOpen} onClick={() => act.toggleReference()}><PanelRight size={16} /></button>
    <button type="button" className={`wm-icon${inspectorOpen && inspectorTab === 'check' ? ' is-on' : ''}`} title={L('Prüfen: Rechtschreibung, Grammatik, Stil (F7)', 'Check spelling, grammar and style (F7)')} onClick={() => { if (inspectorOpen && inspectorTab === 'check') setInspectorOpen(false); else { setInspectorOpen(true); setInspectorTab('check') } }}><SpellCheck size={16} /></button>
    <button type="button" className={`wm-icon${inspectorOpen && inspectorTab !== 'check' ? ' is-on' : ''}`} title={L('Seite, Formate und Notizen', 'Page, styles and notes')} onClick={() => { if (inspectorOpen && inspectorTab !== 'check') setInspectorOpen(false); else { setInspectorOpen(true); setInspectorTab('page') } }}><SlidersHorizontal size={16} /></button>
    <button type="button" className={`wm-icon${focusMode ? ' is-on' : ''}`} title={L('Fokusmodus (F11)', 'Focus mode (F11)')} onClick={() => { setFocusMode((value) => !value); act.refocus() }}><Focus size={16} /></button>
    <div className="wm-zoom">
      <button type="button" className="wm-icon" title={L('Verkleinern', 'Zoom out')} onClick={() => setZoom((value) => ZOOMS.filter((step) => step < value - 0.001).at(-1) ?? value)}><Minus size={14} /></button>
      <button type="button" className="wm-zoom-value" title={L('Auf 100 % (auch: Ctrl + Mausrad, zwei Finger)', 'Reset to 100 % (also: Ctrl + wheel, pinch)')} onClick={() => { setZoom(1); act.refocus() }}>{Math.round(zoom * 100)} %</button>
      <button type="button" className="wm-icon" title={L('Vergrössern', 'Zoom in')} onClick={() => setZoom((value) => ZOOMS.find((step) => step > value + 0.001) ?? value)}><Plus size={14} /></button>
    </div>
  </header>
  )
})
