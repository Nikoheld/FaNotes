export type NoteProfileId = 'school' | 'university' | 'private' | 'work'

export type NoteTemplate = {
  id: string
  profile: NoteProfileId
  title: string
  fileName: string
  markdown: string
}

export const NOTE_TEMPLATES: readonly NoteTemplate[] = [
  {
    id: 'protocol',
    profile: 'school',
    title: 'Protokoll',
    fileName: 'Protokoll',
    markdown: `# Protokoll

**Fach:**
**Datum:**
**Versuch:**

## Aufbau

## Beobachtung

## Ergebnis

## Frage

`,
  },
  {
    id: 'proof',
    profile: 'university',
    title: 'Beweis',
    fileName: 'Beweis',
    markdown: `# Beweis

**Satz.**

## Voraussetzungen

## Beweis

1.

## Bemerkung

`,
  },
  {
    id: 'cornell',
    profile: 'school',
    title: 'Cornell',
    fileName: 'Cornell',
    markdown: `# Cornell

| Stichworte | Notizen |
| --- | --- |
|  |  |

## Zusammenfassung

`,
  },
  {
    id: 'vocabulary',
    profile: 'school',
    title: 'Vokabeln',
    fileName: 'Vokabeln',
    markdown: `# Vokabeln

| Wort | Übersetzung | Beispiel |
| --- | --- | --- |
|  |  |  |

`,
  },
  {
    id: 'journal',
    profile: 'private',
    title: 'Tagebuch',
    fileName: 'Tagebuch',
    markdown: `# Tagebuch

## Was passiert ist

## Was ich mitnehme

`,
  },
  {
    id: 'meeting',
    profile: 'work',
    title: 'Besprechung',
    fileName: 'Besprechung',
    markdown: `# Besprechung

**Datum:**
**Teilnehmende:**

## Beschlüsse

- [ ]

## Offene Punkte

- [ ]

`,
  },
]

export const TEMPLATES_FOLDER = 'Vorlagen'

export const templatesForProfile = (profile: NoteProfileId) => (
  NOTE_TEMPLATES.filter((template) => template.profile === profile || template.profile === 'school' && profile === 'university')
)

export const templateById = (id: string) => NOTE_TEMPLATES.find((template) => template.id === id) ?? null

export const templatePath = (template: NoteTemplate) => `${TEMPLATES_FOLDER}/${template.fileName}.md`

/** Seed only while the template folder is still absent. */
export const templatesToSeed = (existingPaths: readonly string[], profile: NoteProfileId = 'school') => {
  if (existingPaths.some((path) => path === TEMPLATES_FOLDER || path.startsWith(`${TEMPLATES_FOLDER}/`))) return []
  return templatesForProfile(profile)
}
