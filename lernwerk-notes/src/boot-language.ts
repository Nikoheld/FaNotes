const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
const english = !languages.some((language) => /^de(?:-|$)/iu.test(language || ''))
document.documentElement.lang = english ? 'en' : 'de-CH'
if (english) {
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', './manifest.en.webmanifest')
  const description = document.querySelector('meta[name="description"]')
  if (description) description.setAttribute('content', 'FaNotes Web – Markdown, handwriting, mathematics, and worksheets directly in your browser.')
  const status = document.querySelector('[data-boot-status]')
  if (status) status.textContent = 'Opening workspace'
}

