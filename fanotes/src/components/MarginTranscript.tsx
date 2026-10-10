import { useState } from 'react'
import { marginLinesFromTranscript } from '../lib/marginTranscript'

export function MarginTranscript({
  transcript,
  onCorrect,
}: {
  transcript: string
  onCorrect: (from: string, to: string) => void
}) {
  const lines = marginLinesFromTranscript(transcript)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  if (!lines.length) return null
  return (
    <aside className="lw-margin-transcript" aria-label="Randtranskript">
      <strong>Randtranskript</strong>
      <ol>
        {lines.map((line, index) => (
          <li key={`${index}-${line.text.slice(0, 24)}`}>
            {line.text.split(/(\s+)/u).map((part, partIndex) => {
              if (!part.trim()) return <span key={partIndex}>{part}</span>
              const key = `${index}:${part}`
              if (editing === key) {
                return (
                  <input
                    key={partIndex}
                    value={draft}
                    aria-label="Wort korrigieren"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        onCorrect(part, draft)
                        setEditing(null)
                      }
                      if (event.key === 'Escape') setEditing(null)
                    }}
                    onBlur={() => setEditing(null)}
                  />
                )
              }
              return (
                <button
                  key={partIndex}
                  type="button"
                  onClick={() => { setEditing(key); setDraft(part) }}
                >
                  {part}
                </button>
              )
            })}
          </li>
        ))}
      </ol>
    </aside>
  )
}
