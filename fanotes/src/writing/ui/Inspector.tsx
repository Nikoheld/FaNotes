import { Check, MessageSquare, RotateCcw, Trash2 } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import * as commands from '../editor/commands'
import type { WritingController } from '../editor/controller'
import { makeDoc } from '../editor/doc'
import { defaultPageSetup, defaultStyles, PAGE_SIZES } from '../model/defaults'
import { paragraphKey } from '../model/flow'
import { runsText } from '../model/runs'
import type { Align, FontFamilyId, PageSetup, PageSizeId, ParagraphStyle, StoryManifest } from '../model/types'
import { L, styleName } from './i18n'
import { CheckPanel } from './CheckPanel'
import type { ComponentProps } from 'react'

export type InspectorTab = 'scene' | 'page' | 'styles' | 'notes' | 'check'
type Tab = InspectorTab

const FONTS: Array<{ id: FontFamilyId; label: string }> = [
  { id: 'literata', label: 'Literata' },
  { id: 'garamond', label: 'EB Garamond' },
  { id: 'courier', label: 'Courier Prime' },
  { id: 'atkinson', label: 'Atkinson Hyperlegible' },
]

const NumberField = ({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void }) => (
  <label className="wm-field">
    <span>{label}</span>
    <span className="wm-field-input">
      <input type="number" value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0} min={min} max={max} step={step} onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)))
      }} />
      {unit && <small>{unit}</small>}
    </span>
  </label>
)

const Toggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) => (
  <label className="wm-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> <span>{label}</span></label>
)

export const Inspector = memo(function Inspector({ controller, manifest, footnoteNumbers, onClose, tab: requestedTab, onTab, check, scene }: {
  /** Changes when the document changed; the panels read it from the controller. */
  revision?: unknown
  controller: WritingController; manifest: StoryManifest; footnoteNumbers: Map<string, string>; onClose: () => void; tab: Tab; onTab: (tab: Tab) => void; check: Omit<ComponentProps<typeof CheckPanel>, 'controller'>; scene: import('react').ReactNode }) {
  const tab = requestedTab
  const setTab = onTab
  const [styleId, setStyleId] = useState('body')
  const doc = controller.state.doc
  const setManifest = (next: StoryManifest) => controller.replaceDoc(makeDoc(next, controller.state.doc.scenes))
  const setPage = (patch: Partial<PageSetup>) => setManifest({ ...manifest, page: { ...manifest.page, ...patch } })
  const setStyle = (id: string, patch: Partial<ParagraphStyle>) => setManifest({ ...manifest, styles: { ...manifest.styles, [id]: { ...manifest.styles[id], ...patch } } })
  const page = manifest.page
  const style = manifest.styles[styleId] ?? manifest.styles.body

  const notes = useMemo(() => {
    const comments: Array<{ sceneId: string; id: string; text: string; author: string; at: string; resolved: boolean; excerpt: string; paragraphId: string | null; from: number; to: number }> = []
    const footnotes: Array<{ sceneId: string; id: string; text: string }> = []
    for (const scene of doc.scenes.values()) {
      for (const [id, comment] of Object.entries(scene.comments ?? {})) {
        let excerpt = ''
        let paragraphId: string | null = null
        let from = 0
        let to = 0
        for (const paragraph of scene.paragraphs) {
          let offset = 0
          for (const run of paragraph.runs) {
            if (run.m?.cm === id) {
              if (!paragraphId) { paragraphId = paragraph.id; from = offset }
              if (paragraphId === paragraph.id) to = offset + run.text.length
              excerpt += run.text
            }
            offset += run.text.length
          }
        }
        comments.push({ sceneId: scene.id, id, text: comment.text, author: comment.author, at: comment.at, resolved: Boolean(comment.resolved), excerpt: excerpt.slice(0, 120), paragraphId, from, to })
      }
      for (const [id, note] of Object.entries(scene.footnotes ?? {})) footnotes.push({ sceneId: scene.id, id, text: runsText(note.runs) })
    }
    return { comments, footnotes }
  }, [doc])

  const applySize = (size: PageSizeId) => {
    if (size === 'custom') return setPage({ size })
    const format = PAGE_SIZES[size]
    setPage({ size, width: format.width, height: format.height, margins: { ...format.margins }, mirror: size === 'A5' || size === 'pocket' || size === 'trade' })
  }

  return (
    <aside className="wm-inspector" aria-label={L('Einstellungen der Geschichte', 'Story settings')}>
      <div className="wm-tabs" role="tablist">
        {([['scene', L('Szene', 'Scene')], ['check', L('Prüfen', 'Check')], ['page', L('Seite', 'Page')], ['styles', L('Formate', 'Styles')], ['notes', L('Notizen', 'Notes')]] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
        <button type="button" className="wm-icon" onClick={onClose} aria-label={L('Schliessen', 'Close')}>×</button>
      </div>

      {tab === 'scene' && scene}
      {tab === 'check' && <CheckPanel controller={controller} {...check} />}

      {tab === 'page' && (
        <div className="wm-inspector-body">
          <section>
            <h4>{L('Geschichte', 'Story')}</h4>
            <label className="wm-field wide"><span>{L('Titel', 'Title')}</span><input value={manifest.title} data-i18n-ignore onChange={(event) => setManifest({ ...manifest, title: event.target.value })} /></label>
            <label className="wm-field wide"><span>{L('Untertitel', 'Subtitle')}</span><input value={manifest.subtitle ?? ''} data-i18n-ignore onChange={(event) => setManifest({ ...manifest, subtitle: event.target.value })} /></label>
            <label className="wm-field wide"><span>{L('Autor:in', 'Author')}</span><input value={manifest.author ?? ''} data-i18n-ignore onChange={(event) => setManifest({ ...manifest, author: event.target.value })} /></label>
          </section>
          <section>
            <h4>{L('Format', 'Format')}</h4>
            <label className="wm-field wide">
              <span>{L('Seitengrösse', 'Page size')}</span>
              <select value={page.size} onChange={(event) => applySize(event.target.value as PageSizeId)}>
                {(Object.keys(PAGE_SIZES) as Array<keyof typeof PAGE_SIZES>).map((id) => <option key={id} value={id}>{L(PAGE_SIZES[id].name.de, PAGE_SIZES[id].name.en)}</option>)}
                <option value="custom">{L('Eigene Grösse', 'Custom size')}</option>
              </select>
            </label>
            {page.size === 'custom' && (
              <div className="wm-grid">
                <NumberField label={L('Breite', 'Width')} value={page.width} min={50} max={600} unit="mm" onChange={(width) => setPage({ width })} />
                <NumberField label={L('Höhe', 'Height')} value={page.height} min={50} max={900} unit="mm" onChange={(height) => setPage({ height })} />
              </div>
            )}
            <div className="wm-grid">
              <NumberField label={L('Oben', 'Top')} value={page.margins.top} min={0} max={100} unit="mm" onChange={(top) => setPage({ margins: { ...page.margins, top } })} />
              <NumberField label={L('Unten', 'Bottom')} value={page.margins.bottom} min={0} max={100} unit="mm" onChange={(bottom) => setPage({ margins: { ...page.margins, bottom } })} />
              <NumberField label={page.mirror ? L('Innen', 'Inside') : L('Links', 'Left')} value={page.margins.inner} min={0} max={100} unit="mm" onChange={(inner) => setPage({ margins: { ...page.margins, inner } })} />
              <NumberField label={page.mirror ? L('Aussen', 'Outside') : L('Rechts', 'Right')} value={page.margins.outer} min={0} max={100} unit="mm" onChange={(outer) => setPage({ margins: { ...page.margins, outer } })} />
            </div>
            <Toggle label={L('Gespiegelte Ränder (Buch)', 'Mirrored margins (book)')} checked={page.mirror} onChange={(mirror) => setPage({ mirror })} />
            <button type="button" className="secondary-button wm-small" onClick={() => setManifest({ ...manifest, styles: defaultStyles(page.size === 'manuscript') })}>
              <RotateCcw size={13} /> {page.size === 'manuscript' ? L('Manuskript-Formate (Courier, doppelt)', 'Manuscript styles (Courier, double)') : L('Buch-Formate wiederherstellen', 'Restore book styles')}
            </button>
          </section>
          <section>
            <h4>{L('Kopf- und Fusszeile', 'Header and footer')}</h4>
            <p className="wm-hint">{L('Felder: {title} {chapter} {page} {pages} {author}', 'Fields: {title} {chapter} {page} {pages} {author}')}</p>
            {(['header', 'footer'] as const).map((part) => (
              <div key={part} className="wm-hf-fields">
                <small>{part === 'header' ? L('Kopfzeile', 'Header') : L('Fusszeile', 'Footer')}</small>
                {(['left', 'center', 'right'] as const).map((slot) => (
                  <input key={slot} aria-label={`${part} ${slot}`} placeholder={{ left: L('links', 'left'), center: L('Mitte', 'centre'), right: L('rechts', 'right') }[slot]} value={page[part][slot]} data-i18n-ignore onChange={(event) => setPage({ [part]: { ...page[part], [slot]: event.target.value } } as Partial<PageSetup>)} />
                ))}
              </div>
            ))}
            <Toggle label={L('Auf Kapitelanfängen ausblenden', 'Hide on chapter openings')} checked={page.hideOnChapterStart} onChange={(hideOnChapterStart) => setPage({ hideOnChapterStart })} />
            <div className="wm-grid">
              <NumberField label={L('Erste Seitenzahl', 'First page number')} value={page.pageNumberStart} min={0} max={9999} onChange={(pageNumberStart) => setPage({ pageNumberStart: Math.round(pageNumberStart) })} />
            </div>
          </section>
          <section>
            <h4>{L('Umbruch', 'Flow')}</h4>
            <Toggle label={L('Kapitel beginnen auf einer rechten Seite', 'Chapters start on a right-hand page')} checked={page.chapterStartsRight} onChange={(chapterStartsRight) => setPage({ chapterStartsRight })} />
            <Toggle label={L('Keine einzelnen Zeilen am Seitenrand (Hurenkinder, Schusterjungen)', 'No widows and orphans')} checked={page.widowsOrphans} onChange={(widowsOrphans) => setPage({ widowsOrphans })} />
            <Toggle label={L('Silbentrennung', 'Hyphenation')} checked={page.hyphenate} onChange={(hyphenate) => setPage({ hyphenate })} />
            <label className="wm-field wide"><span>{L('Szenenwechsel', 'Scene break')}</span><input value={page.sceneBreak} data-i18n-ignore onChange={(event) => setPage({ sceneBreak: event.target.value || '* * *' })} /></label>
            <button type="button" className="secondary-button wm-small" onClick={() => setPage(defaultPageSetup(page.size === 'custom' ? 'A5' : page.size, manifest.language))}><RotateCcw size={13} /> {L('Seite zurücksetzen', 'Reset page')}</button>
          </section>
        </div>
      )}

      {tab === 'styles' && (
        <div className="wm-inspector-body">
          <label className="wm-field wide">
            <span>{L('Absatzformat', 'Paragraph style')}</span>
            <select value={styleId} onChange={(event) => setStyleId(event.target.value)}>
              {Object.values(manifest.styles).map((entry) => <option key={entry.id} value={entry.id}>{styleName(entry)}</option>)}
            </select>
          </label>
          <section>
            <h4>{L('Schrift', 'Font')}</h4>
            <label className="wm-field wide">
              <span>{L('Schriftart', 'Typeface')}</span>
              <select value={style.font} onChange={(event) => setStyle(style.id, { font: event.target.value as FontFamilyId })}>{FONTS.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}</select>
            </label>
            <div className="wm-grid">
              <NumberField label={L('Grösse', 'Size')} value={style.size} min={5} max={96} step={0.5} unit="pt" onChange={(size) => setStyle(style.id, { size })} />
              <NumberField label={L('Zeilenabstand', 'Line spacing')} value={style.lineHeight} min={0.8} max={4} step={0.05} unit="×" onChange={(lineHeight) => setStyle(style.id, { lineHeight })} />
            </div>
            <div className="wm-toggles">
              <Toggle label={L('Fett', 'Bold')} checked={Boolean(style.bold)} onChange={(bold) => setStyle(style.id, { bold })} />
              <Toggle label={L('Kursiv', 'Italic')} checked={Boolean(style.italic)} onChange={(italic) => setStyle(style.id, { italic })} />
              <Toggle label={L('Kapitälchen', 'Small caps')} checked={Boolean(style.smallCaps)} onChange={(smallCaps) => setStyle(style.id, { smallCaps })} />
              <Toggle label={L('Grossbuchstaben', 'All caps')} checked={Boolean(style.uppercase)} onChange={(uppercase) => setStyle(style.id, { uppercase })} />
            </div>
          </section>
          <section>
            <h4>{L('Absatz', 'Paragraph')}</h4>
            <label className="wm-field wide">
              <span>{L('Ausrichtung', 'Alignment')}</span>
              <select value={style.align} onChange={(event) => setStyle(style.id, { align: event.target.value as Align })}>
                <option value="left">{L('Links', 'Left')}</option>
                <option value="center">{L('Zentriert', 'Centred')}</option>
                <option value="right">{L('Rechts', 'Right')}</option>
                <option value="justify">{L('Blocksatz', 'Justified')}</option>
              </select>
            </label>
            <div className="wm-grid">
              <NumberField label={L('Erstzeile', 'First line')} value={style.indentFirst} min={-50} max={100} step={0.5} unit="mm" onChange={(indentFirst) => setStyle(style.id, { indentFirst })} />
              <NumberField label={L('Links', 'Left')} value={style.indentLeft} min={0} max={100} step={0.5} unit="mm" onChange={(indentLeft) => setStyle(style.id, { indentLeft })} />
              <NumberField label={L('Rechts', 'Right')} value={style.indentRight} min={0} max={100} step={0.5} unit="mm" onChange={(indentRight) => setStyle(style.id, { indentRight })} />
              <NumberField label={L('Initiale (Zeilen)', 'Drop cap (lines)')} value={style.dropCap ?? 0} min={0} max={5} onChange={(dropCap) => setStyle(style.id, { dropCap: Math.round(dropCap) })} />
              <NumberField label={L('Abstand vor', 'Space before')} value={style.spaceBefore} min={0} max={400} unit="pt" onChange={(spaceBefore) => setStyle(style.id, { spaceBefore })} />
              <NumberField label={L('Abstand nach', 'Space after')} value={style.spaceAfter} min={0} max={400} unit="pt" onChange={(spaceAfter) => setStyle(style.id, { spaceAfter })} />
            </div>
            <div className="wm-toggles">
              <Toggle label={L('Mit nächstem Absatz zusammenhalten', 'Keep with next')} checked={Boolean(style.keepWithNext)} onChange={(keepWithNext) => setStyle(style.id, { keepWithNext })} />
              <Toggle label={L('Seitenumbruch davor', 'Page break before')} checked={Boolean(style.pageBreakBefore)} onChange={(pageBreakBefore) => setStyle(style.id, { pageBreakBefore })} />
            </div>
            <label className="wm-field wide"><span>{L('Aufzählungszeichen', 'List marker')}</span><input value={style.listMarker ?? ''} maxLength={4} data-i18n-ignore onChange={(event) => setStyle(style.id, { listMarker: event.target.value || undefined })} /></label>
          </section>
        </div>
      )}

      {tab === 'notes' && (
        <div className="wm-inspector-body">
          <section>
            <h4><MessageSquare size={13} /> {L('Kommentare', 'Comments')} ({notes.comments.length})</h4>
            {!notes.comments.length && <p className="wm-hint">{L('Text markieren und Strg+Alt+M drücken.', 'Select text and press Ctrl+Alt+M.')}</p>}
            {notes.comments.map((comment) => (
              <div key={comment.id} className={`wm-note${comment.resolved ? ' is-resolved' : ''}`}>
                <button type="button" className="wm-note-anchor" data-i18n-ignore onClick={() => comment.paragraphId && controller.select({ anchor: { block: paragraphKey(comment.paragraphId), offset: comment.from }, head: { block: paragraphKey(comment.paragraphId), offset: comment.to } })}>„{comment.excerpt}“</button>
                <p data-i18n-ignore>{comment.text}</p>
                <div className="wm-note-actions">
                  <small data-i18n-ignore>{comment.author}</small>
                  <button type="button" className="wm-icon" title={comment.resolved ? L('Wieder öffnen', 'Reopen') : L('Erledigt', 'Resolve')} onClick={() => controller.apply(commands.resolveComment(controller.state, comment.sceneId, comment.id), 'format')}><Check size={13} /></button>
                  <button type="button" className="wm-icon" title={L('Löschen', 'Delete')} onClick={() => controller.apply(commands.resolveComment(controller.state, comment.sceneId, comment.id, true), 'format')}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </section>
          <section>
            <h4>{L('Fussnoten', 'Footnotes')} ({notes.footnotes.length})</h4>
            {!notes.footnotes.length && <p className="wm-hint">{L('Strg+Alt+F fügt an der Schreibmarke eine Fussnote ein.', 'Ctrl+Alt+F inserts a footnote at the cursor.')}</p>}
            {[...notes.footnotes].sort((a, b) => Number(footnoteNumbers.get(a.id) ?? 1e9) - Number(footnoteNumbers.get(b.id) ?? 1e9)).map((note) => (
              <label key={note.id} className="wm-field wide">
                <span>{footnoteNumbers.get(note.id) ?? '–'}</span>
                <textarea rows={2} defaultValue={note.text} data-i18n-ignore onBlur={(event) => {
                  if (event.target.value !== note.text) controller.apply(commands.setFootnoteText(controller.state, note.sceneId, note.id, event.target.value ? [{ text: event.target.value }] : []), 'format')
                }} />
              </label>
            ))}
          </section>
        </div>
      )}
    </aside>
  )
})
