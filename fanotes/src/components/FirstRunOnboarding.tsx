import {
  ArrowRight,
  BookOpen,
  Briefcase,
  Check,
  FolderOpen,
  GraduationCap,
  House,
  Inbox,
  LoaderCircle,
  PenLine,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getUiLanguage } from '../i18n'
import type { StarterSubject } from '../types'

type FirstRunOnboardingProps = {
  subjects: StarterSubject[]
  onComplete: (subjects: string[], profile: ProfileId) => Promise<void>
}

type ProfileId = 'school' | 'university' | 'private' | 'work'

type StarterProfile = {
  id: ProfileId
  title: string
  description: string
  folders: StarterSubject[]
  icon: React.ReactNode
}

const UNIVERSITY_FOLDERS = [
  { name: 'Vorlesungen', color: '#2a6f97' },
  { name: 'Seminare', color: '#9065b0' },
  { name: 'Forschung', color: '#0f7b6c' },
  { name: 'Prüfungen', color: '#c4554d' },
  { name: 'Literatur', color: '#ba9b4a' },
]
const UNIVERSITY_FOLDERS_EN = [
  { name: 'Lectures', color: '#2a6f97' },
  { name: 'Seminars', color: '#9065b0' },
  { name: 'Research', color: '#0f7b6c' },
  { name: 'Exams', color: '#c4554d' },
  { name: 'Reading', color: '#ba9b4a' },
]
const PRIVATE_FOLDERS = [
  { name: 'Persönlich', color: '#c4554d' },
  { name: 'Ideen', color: '#9065b0' },
  { name: 'Projekte', color: '#337ea9' },
  { name: 'Tagebuch', color: '#448361' },
  { name: 'Dokumente', color: '#ba9b4a' },
]
const PRIVATE_FOLDERS_EN = [
  { name: 'Personal', color: '#c4554d' },
  { name: 'Ideas', color: '#9065b0' },
  { name: 'Projects', color: '#337ea9' },
  { name: 'Journal', color: '#448361' },
  { name: 'Documents', color: '#ba9b4a' },
]
const WORK_FOLDERS = [
  { name: 'Projekte', color: '#337ea9' },
  { name: 'Meetings', color: '#9065b0' },
  { name: 'Aufgaben', color: '#c4554d' },
  { name: 'Wissen', color: '#0f7b6c' },
  { name: 'Archiv', color: '#ba9b4a' },
]
const WORK_FOLDERS_EN = [
  { name: 'Projects', color: '#337ea9' },
  { name: 'Meetings', color: '#9065b0' },
  { name: 'Tasks', color: '#c4554d' },
  { name: 'Knowledge', color: '#0f7b6c' },
  { name: 'Archive', color: '#ba9b4a' },
]

const SUBJECT_DETAILS: Record<string, { mark: string; description: string }> = {
  Mathematik: { mark: '∑', description: 'Algebra, Geometrie & Analysis' },
  AMAT: { mark: 'f(x)', description: 'Anwendungen der Mathematik' },
  Deutsch: { mark: 'Aa', description: 'Sprache, Literatur & Aufsätze' },
  Englisch: { mark: 'Ab', description: 'Vocabulary, texts & grammar' },
  Französisch: { mark: 'Fr', description: 'Grammatik, Texte & Vokabeln' },
  Physik: { mark: 'λ', description: 'Mechanik, Elektrizität & Wellen' },
  Chemie: { mark: 'H₂', description: 'Stoffe, Reaktionen & Formeln' },
  Biologie: { mark: 'DNA', description: 'Leben, Umwelt & Genetik' },
  Geschichte: { mark: 'Ⅰ', description: 'Epochen, Quellen & Zusammenhänge' },
  Informatik: { mark: '</>', description: 'Code, Systeme & Algorithmen' },
  Wirtschaft: { mark: '%', description: 'Betriebe, Märkte & Finanzen' },
  Mathematics: { mark: '∑', description: 'Algebra, geometry & analysis' },
  German: { mark: 'Aa', description: 'Language, literature & essays' },
  English: { mark: 'Ab', description: 'Vocabulary, texts & grammar' },
  French: { mark: 'Fr', description: 'Grammar, texts & vocabulary' },
  Physics: { mark: 'λ', description: 'Mechanics, electricity & waves' },
  Chemistry: { mark: 'H₂', description: 'Materials, reactions & formulas' },
  Biology: { mark: 'DNA', description: 'Life, environment & genetics' },
  History: { mark: 'Ⅰ', description: 'Periods, sources & connections' },
  'Computer Science': { mark: '</>', description: 'Code, systems & algorithms' },
  Economics: { mark: '%', description: 'Business, markets & finance' },
}

export function FirstRunOnboarding({ subjects, onComplete }: FirstRunOnboardingProps) {
  const english = getUiLanguage() === 'en'
  const profiles = useMemo<StarterProfile[]>(() => [
    { id: 'school', title: 'Schule', description: 'Fächer, Aufgaben und Prüfungen klar organisieren.', folders: subjects, icon: <BookOpen size={20} /> },
    { id: 'university', title: 'UNI', description: 'Vorlesungen, Forschung und Literatur zusammenhalten.', folders: english ? UNIVERSITY_FOLDERS_EN : UNIVERSITY_FOLDERS, icon: <GraduationCap size={20} /> },
    { id: 'private', title: 'Privat', description: 'Ideen, Tagebuch, Projekte und wichtige Dokumente.', folders: english ? PRIVATE_FOLDERS_EN : PRIVATE_FOLDERS, icon: <House size={20} /> },
    { id: 'work', title: 'Arbeit', description: 'Meetings, Aufgaben und Wissen an einem ruhigen Ort.', folders: english ? WORK_FOLDERS_EN : WORK_FOLDERS, icon: <Briefcase size={20} /> },
  ], [english, subjects])
  const [profileId, setProfileId] = useState<ProfileId>('school')
  const profile = profiles.find((candidate) => candidate.id === profileId) ?? profiles[0]
  const folders = profile.folders
  const allNames = useMemo(() => folders.map(({ name }) => name), [folders])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allNames))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const allSelected = folders.length > 0 && selected.size === folders.length

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [])

  const toggle = (name: string) => {
    if (busy) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const chooseProfile = (nextProfile: StarterProfile) => {
    if (busy) return
    setProfileId(nextProfile.id)
    setSelected(new Set(nextProfile.folders.map(({ name }) => name)))
    setError(null)
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onComplete(allNames.filter((name) => selected.has(name)), profileId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Die Fächer konnten nicht eingerichtet werden.')
      setBusy(false)
    }
  }

  return (
    <main className="first-run first-run-setup" aria-labelledby="first-run-title" aria-busy={busy}>
      <header className="first-run-brand">
        <span className="first-run-logo" aria-hidden="true"><Sparkles size={18} /></span>
        <div><strong>FaNotes</strong><small>Dein persönlicher Denkraum</small></div>
        <span className="first-run-local"><ShieldCheck size={15} /> Bleibt lokal</span>
      </header>

      <div className="first-run-setup-head">
        <span className="first-run-step"><Sparkles size={13} /> Erste Einrichtung</span>
        <h1 id="first-run-title" ref={titleRef} tabIndex={-1}>Ein Start. Alles auf einen Blick.</h1>
        <p>Wähle, wofür du FaNotes nutzt, und schalte die Startordner an oder aus.</p>
        <div className="first-run-benefits">
          <span><ShieldCheck size={15} /> Lokal & privat</span>
          <span><PenLine size={15} /> Stift & Tastatur</span>
        </div>
      </div>

      <div className="first-run-setup-grid">
        <section className="first-run-profiles" aria-label="Einsatzprofil auswählen">
          {profiles.map((candidate, index) => (
            <button
              type="button"
              key={candidate.id}
              className={candidate.id === profileId ? 'is-selected' : ''}
              aria-pressed={candidate.id === profileId}
              disabled={busy}
              onClick={() => chooseProfile(candidate)}
              style={{ '--profile-index': index } as React.CSSProperties}
            >
              <span>{candidate.icon}</span>
              <div><strong>{candidate.title}</strong><small>{candidate.description}</small></div>
              <i>{candidate.id === profileId && <Check size={14} strokeWidth={3} />}</i>
            </button>
          ))}
        </section>

        <section className="first-run-picker" aria-label="Ordner auswählen">
          <div className="first-run-picker-head">
            <div>
              <strong>{profile.title}</strong>
              <span>{`${selected.size} von ${folders.length} ausgewählt`}</span>
            </div>
            <button
              type="button"
              disabled={busy || folders.length === 0}
              onClick={() => setSelected(allSelected ? new Set() : new Set(allNames))}
            >
              {allSelected ? 'Auswahl aufheben' : 'Alle auswählen'}
            </button>
          </div>

          <div className="first-run-inbox">
            <span><Inbox size={20} /></span>
            <div><strong>Eingang ist immer dabei</strong><small>Der schnelle Sammelplatz für neue Notizen und Ideen.</small></div>
            <Check size={16} aria-label="Ausgewählt" />
          </div>

          <div className="first-run-subjects">
            {folders.map((subject, index) => {
              const active = selected.has(subject.name)
              const details = SUBJECT_DETAILS[subject.name] ?? { mark: subject.name.slice(0, 2), description: 'Organisierter Startordner' }
              return (
                <button
                  className={active ? 'is-selected' : ''}
                  type="button"
                  key={subject.name}
                  aria-pressed={active}
                  disabled={busy}
                  onClick={() => toggle(subject.name)}
                  style={{
                    '--subject-color': subject.color,
                    '--subject-index': index,
                    '--subject-delay': `${Math.floor(index / 2) * 42 + (index % 2) * 16}ms`,
                  } as React.CSSProperties}
                >
                  <span className="first-run-subject-mark" aria-hidden="true">{details.mark}</span>
                  <span className="first-run-subject-copy"><strong>{subject.name}</strong><small>{details.description}</small></span>
                  <span className="first-run-check" aria-hidden="true">{active && <Check size={14} strokeWidth={3} />}</span>
                </button>
              )
            })}
          </div>

          <p className="first-run-note"><FolderOpen size={16} /><span><strong>Sauber vorbereitet</strong> – jeder Ordner erhält eine eigene Farbe und erscheint direkt in der Seitenleiste.</span></p>
          {error && <p className="first-run-error" role="alert">{error}</p>}
          <footer className="first-run-actions">
            <p>{selected.size ? `${selected.size} ${selected.size === 1 ? 'Ordner' : 'Ordner'} + Eingang` : 'Nur Eingang'} wird angelegt.</p>
            <button className="primary-button first-run-continue" type="button" disabled={busy} onClick={() => void submit()}>
              {busy ? <><LoaderCircle className="spin" size={17} /> Wird vorbereitet …</> : <>FaNotes einrichten <ArrowRight size={17} /></>}
            </button>
          </footer>
        </section>
      </div>
    </main>
  )
}
