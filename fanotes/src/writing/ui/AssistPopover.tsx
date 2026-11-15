import { BookPlus, EyeOff, LoaderCircle, Replace, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Issue } from '../assist/rules'
import { loadThesaurus, synonyms, type SynonymGroup } from '../assist/thesaurus'
import { L, uiEnglish } from './i18n'

export type PopoverTarget = {
  block: string
  /** Where it opens, in the scroll area's coordinates. */
  left: number
  top: number
  issue: Issue | null
  word: { from: number; to: number; text: string } | null
  /** Off for a misspelled word: the thesaurus has nothing for it. */
  synonyms: boolean
  language: 'de' | 'en'
}

const keepCase = (template: string, word: string) => (/^\p{Lu}/u.test(template) ? word[0].toLocaleUpperCase() + word.slice(1) : word)

export function AssistPopover({ target, onReplace, onIgnore, onAddWord, onDisableRule, onClose }: {
  target: PopoverTarget
  onReplace: (from: number, to: number, text: string) => void
  onIgnore: (issue: Issue) => void
  onAddWord: (word: string) => void
  onDisableRule: (rule: string) => void
  onClose: () => void
}) {
  const [groups, setGroups] = useState<SynonymGroup[] | null>(null)
  const [thesaurusError, setThesaurusError] = useState(false)
  const word = target.word
  useEffect(() => {
    if (!word || !target.synonyms || word.text.length < 2) { setGroups([]); return }
    let alive = true
    setGroups(null)
    loadThesaurus(target.language).then((data) => { if (alive) setGroups(synonyms(data, word.text, target.language)) }).catch(() => { if (alive) { setThesaurusError(true); setGroups([]) } })
    return () => { alive = false }
  }, [word, target.synonyms, target.language])
  const issue = target.issue
  return (
    <div className="wm-assist" role="dialog" aria-label={L('Vorschläge', 'Suggestions')} style={{ left: target.left, top: target.top }} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" className="wm-assist-close" aria-label={L('Schliessen', 'Close')} onClick={onClose}><X size={13} /></button>
      {issue && (
        <section>
          <p className={`wm-assist-message is-${issue.category}`}>{uiEnglish() ? issue.message.en : issue.message.de}</p>
          {issue.replacements.length > 0 && (
            <div className="wm-assist-replacements">
              {issue.replacements.map((replacement, index) => (
                <button key={replacement} type="button" className={index === 0 ? 'primary-button' : 'secondary-button'} data-i18n-ignore onClick={() => onReplace(issue.from, issue.to, replacement)}>
                  {replacement === '' ? L('entfernen', 'remove') : replacement.trim() === '' ? `␣${replacement.length > 1 ? '…' : ''}` : replacement}
                </button>
              ))}
            </div>
          )}
          <div className="wm-assist-actions">
            {issue.category === 'spelling' && word && <button type="button" onClick={() => onAddWord(word.text)}><BookPlus size={13} /> {L('Ins Wörterbuch der Geschichte', 'Add to story dictionary')}</button>}
            <button type="button" onClick={() => onIgnore(issue)}><EyeOff size={13} /> {L('Ignorieren', 'Ignore')}</button>
            {issue.category !== 'spelling' && <button type="button" onClick={() => onDisableRule(issue.rule)}>{L('Diese Regel ausschalten', 'Turn this rule off')}</button>}
          </div>
        </section>
      )}
      {word && target.synonyms && (
        <section>
          <h5><Replace size={12} /> {L('Synonyme für', 'Synonyms for')} <span data-i18n-ignore>„{word.text}“</span></h5>
          {groups === null && <p className="wm-assist-hint"><LoaderCircle className="spin" size={12} /> {L('Thesaurus wird geladen …', 'Loading thesaurus …')}</p>}
          {groups?.length === 0 && <p className="wm-assist-hint">{thesaurusError ? L('Thesaurus nicht verfügbar.', 'Thesaurus not available.') : L('Keine Synonyme gefunden.', 'No synonyms found.')}</p>}
          {groups?.map((group, index) => (
            <div key={index} className="wm-assist-group">
              {group.label && <small>{uiEnglish() ? group.label.en : group.label.de}</small>}
              <div data-i18n-ignore>
                {group.words.map((synonym) => (
                  <button key={synonym} type="button" onClick={() => onReplace(word.from, word.to, keepCase(word.text, synonym))}>{synonym}</button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
