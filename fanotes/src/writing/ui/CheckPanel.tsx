import { EyeOff, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import type { Assistant, AssistSettings } from '../assist/checker'
import { issueSignature } from '../assist/checker'
import type { Issue } from '../assist/rules'
import { readability } from '../assist/style'
import * as commands from '../editor/commands'
import type { WritingController } from '../editor/controller'
import { makeDoc } from '../editor/doc'
import { runsText } from '../model/runs'
import type { StoryLanguage } from '../model/types'
import { L, formatNumber, uiEnglish } from './i18n'

export type AutocorrectSettings = { enabled: boolean; quotes: boolean; dashes: boolean; ellipsis: boolean; capitalize: boolean; spelling: boolean; swissSs: boolean }
export const defaultAutocorrectSettings = (): AutocorrectSettings => ({ enabled: true, quotes: true, dashes: true, ellipsis: true, capitalize: true, spelling: true, swissSs: true })

const Toggle = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) => (
  <label className="wm-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /> <span>{label}</span></label>
)

const CATEGORY_LABEL: Record<Issue['category'], [string, string]> = {
  spelling: ['Rechtschreibung', 'Spelling'],
  grammar: ['Grammatik', 'Grammar'],
  punctuation: ['Zeichensetzung', 'Punctuation'],
  typography: ['Typografie', 'Typography'],
  style: ['Stil', 'Style'],
}

export function CheckPanel({ controller, assistant, settings, onSettings, autocorrect, onAutocorrect, sceneId, onJump }: {
  controller: WritingController
  assistant: Assistant
  settings: AssistSettings
  onSettings: (next: AssistSettings) => void
  autocorrect: AutocorrectSettings
  onAutocorrect: (next: AutocorrectSettings) => void
  sceneId: string | null
  onJump: (block: string, from: number, to: number) => void
}) {
  const doc = controller.state.doc
  const manifest = doc.manifest
  const blocks = useMemo(() => doc.flow.filter((block) => block.ref.kind === 'para' && block.sceneId === sceneId), [doc.flow, sceneId])
  const found = useMemo(() => blocks.flatMap((block) => {
    const result = assistant.check(block.runs, block.lang, manifest.language)
    return result.issues.map((issue) => ({ block, issue, text: runsText(block.runs) }))
    // The assistant's settings and lists are part of its cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [blocks, assistant, manifest.language, settings, manifest.dictionary, manifest.ignored])
  const sceneText = useMemo(() => blocks.map((block) => runsText(block.runs)).join('\n'), [blocks])
  const score = useMemo(() => (sceneText.trim() ? readability(sceneText, manifest.language) : null), [sceneText, manifest.language])
  const head = doc.flow[doc.index.get(controller.state.selection.head.block) ?? -1]
  const setManifest = (patch: Partial<typeof manifest>) => controller.replaceDoc(makeDoc({ ...manifest, ...patch }, controller.state.doc.scenes))
  const style = settings.style

  const apply = (entry: (typeof found)[number], replacement: string) => {
    controller.apply(commands.replaceInBlockRange(controller.state, entry.block.key, entry.issue.from, entry.issue.to, replacement, 'keep'), 'format')
  }
  const ignore = (entry: (typeof found)[number]) => setManifest({ ignored: [...new Set([...(manifest.ignored ?? []), issueSignature(entry.issue, entry.text)])] })

  return (
    <div className="wm-inspector-body">
      <section>
        <h4>{L('Prüfen', 'Checks')}</h4>
        <div className="wm-toggles">
          <Toggle label={L('Rechtschreibung', 'Spelling')} checked={settings.spelling} onChange={(spelling) => onSettings({ ...settings, spelling })} />
          <Toggle label={L('Grammatik', 'Grammar')} checked={settings.grammar} onChange={(grammar) => onSettings({ ...settings, grammar })} />
          <Toggle label={L('Zeichensetzung', 'Punctuation')} checked={settings.punctuation} onChange={(punctuation) => onSettings({ ...settings, punctuation })} />
          <Toggle label={L('Typografie (Anführungszeichen, Striche, Leerzeichen)', 'Typography (quotes, dashes, spaces)')} checked={settings.typography} onChange={(typography) => onSettings({ ...settings, typography })} />
          <Toggle label={L('Sprache je Absatz erkennen', 'Detect the language per paragraph')} checked={settings.detectLanguage} onChange={(detectLanguage) => onSettings({ ...settings, detectLanguage })} />
        </div>
        <h4>{L('Stilhinweise', 'Style hints')}</h4>
        <div className="wm-toggles">
          <Toggle label={L('Füllwörter', 'Filler words')} checked={style.fillers} onChange={(fillers) => onSettings({ ...settings, style: { ...style, fillers } })} />
          <Toggle label={L('Wortwiederholungen', 'Repeated words')} checked={style.repetition} onChange={(repetition) => onSettings({ ...settings, style: { ...style, repetition } })} />
          <Toggle label={L(`Lange Sätze (über ${style.longSentenceWords} Wörter)`, `Long sentences (over ${style.longSentenceWords} words)`)} checked={style.longSentences} onChange={(longSentences) => onSettings({ ...settings, style: { ...style, longSentences } })} />
          <Toggle label={L('Passiv (Englisch)', 'Passive voice (English)')} checked={style.passive} onChange={(passive) => onSettings({ ...settings, style: { ...style, passive } })} />
        </div>
        {settings.disabledRules.length > 0 && <button type="button" className="secondary-button wm-small" onClick={() => onSettings({ ...settings, disabledRules: [] })}>{L(`${settings.disabledRules.length} ausgeschaltete Regel(n) wieder einschalten`, `Turn ${settings.disabledRules.length} disabled rule(s) back on`)}</button>}
      </section>
      <section>
        <h4>{L('Autokorrektur beim Tippen', 'Autocorrect while typing')}</h4>
        <div className="wm-toggles">
          <Toggle label={L('Eingeschaltet', 'On')} checked={autocorrect.enabled} onChange={(enabled) => onAutocorrect({ ...autocorrect, enabled })} />
          <Toggle label={L('Typografische Anführungszeichen und Apostrophe', 'Typographic quotes and apostrophes')} checked={autocorrect.quotes} onChange={(quotes) => onAutocorrect({ ...autocorrect, quotes })} />
          <Toggle label={L('Gedankenstriche aus „ - “ und „--“', 'Dashes from “ - ” and “--”')} checked={autocorrect.dashes} onChange={(dashes) => onAutocorrect({ ...autocorrect, dashes })} />
          <Toggle label={L('Auslassungszeichen aus „...“', 'Ellipsis from “...”')} checked={autocorrect.ellipsis} onChange={(ellipsis) => onAutocorrect({ ...autocorrect, ellipsis })} />
          <Toggle label={L('Satzanfänge gross, „DIe“ → „Die“', 'Capitalise sentences, “THe” → “The”')} checked={autocorrect.capitalize} onChange={(capitalize) => onAutocorrect({ ...autocorrect, capitalize })} />
          <Toggle label={L('Eindeutige Tippfehler korrigieren', 'Fix unambiguous typos')} checked={autocorrect.spelling} onChange={(spelling) => onAutocorrect({ ...autocorrect, spelling })} />
          <Toggle label={L('Schweizer Rechtschreibung: ß → ss (bei Deutsch (Schweiz))', 'Swiss spelling: ß → ss (for German (Switzerland))')} checked={autocorrect.swissSs} onChange={(swissSs) => onAutocorrect({ ...autocorrect, swissSs })} />
        </div>
        <p className="wm-hint">{L('Strg+Z oder sofort Rücktaste macht eine Korrektur rückgängig.', 'Ctrl+Z, or Backspace right away, undoes a correction.')}</p>
      </section>
      <section>
        <h4>{L('Sprache dieses Absatzes', 'Language of this paragraph')}</h4>
        <select className="wm-select" value={head?.lang ?? ''} onChange={(event) => controller.apply(commands.setParagraphLanguage(controller.state, (event.target.value || null) as StoryLanguage | null), 'format')}>
          <option value="">{L('Wie die Geschichte', 'As the story')}</option>
          <option value="de">Deutsch</option>
          <option value="de-CH">Deutsch (Schweiz)</option>
          <option value="en-US">English (US)</option>
          <option value="en-GB">English (UK)</option>
        </select>
      </section>
      <section>
        <h4>{L('In dieser Szene', 'In this scene')} ({found.length})</h4>
        {score && <p className="wm-hint">{L(`Lesbarkeit ${score.score} (${score.label.de}) · ${score.wordsPerSentence.toFixed(1)} Wörter je Satz`, `Readability ${score.score} (${score.label.en}) · ${score.wordsPerSentence.toFixed(1)} words per sentence`)}</p>}
        {!found.length && <p className="wm-hint">{L('Nichts gefunden.', 'Nothing found.')}</p>}
        {found.slice(0, 200).map((entry, index) => (
          <div key={`${entry.block.key}:${entry.issue.from}:${entry.issue.rule}:${index}`} className={`wm-finding is-${entry.issue.category}`}>
            <button type="button" className="wm-finding-text" onClick={() => onJump(entry.block.key, entry.issue.from, entry.issue.to)} data-i18n-ignore>
              <small>{L(...CATEGORY_LABEL[entry.issue.category])}</small>
              <span>…{entry.text.slice(Math.max(0, entry.issue.from - 24), entry.issue.from)}<mark>{entry.text.slice(entry.issue.from, entry.issue.to) || '␣'}</mark>{entry.text.slice(entry.issue.to, entry.issue.to + 24)}…</span>
            </button>
            <p>{uiEnglish() ? entry.issue.message.en : entry.issue.message.de}</p>
            <div className="wm-note-actions">
              {entry.issue.replacements.slice(0, 3).map((replacement) => <button key={replacement} type="button" className="secondary-button wm-small" data-i18n-ignore onClick={() => apply(entry, replacement)}>{replacement || L('entfernen', 'remove')}</button>)}
              <button type="button" className="wm-icon" title={L('Ignorieren', 'Ignore')} onClick={() => ignore(entry)}><EyeOff size={13} /></button>
            </div>
          </div>
        ))}
      </section>
      <section>
        <h4>{L('Wörterbuch der Geschichte', 'Story dictionary')} ({formatNumber(manifest.dictionary?.length ?? 0)})</h4>
        <p className="wm-hint">{L('Namen und erfundene Wörter, die hier richtig sind. Wird mit der Geschichte synchronisiert.', 'Names and invented words that are right here. Synced with the story.')}</p>
        <div className="wm-dictionary" data-i18n-ignore>
          {(manifest.dictionary ?? []).map((word) => (
            <span key={word}>{word}<button type="button" aria-label={L(`${word} entfernen`, `Remove ${word}`)} onClick={() => setManifest({ dictionary: (manifest.dictionary ?? []).filter((candidate) => candidate !== word) })}><Trash2 size={11} /></button></span>
          ))}
        </div>
        {(manifest.ignored?.length ?? 0) > 0 && <button type="button" className="secondary-button wm-small" onClick={() => setManifest({ ignored: [] })}>{L(`${manifest.ignored!.length} ignorierte Hinweise wieder zeigen`, `Show ${manifest.ignored!.length} ignored findings again`)}</button>}
      </section>
    </div>
  )
}
