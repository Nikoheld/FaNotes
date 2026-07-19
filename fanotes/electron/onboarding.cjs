'use strict'

const REQUIRED_STARTER_FOLDERS = Object.freeze([
  Object.freeze({ name: 'Eingang', color: '#8b7cff' }),
])

const REQUIRED_STARTER_FOLDERS_EN = Object.freeze([
  Object.freeze({ name: 'Inbox', color: '#8b7cff' }),
])

const STARTER_SUBJECTS = Object.freeze([
  Object.freeze({ name: 'Mathematik', color: '#6f8cff' }),
  Object.freeze({ name: 'AMAT', color: '#9a7cff' }),
  Object.freeze({ name: 'Deutsch', color: '#ef7aa8' }),
  Object.freeze({ name: 'Englisch', color: '#45c9b7' }),
  Object.freeze({ name: 'Physik', color: '#b878eb' }),
  Object.freeze({ name: 'Chemie', color: '#f09a5d' }),
  Object.freeze({ name: 'Biologie', color: '#55cfa8' }),
  Object.freeze({ name: 'Geschichte', color: '#d4b54c' }),
  Object.freeze({ name: 'Informatik', color: '#4f9df8' }),
  Object.freeze({ name: 'Wirtschaft', color: '#e58a62' }),
])

const STARTER_SUBJECTS_EN = Object.freeze([
  Object.freeze({ name: 'Mathematics', color: '#6f8cff' }),
  Object.freeze({ name: 'AMAT', color: '#9a7cff' }),
  Object.freeze({ name: 'German', color: '#ef7aa8' }),
  Object.freeze({ name: 'English', color: '#45c9b7' }),
  Object.freeze({ name: 'Physics', color: '#b878eb' }),
  Object.freeze({ name: 'Chemistry', color: '#f09a5d' }),
  Object.freeze({ name: 'Biology', color: '#55cfa8' }),
  Object.freeze({ name: 'History', color: '#d4b54c' }),
  Object.freeze({ name: 'Computer Science', color: '#4f9df8' }),
  Object.freeze({ name: 'Economics', color: '#e58a62' }),
])

const STARTER_UNIVERSITY = Object.freeze([
  Object.freeze({ name: 'Vorlesungen', color: '#6f8cff' }),
  Object.freeze({ name: 'Seminare', color: '#9a7cff' }),
  Object.freeze({ name: 'Forschung', color: '#45c9b7' }),
  Object.freeze({ name: 'Prüfungen', color: '#ef7aa8' }),
  Object.freeze({ name: 'Literatur', color: '#d4b54c' }),
])

const STARTER_UNIVERSITY_EN = Object.freeze([
  Object.freeze({ name: 'Lectures', color: '#6f8cff' }),
  Object.freeze({ name: 'Seminars', color: '#9a7cff' }),
  Object.freeze({ name: 'Research', color: '#45c9b7' }),
  Object.freeze({ name: 'Exams', color: '#ef7aa8' }),
  Object.freeze({ name: 'Reading', color: '#d4b54c' }),
])

const STARTER_PRIVATE = Object.freeze([
  Object.freeze({ name: 'Persönlich', color: '#ef7aa8' }),
  Object.freeze({ name: 'Ideen', color: '#9a7cff' }),
  Object.freeze({ name: 'Projekte', color: '#4f9df8' }),
  Object.freeze({ name: 'Tagebuch', color: '#55cfa8' }),
  Object.freeze({ name: 'Dokumente', color: '#d4b54c' }),
])

const STARTER_PRIVATE_EN = Object.freeze([
  Object.freeze({ name: 'Personal', color: '#ef7aa8' }),
  Object.freeze({ name: 'Ideas', color: '#9a7cff' }),
  Object.freeze({ name: 'Projects', color: '#4f9df8' }),
  Object.freeze({ name: 'Journal', color: '#55cfa8' }),
  Object.freeze({ name: 'Documents', color: '#d4b54c' }),
])

const STARTER_WORK = Object.freeze([
  Object.freeze({ name: 'Projekte', color: '#4f9df8' }),
  Object.freeze({ name: 'Meetings', color: '#9a7cff' }),
  Object.freeze({ name: 'Aufgaben', color: '#ef7aa8' }),
  Object.freeze({ name: 'Wissen', color: '#45c9b7' }),
  Object.freeze({ name: 'Archiv', color: '#d4b54c' }),
])

const STARTER_WORK_EN = Object.freeze([
  Object.freeze({ name: 'Projects', color: '#4f9df8' }),
  Object.freeze({ name: 'Meetings', color: '#9a7cff' }),
  Object.freeze({ name: 'Tasks', color: '#ef7aa8' }),
  Object.freeze({ name: 'Knowledge', color: '#45c9b7' }),
  Object.freeze({ name: 'Archive', color: '#d4b54c' }),
])

const STARTER_PROFILES = Object.freeze({
  school: STARTER_SUBJECTS,
  university: STARTER_UNIVERSITY,
  private: STARTER_PRIVATE,
  work: STARTER_WORK,
})

const STARTER_PROFILES_EN = Object.freeze({
  school: STARTER_SUBJECTS_EN,
  university: STARTER_UNIVERSITY_EN,
  private: STARTER_PRIVATE_EN,
  work: STARTER_WORK_EN,
})

const ALL_STARTER_FOLDERS = Object.freeze([...new Map(
  [...Object.values(STARTER_PROFILES), ...Object.values(STARTER_PROFILES_EN)]
    .flat()
    .map((folder) => [folder.name, folder]),
).values()])
const STARTER_FOLDER_NAMES = new Set(ALL_STARTER_FOLDERS.map(({ name }) => name))

const starterSubjectsForLanguage = (language) => language === 'en' ? STARTER_SUBJECTS_EN : STARTER_SUBJECTS
const requiredStarterFoldersForLanguage = (language) => language === 'en' ? REQUIRED_STARTER_FOLDERS_EN : REQUIRED_STARTER_FOLDERS
const starterProfilesForLanguage = (language) => language === 'en' ? STARTER_PROFILES_EN : STARTER_PROFILES
const starterFoldersForLanguage = (language) => Object.values(starterProfilesForLanguage(language)).flat()

function validateStarterSubjectSelection(candidate) {
  if (!Array.isArray(candidate) || candidate.length > 16) {
    throw new Error('Die Ordnerauswahl ist ungültig.')
  }

  const selected = []
  const seen = new Set()
  for (const value of candidate) {
    if (typeof value !== 'string' || !STARTER_FOLDER_NAMES.has(value) || seen.has(value)) {
      throw new Error('Die Ordnerauswahl enthält einen ungültigen oder doppelten Eintrag.')
    }
    seen.add(value)
    selected.push(value)
  }
  return selected
}

function onboardingRequiredFromConfig(candidate) {
  return candidate?.onboarding?.version === 1 && candidate.onboarding.completed === false
}

function parseOnboardingStatus(candidate) {
  return candidate?.version === 1 && ['pending', 'complete'].includes(candidate.status)
    ? candidate.status
    : null
}

module.exports = {
  REQUIRED_STARTER_FOLDERS,
  requiredStarterFoldersForLanguage,
  STARTER_SUBJECTS,
  starterSubjectsForLanguage,
  STARTER_PROFILES,
  STARTER_PROFILES_EN,
  starterProfilesForLanguage,
  starterFoldersForLanguage,
  onboardingRequiredFromConfig,
  parseOnboardingStatus,
  validateStarterSubjectSelection,
}
