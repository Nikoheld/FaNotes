import {
  ArrowLeft,
  ArrowRight,
  Briefcase,
  BookOpen,
  Check,
  FileText,
  FolderOpen,
  GraduationCap,
  House,
  Inbox,
  Keyboard,
  LoaderCircle,
  PenLine,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getUiLanguage } from '../i18n'
import type { StarterSubject } from '../types'

type FirstRunOnboardingProps = {
  subjects: StarterSubject[]
  onComplete: (subjects: string[]) => Promise<void>
}

type OnboardingStep = 0 | 1 | 2 | 3
type ProfileId = 'school' | 'university' | 'private' | 'work'

type StarterProfile = {
  id: ProfileId
  title: string
  description: string
  folders: StarterSubject[]
  icon: React.ReactNode
}

const STEPS = [
  { id: 'welcome', label: 'Willkommen' },
  { id: 'profile', label: 'Profil' },
  { id: 'writing', label: 'Deine Seite' },
  { id: 'folders', label: 'Deine Ordner' },
] as const

const UNIVERSITY_FOLDERS = [
  { name: 'Vorlesungen', color: '#6f8cff' },
  { name: 'Seminare', color: '#9a7cff' },
  { name: 'Forschung', color: '#45c9b7' },
  { name: 'Prüfungen', color: '#ef7aa8' },
  { name: 'Literatur', color: '#d4b54c' },
]
const UNIVERSITY_FOLDERS_EN = [
  { name: 'Lectures', color: '#6f8cff' },
  { name: 'Seminars', color: '#9a7cff' },
  { name: 'Research', color: '#45c9b7' },
  { name: 'Exams', color: '#ef7aa8' },
  { name: 'Reading', color: '#d4b54c' },
]
const PRIVATE_FOLDERS = [
  { name: 'Persönlich', color: '#ef7aa8' },
  { name: 'Ideen', color: '#9a7cff' },
  { name: 'Projekte', color: '#4f9df8' },
  { name: 'Tagebuch', color: '#55cfa8' },
  { name: 'Dokumente', color: '#d4b54c' },
]
const PRIVATE_FOLDERS_EN = [
  { name: 'Personal', color: '#ef7aa8' },
  { name: 'Ideas', color: '#9a7cff' },
  { name: 'Projects', color: '#4f9df8' },
  { name: 'Journal', color: '#55cfa8' },
  { name: 'Documents', color: '#d4b54c' },
]
const WORK_FOLDERS = [
  { name: 'Projekte', color: '#4f9df8' },
  { name: 'Meetings', color: '#9a7cff' },
  { name: 'Aufgaben', color: '#ef7aa8' },
  { name: 'Wissen', color: '#45c9b7' },
  { name: 'Archiv', color: '#d4b54c' },
]
const WORK_FOLDERS_EN = [
  { name: 'Projects', color: '#4f9df8' },
  { name: 'Meetings', color: '#9a7cff' },
  { name: 'Tasks', color: '#ef7aa8' },
  { name: 'Knowledge', color: '#45c9b7' },
  { name: 'Archive', color: '#d4b54c' },
]

const SUBJECT_DETAILS: Record<string, { mark: string; description: string }> = {
  Mathematik: { mark: '∑', description: 'Algebra, Geometrie & Analysis' },
  AMAT: { mark: 'f(x)', description: 'Anwendungen der Mathematik' },
  Deutsch: { mark: 'Aa', description: 'Sprache, Literatur & Aufsätze' },
  Englisch: { mark: 'Ab', description: 'Vocabulary, texts & grammar' },
  Physik: { mark: 'λ', description: 'Mechanik, Elektrizität & Wellen' },
  Chemie: { mark: 'H₂', description: 'Stoffe, Reaktionen & Formeln' },
  Biologie: { mark: 'DNA', description: 'Leben, Umwelt & Genetik' },
  Geschichte: { mark: 'Ⅰ', description: 'Epochen, Quellen & Zusammenhänge' },
  Informatik: { mark: '</>', description: 'Code, Systeme & Algorithmen' },
  Wirtschaft: { mark: '%', description: 'Betriebe, Märkte & Finanzen' },
  Mathematics: { mark: '∑', description: 'Algebra, geometry & analysis' },
  German: { mark: 'Aa', description: 'Language, literature & essays' },
  English: { mark: 'Ab', description: 'Vocabulary, texts & grammar' },
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
    { id: 'school', title: 'Schule', description: 'Fächer, Aufgaben und Prüfungen klar organisieren.', folders: subjects, icon: <BookOpen size={23} /> },
    { id: 'university', title: 'UNI', description: 'Vorlesungen, Forschung und Literatur zusammenhalten.', folders: english ? UNIVERSITY_FOLDERS_EN : UNIVERSITY_FOLDERS, icon: <GraduationCap size={23} /> },
    { id: 'private', title: 'Privat', description: 'Ideen, Tagebuch, Projekte und wichtige Dokumente.', folders: english ? PRIVATE_FOLDERS_EN : PRIVATE_FOLDERS, icon: <House size={23} /> },
    { id: 'work', title: 'Arbeit', description: 'Meetings, Aufgaben und Wissen an einem ruhigen Ort.', folders: english ? WORK_FOLDERS_EN : WORK_FOLDERS, icon: <Briefcase size={23} /> },
  ], [english, subjects])
  const [profileId, setProfileId] = useState<ProfileId>('school')
  const profile = profiles.find((candidate) => candidate.id === profileId) ?? profiles[0]
  const folders = profile.folders
  const allNames = useMemo(() => folders.map(({ name }) => name), [folders])
  const [step, setStep] = useState<OnboardingStep>(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allNames))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const allSelected = selected.size === folders.length

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true })
  }, [step])

  const goToStep = (nextStep: OnboardingStep) => {
    if (busy || nextStep === step) return
    setDirection(nextStep > step ? 'forward' : 'back')
    setStep(nextStep)
  }

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
  }

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onComplete(allNames.filter((name) => selected.has(name)))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Die Fächer konnten nicht eingerichtet werden.')
      setBusy(false)
    }
  }

  return (
    <main className="first-run" data-step={STEPS[step].id} aria-labelledby="first-run-title">
      <header className="first-run-brand">
        <span className="first-run-logo" aria-hidden="true"><Sparkles size={18} /></span>
        <div><strong>FaNotes</strong><small>Dein persönlicher Denkraum</small></div>

        <nav className="first-run-progress" aria-label="Einrichtungsschritte">
          {STEPS.map((entry, index) => (
            <button
              type="button"
              key={entry.label}
              className={`${index === step ? 'is-active' : ''} ${index < step ? 'is-complete' : ''}`}
              aria-current={index === step ? 'step' : undefined}
              aria-label={`Schritt ${index + 1}: ${entry.label}`}
              disabled={busy}
              onClick={() => goToStep(index as OnboardingStep)}
            >
              <span>{index < step ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
              <small>{entry.label}</small>
            </button>
          ))}
        </nav>

        <span className="first-run-local"><ShieldCheck size={15} /> Bleibt lokal</span>
      </header>

      <div key={step} className={`first-run-scene first-run-scene-${direction}`} aria-live="polite">
        {step === 0 && (
          <div className="first-run-welcome">
            <section className="first-run-hero-copy">
              <span className="first-run-step"><Sparkles size={13} /> Willkommen bei FaNotes</span>
              <h1 id="first-run-title" ref={titleRef} tabIndex={-1}>Alles, was dir wichtig ist.<br /><em>An einem ruhigen Ort.</em></h1>
              <p>Schreibe mit Tastatur oder Stift, ordne deine Themen und finde jeden Gedanken wieder – in Schule, UNI, Privatleben oder Arbeit.</p>

              <div className="first-run-benefits" aria-label="Vorteile">
                <span><ShieldCheck size={15} /> Lokal & privat</span>
                <span><PenLine size={15} /> Stift & Tastatur</span>
                <span><FileText size={15} /> Markdown inklusive</span>
              </div>

              <div className="first-run-hero-actions">
                <button className="primary-button first-run-continue" type="button" onClick={() => goToStep(1)}>
                  Los geht’s <ArrowRight size={17} />
                </button>
                <button className="first-run-skip" type="button" onClick={() => goToStep(1)}>Einsatzprofil auswählen</button>
              </div>
            </section>

            <WelcomePreview />
          </div>
        )}

        {step === 1 && (
          <div className="first-run-profile">
            <section className="first-run-profile-copy">
              <span className="first-run-step"><FolderOpen size={13} /> Dein Startprofil</span>
              <h1 id="first-run-title" ref={titleRef} tabIndex={-1}>Wofür möchtest du FaNotes verwenden?</h1>
              <p>Deine Auswahl bestimmt nur die vorgeschlagenen Startordner. Alle Funktionen bleiben in jedem Profil verfügbar und später frei anpassbar.</p>
              <div className="first-run-profile-actions">
                <button className="first-run-back" type="button" onClick={() => goToStep(0)}><ArrowLeft size={16} /> Zurück</button>
                <button className="primary-button first-run-continue" type="button" onClick={() => goToStep(2)}>Weiter <ArrowRight size={17} /></button>
              </div>
            </section>
            <section className="first-run-profiles" aria-label="Einsatzprofil auswählen">
              {profiles.map((candidate, index) => (
                <button
                  type="button"
                  key={candidate.id}
                  className={candidate.id === profileId ? 'is-selected' : ''}
                  aria-pressed={candidate.id === profileId}
                  onClick={() => chooseProfile(candidate)}
                  style={{ '--profile-index': index } as React.CSSProperties}
                >
                  <span>{candidate.icon}</span>
                  <div><strong>{candidate.title}</strong><small>{candidate.description}</small></div>
                  <i>{candidate.id === profileId && <Check size={14} strokeWidth={3} />}</i>
                </button>
              ))}
            </section>
          </div>
        )}

        {step === 2 && (
          <div className="first-run-writing">
            <section className="first-run-writing-copy">
              <span className="first-run-step"><PenLine size={13} /> Deine natürliche Arbeitsweise</span>
              <h1 id="first-run-title" ref={titleRef} tabIndex={-1}>Eine Seite. Zwei Arten zu schreiben.</h1>
              <p>Tippe und schreibe frei auf derselben Seite. Handschrift bleibt Handschrift, bis du sie bewusst umwandelst.</p>

              <div className="first-run-writing-features">
                <article>
                  <span><Keyboard size={17} /></span>
                  <div><strong>Einfach losschreiben</strong><small>Markdown wird direkt schön dargestellt – ohne Ansichtswechsel.</small></div>
                </article>
                <article>
                  <span><PenLine size={17} /></span>
                  <div><strong>Natürlich mit dem Stift</strong><small>Ganze handschriftliche Seiten oder Ergänzungen zwischen Text.</small></div>
                </article>
                <article>
                  <span><Search size={17} /></span>
                  <div><strong>Trotzdem alles finden</strong><small>Unsichtbare Transkription macht auch unkonvertierte Handschrift durchsuchbar.</small></div>
                </article>
              </div>

              <div className="first-run-page-actions">
                <button className="first-run-back" type="button" onClick={() => goToStep(1)}><ArrowLeft size={16} /> Zurück</button>
                <button className="primary-button first-run-continue" type="button" onClick={() => goToStep(3)}>Ordner auswählen <ArrowRight size={17} /></button>
              </div>
            </section>

            <WritingPreview />
          </div>
        )}

        {step === 3 && (
          <div className="first-run-layout">
            <section className="first-run-intro">
              <span className="first-run-step"><FolderOpen size={13} /> Fast geschafft · 4 von 4</span>
              <h1 id="first-run-title" ref={titleRef} tabIndex={-1}>Welche Ordner möchtest du verwenden?</h1>
              <p>FaNotes schlägt passende Ordner für das Profil <strong>{profile.title}</strong> vor. Du kannst später jederzeit weitere Ordner ergänzen, umbenennen oder löschen.</p>

              <div className="first-run-inbox">
                <span><Inbox size={21} /></span>
                <div><strong>Eingang ist immer dabei</strong><small>Der schnelle Sammelplatz für neue Notizen und Ideen.</small></div>
                <Check size={17} aria-label="Ausgewählt" />
              </div>

              <div className="first-run-note"><FolderOpen size={17} /><span><strong>Sauber vorbereitet</strong> – jeder Ordner erhält eine eigene Farbe und erscheint direkt in der Seitenleiste.</span></div>
              <button className="first-run-back first-run-back-inline" type="button" disabled={busy} onClick={() => goToStep(2)}><ArrowLeft size={16} /> Zurück</button>
            </section>

            <section className="first-run-picker" aria-label="Ordner auswählen">
              <div className="first-run-picker-head">
                <div><strong>{profile.title}</strong><span>{selected.size} von {folders.length} ausgewählt</span></div>
                <button type="button" disabled={busy} onClick={() => setSelected(allSelected ? new Set() : new Set(allNames))}>
                  {allSelected ? 'Auswahl aufheben' : 'Alle auswählen'}
                </button>
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
                      style={{ '--subject-color': subject.color, '--subject-index': index } as React.CSSProperties}
                    >
                      <span className="first-run-subject-mark" aria-hidden="true">{details.mark}</span>
                      <span className="first-run-subject-copy"><strong>{subject.name}</strong><small>{details.description}</small></span>
                      <span className="first-run-check" aria-hidden="true">{active && <Check size={14} strokeWidth={3} />}</span>
                    </button>
                  )
                })}
              </div>

              {error && <p className="first-run-error" role="alert">{error}</p>}
              <footer className="first-run-actions">
                <p>{selected.size ? `${selected.size} ${selected.size === 1 ? 'Ordner' : 'Ordner'} + Eingang` : 'Nur Eingang'} wird angelegt.</p>
                <button className="primary-button first-run-continue" type="button" disabled={busy} onClick={() => void submit()}>
                  {busy ? <><LoaderCircle className="spin" size={17} /> Wird vorbereitet …</> : <>FaNotes einrichten <ArrowRight size={17} /></>}
                </button>
              </footer>
            </section>
          </div>
        )}
      </div>
    </main>
  )
}

function WelcomePreview() {
  return (
    <section className="first-run-app-preview" aria-label="Vorschau von FaNotes">
      <div className="first-run-preview-glow" />
      <div className="first-run-preview-window">
        <header><span /><span /><span /><b>FaNotes</b></header>
        <div className="first-run-preview-body">
          <aside>
            <strong><BookOpen size={12} /> Meine Fächer</strong>
            <span className="is-active"><i /> Mathematik</span>
            <span><i /> Deutsch</span>
            <span><i /> Physik</span>
            <span><i /> Wirtschaft</span>
          </aside>
          <div className="first-run-preview-paper">
            <small>MATHEMATIK · ANALYSIS</small>
            <h2>Ableitungen</h2>
            <p className="first-run-preview-typed">Die Änderungsrate beschreibt die Steigung.</p>
            <div className="first-run-preview-rule" />
            <svg className="first-run-preview-ink" viewBox="0 0 330 98" role="img" aria-label="Handschriftliche Formel">
              <path d="M15 58 C29 50 33 32 39 26 C47 18 41 67 51 70 C62 72 69 50 76 40 M61 55 C75 58 90 55 103 49 M119 62 C130 49 134 31 140 27 C148 22 143 64 153 66 C166 68 173 43 182 40 C192 37 191 63 202 62 M220 48 L247 48 M234 35 L234 63 M267 28 C290 20 308 30 308 48 C308 66 286 72 268 62" />
            </svg>
            <div className="first-run-preview-search"><Search size={11} /><span>„Änderungsrate“</span><b>1 Treffer</b></div>
          </div>
        </div>
      </div>
      <span className="first-run-preview-float first-run-preview-float-one"><PenLine size={15} /> Handschrift</span>
      <span className="first-run-preview-float first-run-preview-float-two"><Search size={15} /> Sofort gefunden</span>
    </section>
  )
}

function WritingPreview() {
  return (
    <section className="first-run-writing-preview" aria-label="Vorschau einer Seite mit Text und Handschrift">
      <div className="first-run-paper-toolbar"><span><b /></span><span /><span /><em>Analysis.md</em></div>
      <div className="first-run-paper-sheet">
        <small>12. August · Mathematik</small>
        <h2>Integralrechnung</h2>
        <p className="first-run-paper-type">Der Flächeninhalt lässt sich mit dem bestimmten Integral berechnen.</p>
        <svg className="first-run-paper-ink" viewBox="0 0 420 150" role="img" aria-label="Handschriftliche Integralrechnung">
          <path className="ink-one" d="M36 96 C51 77 46 38 65 28 C77 22 79 36 68 43 C52 54 51 98 35 112 C28 118 19 113 23 107" />
          <path className="ink-two" d="M81 42 L92 42 M79 107 L91 107 M111 78 C126 66 137 67 145 77 C152 88 140 99 124 98 C110 98 102 87 111 78 M155 72 L183 72 M169 58 L169 89 M202 48 C218 38 239 48 236 67 C232 88 213 96 201 88 M258 70 L294 70 M314 47 C331 36 348 47 345 65 C342 83 326 93 312 86 M365 82 C374 68 385 62 398 64" />
        </svg>
        <div className="first-run-paper-transcript"><Sparkles size={12} /><span><b>Im Hintergrund erkannt</b><small>∫₀¹ (x + 2) dx = 2,5</small></span><Check size={13} /></div>
        <div className="first-run-paper-selection"><span>Optional umwandeln</span></div>
      </div>
    </section>
  )
}
