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

const ENGLISH_TEMPLATES: Record<string, Pick<NoteTemplate, 'title' | 'fileName' | 'markdown'>> = {
  protocol: {
    title: 'Lab report',
    fileName: 'Lab report',
    markdown: `# Lab report

**Subject:**
**Date:**
**Experiment:**

## Setup

## Observation

## Result

## Question

`,
  },
  proof: {
    title: 'Proof',
    fileName: 'Proof',
    markdown: `# Proof

**Theorem.**

## Assumptions

## Proof

1.

## Remark

`,
  },
  cornell: {
    title: 'Cornell',
    fileName: 'Cornell',
    markdown: `# Cornell

| Cues | Notes |
| --- | --- |
|  |  |

## Summary

`,
  },
  vocabulary: {
    title: 'Vocabulary',
    fileName: 'Vocabulary',
    markdown: `# Vocabulary

| Word | Translation | Example |
| --- | --- | --- |
|  |  |  |

`,
  },
  journal: {
    title: 'Journal',
    fileName: 'Journal',
    markdown: `# Journal

## What happened

## What I take with me

`,
  },
  meeting: {
    title: 'Meeting',
    fileName: 'Meeting',
    markdown: `# Meeting

**Date:**
**Attendees:**

## Decisions

- [ ]

## Open items

- [ ]

`,
  },
}

/** The template in the UI language, so notes created from it do not stay German in the English UI. */
export const localizeTemplate = (template: NoteTemplate, language: 'de' | 'en'): NoteTemplate => (
  language === 'en' && ENGLISH_TEMPLATES[template.id] ? { ...template, ...ENGLISH_TEMPLATES[template.id] } : template
)

export const templatesFolderName = (language: 'de' | 'en') => (language === 'en' ? 'Templates' : TEMPLATES_FOLDER)
