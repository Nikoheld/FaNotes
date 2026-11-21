import { WifiOff } from 'lucide-react'
import { liveInitials } from '../lib/collab/liveAwareness'
import type { LivePerson } from '../lib/collab/liveNotes'
import type { LiveStatus } from '../lib/collab/liveChannel'

/** Who else is in the open shared note, as coloured initials in the toolbar. They fade away when the person leaves. */
export function LivePeople({ people, status }: { people: readonly LivePerson[]; status: LiveStatus | 'plain' }) {
  if (status === 'plain') return null
  const offline = status === 'offline'
  return (
    <div className="live-people" role="group" aria-label="Live in dieser Notiz">
      {offline && (
        <span className="live-offline" title="Offline – deine Änderungen werden gesendet, sobald die Verbindung wieder steht." aria-label="Offline – deine Änderungen werden gesendet, sobald die Verbindung wieder steht.">
          <WifiOff size={13} />
        </span>
      )}
      {people.map((person) => (
        <span
          key={person.id}
          className={`live-avatar ${person.pen ? 'writing' : ''}`}
          style={{ backgroundColor: person.color }}
          title={person.pen ? `${person.name} schreibt gerade` : `${person.name} ist gerade in dieser Notiz`}
        >
          {liveInitials(person.name)}
        </span>
      ))}
      {!people.length && !offline && <span className="live-solo" title="Änderungen erscheinen bei allen sofort, sobald jemand dazukommt.">Live</span>}
    </div>
  )
}
