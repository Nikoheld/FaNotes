const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
let preference = 'system'
try { preference = localStorage.getItem('fanotes.uiLanguage') || 'system' } catch {}
const systemIsEnglish = !languages.some((language) => /^de(?:-|$)/iu.test(language || ''))
const english = preference === 'en' || (preference !== 'de' && systemIsEnglish)
document.documentElement.lang = english ? 'en' : 'de-CH'
document.querySelector('link[rel="manifest"]')?.setAttribute('href', english ? './manifest.en.webmanifest' : './manifest.webmanifest')
if (english) {
  const description = document.querySelector('meta[name="description"]')
  if (description) description.setAttribute('content', 'FaNotes Web – Markdown, handwriting, mathematics, and worksheets directly in your browser.')
  const status = document.querySelector('[data-boot-status]')
  if (status) status.textContent = 'Opening workspace'
}
