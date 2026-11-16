import { memo } from 'react'
import { L, formatNumber } from './i18n'

type Props = {
  pageNumber: string
  pageCount: number
  words: number
  selectedWords: number | null
  chars: number
  charsNoSpaces: number
  minutes: number
  dailyGoal: number | null
  todayWords: number
  styleLabel: string
  saveState: 'saved' | 'saving' | 'error'
  saveError: string | null
  onOpenGoals: () => void
}

/** The status line. Memoized on primitives, so it only re-renders when a shown value changes. */
export const StatusBar = memo(function StatusBar({ pageNumber, pageCount, words, selectedWords, chars, charsNoSpaces, minutes, dailyGoal, todayWords, styleLabel, saveState, saveError, onOpenGoals }: Props) {
  return (
    <footer className="wm-status" data-i18n-ignore>
      <span>{L('Seite', 'Page')} {pageNumber} / {pageCount}</span>
      <span>{formatNumber(words)} {L('Wörter', 'words')}{selectedWords !== null ? ` (${formatNumber(selectedWords)} ${L('markiert', 'selected')})` : ''}</span>
      <span title={L(`${formatNumber(chars)} Zeichen mit Leerzeichen`, `${formatNumber(chars)} characters with spaces`)}>{formatNumber(charsNoSpaces)} {L('Zeichen', 'characters')}</span>
      <span>{L(`${minutes} Min. Lesezeit`, `${minutes} min read`)}</span>
      {dailyGoal ? <button type="button" className="wm-status-goal" onClick={onOpenGoals}>{L('Heute', 'Today')} {formatNumber(todayWords)} / {formatNumber(dailyGoal)}</button> : null}
      <span className="wm-grow" />
      <span>{styleLabel}</span>
      <span className={`wm-save is-${saveState}`}>{saveState === 'saved' ? L('Gespeichert', 'Saved') : saveState === 'saving' ? L('Speichert …', 'Saving …') : L('Nicht gespeichert', 'Not saved')}{saveState === 'error' && saveError ? `: ${saveError}` : ''}</span>
    </footer>
  )
})
