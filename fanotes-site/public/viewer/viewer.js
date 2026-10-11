const note = document.querySelector('#note')
const FAMD_SCHEMA = 'fanotes-famd-v1'

const parseFamd = (source) => {
  const header = /(?:^|\n)<!--\s*fanotes-famd:v1\s+chars=(\d+)\s*-->\n/u
  const matches = [...String(source || '').matchAll(new RegExp(header.source, 'gu'))]
  const match = matches.at(-1)
  if (!match || match.index === undefined) return String(source || '').replace(/\s+$/u, '')
  return String(source).slice(0, match.index).replace(/\s+$/u, '')
}

document.querySelector('#file').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.addEventListener('load', () => {
    note.textContent = parseFamd(String(reader.result || ''))
  })
  reader.readAsText(file)
})
