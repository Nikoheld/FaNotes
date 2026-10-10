'use strict'

const REQUIRED_STARTER_FOLDERS = Object.freeze([
  Object.freeze({ name: 'Eingang', color: '#6b7280' }),
])

const REQUIRED_STARTER_FOLDERS_EN = Object.freeze([
  Object.freeze({ name: 'Inbox', color: '#6b7280' }),
])

const STARTER_SUBJECTS = Object.freeze([
  Object.freeze({ name: 'Mathematik', color: '#2a6f97' }),
  Object.freeze({ name: 'AMAT', color: '#9065b0' }),
  Object.freeze({ name: 'Deutsch', color: '#c4554d' }),
  Object.freeze({ name: 'Englisch', color: '#0f7b6c' }),
  Object.freeze({ name: 'Französisch', color: '#1d5f86' }),
  Object.freeze({ name: 'Physik', color: '#7c6a9a' }),
  Object.freeze({ name: 'Chemie', color: '#d9730d' }),
  Object.freeze({ name: 'Biologie', color: '#448361' }),
  Object.freeze({ name: 'Geschichte', color: '#ba9b4a' }),
  Object.freeze({ name: 'Informatik', color: '#337ea9' }),
  Object.freeze({ name: 'Wirtschaft', color: '#c47d4e' }),
])

const STARTER_SUBJECTS_EN = Object.freeze([
  Object.freeze({ name: 'Mathematics', color: '#2a6f97' }),
  Object.freeze({ name: 'AMAT', color: '#9065b0' }),
  Object.freeze({ name: 'German', color: '#c4554d' }),
  Object.freeze({ name: 'English', color: '#0f7b6c' }),
  Object.freeze({ name: 'French', color: '#1d5f86' }),
  Object.freeze({ name: 'Physics', color: '#7c6a9a' }),
  Object.freeze({ name: 'Chemistry', color: '#d9730d' }),
  Object.freeze({ name: 'Biology', color: '#448361' }),
  Object.freeze({ name: 'History', color: '#ba9b4a' }),
  Object.freeze({ name: 'Computer Science', color: '#337ea9' }),
  Object.freeze({ name: 'Economics', color: '#c47d4e' }),
])

const STARTER_UNIVERSITY = Object.freeze([
  Object.freeze({ name: 'Vorlesungen', color: '#2a6f97' }),
  Object.freeze({ name: 'Seminare', color: '#9065b0' }),
  Object.freeze({ name: 'Forschung', color: '#0f7b6c' }),
  Object.freeze({ name: 'Prüfungen', color: '#c4554d' }),
  Object.freeze({ name: 'Literatur', color: '#ba9b4a' }),
])

const STARTER_UNIVERSITY_EN = Object.freeze([
  Object.freeze({ name: 'Lectures', color: '#2a6f97' }),
  Object.freeze({ name: 'Seminars', color: '#9065b0' }),
  Object.freeze({ name: 'Research', color: '#0f7b6c' }),
  Object.freeze({ name: 'Exams', color: '#c4554d' }),
  Object.freeze({ name: 'Reading', color: '#ba9b4a' }),
])

const STARTER_PRIVATE = Object.freeze([
  Object.freeze({ name: 'Persönlich', color: '#c4554d' }),
  Object.freeze({ name: 'Ideen', color: '#9065b0' }),
  Object.freeze({ name: 'Projekte', color: '#337ea9' }),
  Object.freeze({ name: 'Tagebuch', color: '#448361' }),
  Object.freeze({ name: 'Dokumente', color: '#ba9b4a' }),
])

const STARTER_PRIVATE_EN = Object.freeze([
  Object.freeze({ name: 'Personal', color: '#c4554d' }),
  Object.freeze({ name: 'Ideas', color: '#9065b0' }),
  Object.freeze({ name: 'Projects', color: '#337ea9' }),
  Object.freeze({ name: 'Journal', color: '#448361' }),
  Object.freeze({ name: 'Documents', color: '#ba9b4a' }),
])

const STARTER_WORK = Object.freeze([
  Object.freeze({ name: 'Projekte', color: '#337ea9' }),
  Object.freeze({ name: 'Meetings', color: '#9065b0' }),
  Object.freeze({ name: 'Aufgaben', color: '#c4554d' }),
  Object.freeze({ name: 'Wissen', color: '#0f7b6c' }),
  Object.freeze({ name: 'Archiv', color: '#ba9b4a' }),
])

const STARTER_WORK_EN = Object.freeze([
  Object.freeze({ name: 'Projects', color: '#337ea9' }),
  Object.freeze({ name: 'Meetings', color: '#9065b0' }),
  Object.freeze({ name: 'Tasks', color: '#c4554d' }),
  Object.freeze({ name: 'Knowledge', color: '#0f7b6c' }),
  Object.freeze({ name: 'Archive', color: '#ba9b4a' }),
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

/** Only an explicit pending marker blocks the shell. Missing status is a pre-onboarding vault. */
function onboardingRequiredFromVaultStatus(status) {
  return status === 'pending'
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
  onboardingRequiredFromVaultStatus,
  parseOnboardingStatus,
  validateStarterSubjectSelection,
}
