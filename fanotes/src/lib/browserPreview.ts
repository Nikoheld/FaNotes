import { DEFAULT_SETTINGS } from '../defaults'
import { getUiLanguage } from '../i18n'
import type { AppSettings, DrawingLibraryDocument, FaNotesApi, UpdateState, VaultEntry, WorksheetDocument } from '../types'
import { loadBrowserSpellingResources, loadBrowserSpellingWordCandidates } from './spellingResources'
import { loadBrowserHandwritingRecognitionResources } from './handwritingRecognitionResources'

export const BROWSER_INITIAL_FILES: Record<string, string> = {
  'Willkommen.md': `# Willkommen bei FaNotes

Hier treffen **Markdown**, freie Handschrift und schön gesetzte Mathematik auf derselben ruhigen Notizseite zusammen. Deine Notizen bleiben normale Markdown-Dateien und lassen sich jederzeit auch mit anderen Editoren öffnen.

## Schnellstart

- Wähle links einen Bereich oder erstelle einen eigenen Ordner.
- Schreibe mit Tastatur oder Grafiktablett direkt auf derselben Notizseite.
- Importiere Bilder oder PDFs als Arbeitsblätter und fülle sie mit Textfeldern oder dem Stift aus.
- Konvertierte Mathematik wird als LaTeX gespeichert und sauber gesetzt dargestellt.
- Mit \`[[Notizname]]\` kannst du später Wissensseiten miteinander verbinden.

## Handschrift: schreiben wie auf Papier

1. Öffne eine Notiz und aktiviere oben den **Stift**.
2. Schreibe mit Grafiktablett, Touch-Stift oder Maus direkt auf die sichtbare Seite. Tastaturtext und Tinte bleiben dabei in derselben Ansicht.
3. Stiftfarbe, Breite, Druckempfindlichkeit, Glättung und Papierart findest du unter **Einstellungen → Stift & Erkennung**.

Deine Striche werden als editierbare Tinte automatisch im Vault gespeichert. Eine Seite darf vollständig handschriftlich bleiben – eine Umwandlung in Text ist niemals Pflicht.

### Natürlich löschen

- Kritzele ein geschriebenes Wort oder einen Zeichenbereich mehrfach hin und her durch, um ihn direkt zu löschen.
- Unter **Durchkritzel-Empfindlichkeit** stellst du von 0 bis 100 Prozent ein, wie gründlich du dafür kritzeln musst.
- Für einzelne Striche gibt es weiterhin den Radierer. Mit **Strg+Z** holst du eine versehentliche Löschung sofort zurück.

### Handschrift erkennen und konvertieren

- FaNotes erstellt im Hintergrund eine lokale, unsichtbare Transkription. Dadurch findet die Vault-Suche auch noch nicht konvertierte Handschrift, ohne das Aussehen der Seite zu verändern.
- Mit **Bereich konvertieren** rahmst du nur die gewünschte Stelle ein; **Seite konvertieren** verarbeitet die gesamte Seite.
- **Automatisch** unterscheidet normale Sätze von Mathematik. Brüche, Wurzeln, Hoch- und Tiefstellungen sowie Grenzen an Summen und Integralen werden anhand ihrer räumlichen Anordnung gelesen.
- Die Standarderkennung funktioniert sofort ohne Training. In **GlyphenWerk** kannst du zusätzliche Beispiele deiner eigenen Schrift erfassen, testen und damit die Erkennung personalisieren.

### Mathematik mit dem Stift

- Der Mathematik-Löser kann einen handschriftlichen Term nach einem Doppeltipp vereinfachen oder eine Gleichung lösen.
- Der Mathematik-Korrigierer prüft einen eingerahmten Rechenweg Schritt für Schritt und markiert nur sicher nachweisbare Fehler.
- Nach persönlichem GlyphenWerk-Training kann **Text → Handschrift** getippten Text oder berechnete Lösungen als variierende, verbundene Tinte einfügen.

> Alles bleibt lokal: sichtbare Tinte, Suchtranskription und persönliches Training verlassen dein Gerät nicht durch FaNotes.

## Kleine Handschrift-Übung

- [ ] Schreibe ein Wort mit dem Stift und lösche es durch Durchkritzeln.
- [ ] Schreibe einen kurzen Satz und finde ihn anschließend über die Suche.
- [ ] Schreibe einen Bruch oder eine Wurzel und probiere **Bereich konvertieren** aus.

Viel Freude beim Festhalten deiner Gedanken!
`,
  'Mathematik/Analysis.md': '# Analysis\n\n## Integrale\n\n$$\\int_a^b f(x)\\,dx$$\n\n#mathematik #prüfung\n',
  'Deutsch/Literatur.md': '# Literatur\n\nGedanken und Textanalysen sammeln.\n',
}

export const BROWSER_INITIAL_FILES_EN: Record<string, string> = {
  'Welcome.md': `# Welcome to FaNotes

This calm note page brings **Markdown**, free handwriting, and beautifully typeset mathematics together. Your notes remain standard Markdown files and can always be opened in other editors.

## Quick start

- Choose an area on the left or create your own folder.
- Write with the keyboard or a drawing tablet directly on the same note page.
- Import images or PDFs as worksheets and fill them in with text boxes or your pen.
- Converted mathematics is stored as LaTeX and displayed with clean typesetting.
- Use \`[[Note name]]\` to connect knowledge pages later.

## Handwriting: write as you would on paper

1. Open a note and enable the **Pen** at the top.
2. Write directly on the visible page with a drawing tablet, touch pen, or mouse. Typed text and ink stay in the same view.
3. Pen color, width, pressure sensitivity, smoothing, and paper style are available under **Settings → Pen & Recognition**.

Your strokes are saved automatically as editable ink in the vault. A page can remain entirely handwritten—converting it to text is always optional.

### Erase naturally

- Scribble back and forth over a written word or area several times to erase it directly.
- Use **Scribble erase sensitivity** from 0 to 100 percent to control how thoroughly you need to scribble.
- The eraser remains available for individual strokes. Press **Ctrl+Z** to restore something you erased by accident.

### Recognize and convert handwriting

- FaNotes creates a local, invisible transcript in the background. Vault search can therefore find handwriting that has not been converted yet without changing how the page looks.
- Use **Convert selection** to frame only the area you want; **Convert page** processes the complete page.
- **Automatic** distinguishes ordinary sentences from mathematics. Fractions, roots, superscripts, subscripts, and limits on sums and integrals are read from their spatial arrangement.
- Standard recognition works immediately without training. In **GlyphenWerk**, you can capture and test examples of your own writing to personalize recognition.

### Mathematics with the pen

- After a double-tap, the math solver can simplify a handwritten expression or solve an equation.
- The math checker reviews a selected calculation step by step and marks only errors that can be proven reliably.
- After personal GlyphenWerk training, **Text → Handwriting** can insert typed text or calculated solutions as naturally varying, connected ink.

> Everything stays local: visible ink, search transcripts, and personal training never leave your device through FaNotes.

## A short handwriting exercise

- [ ] Write a word with the pen and erase it by scribbling over it.
- [ ] Write a short sentence, then find it through search.
- [ ] Write a fraction or root and try **Convert selection**.

Enjoy capturing your thoughts!
`,
  'Mathematics/Analysis.md': '# Analysis\n\n## Integrals\n\n$$\\int_a^b f(x)\\,dx$$\n\n#mathematics #exam\n',
  'German/Literature.md': '# Literature\n\nCollect ideas and text analyses.\n',
}

export const BROWSER_STARTER_SUBJECTS = [
  { name: 'Mathematik', color: '#6f8cff' },
  { name: 'AMAT', color: '#9a7cff' },
  { name: 'Deutsch', color: '#ef7aa8' },
  { name: 'Englisch', color: '#45c9b7' },
  { name: 'Physik', color: '#b878eb' },
  { name: 'Chemie', color: '#f09a5d' },
  { name: 'Biologie', color: '#55cfa8' },
  { name: 'Geschichte', color: '#d4b54c' },
  { name: 'Informatik', color: '#4f9df8' },
  { name: 'Wirtschaft', color: '#e58a62' },
]
export const BROWSER_STARTER_SUBJECTS_EN = [
  { name: 'Mathematics', color: '#6f8cff' },
  { name: 'AMAT', color: '#9a7cff' },
  { name: 'German', color: '#ef7aa8' },
  { name: 'English', color: '#45c9b7' },
  { name: 'Physics', color: '#b878eb' },
  { name: 'Chemistry', color: '#f09a5d' },
  { name: 'Biology', color: '#55cfa8' },
  { name: 'History', color: '#d4b54c' },
  { name: 'Computer Science', color: '#4f9df8' },
  { name: 'Economics', color: '#e58a62' },
]

const BROWSER_OTHER_STARTER_FOLDERS = [
  { name: 'Vorlesungen', color: '#6f8cff' }, { name: 'Seminare', color: '#9a7cff' },
  { name: 'Forschung', color: '#45c9b7' }, { name: 'Prüfungen', color: '#ef7aa8' },
  { name: 'Literatur', color: '#d4b54c' }, { name: 'Persönlich', color: '#ef7aa8' },
  { name: 'Ideen', color: '#9a7cff' }, { name: 'Projekte', color: '#4f9df8' },
  { name: 'Tagebuch', color: '#55cfa8' }, { name: 'Dokumente', color: '#d4b54c' },
  { name: 'Meetings', color: '#9a7cff' }, { name: 'Aufgaben', color: '#ef7aa8' },
  { name: 'Wissen', color: '#45c9b7' }, { name: 'Archiv', color: '#d4b54c' },
]
const BROWSER_OTHER_STARTER_FOLDERS_EN = [
  { name: 'Lectures', color: '#6f8cff' }, { name: 'Seminars', color: '#9a7cff' },
  { name: 'Research', color: '#45c9b7' }, { name: 'Exams', color: '#ef7aa8' },
  { name: 'Reading', color: '#d4b54c' }, { name: 'Personal', color: '#ef7aa8' },
  { name: 'Ideas', color: '#9a7cff' }, { name: 'Projects', color: '#4f9df8' },
  { name: 'Journal', color: '#55cfa8' }, { name: 'Documents', color: '#d4b54c' },
  { name: 'Meetings', color: '#9a7cff' }, { name: 'Tasks', color: '#ef7aa8' },
  { name: 'Knowledge', color: '#45c9b7' }, { name: 'Archive', color: '#d4b54c' },
]

export const browserInitialFiles = () => getUiLanguage() === 'en' ? BROWSER_INITIAL_FILES_EN : BROWSER_INITIAL_FILES
export const browserStarterSubjects = () => getUiLanguage() === 'en' ? BROWSER_STARTER_SUBJECTS_EN : BROWSER_STARTER_SUBJECTS
export const browserStarterFolders = () => {
  const folders = getUiLanguage() === 'en'
    ? [...BROWSER_STARTER_SUBJECTS_EN, ...BROWSER_OTHER_STARTER_FOLDERS_EN]
    : [...BROWSER_STARTER_SUBJECTS, ...BROWSER_OTHER_STARTER_FOLDERS]
  return [...new Map(folders.map((folder) => [folder.name, folder])).values()]
}

const uniquePath = (preferred: string, exists: (path: string) => boolean) => {
  if (!exists(preferred)) return preferred
  const dot = preferred.lastIndexOf('.')
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred
  const extension = dot > 0 ? preferred.slice(dot) : ''
  let number = 2
  while (exists(`${stem} ${number}${extension}`)) number += 1
  return `${stem} ${number}${extension}`
}

export function createBrowserPreviewApi(): FaNotesApi {
  const english = getUiLanguage() === 'en'
  const starterSubjects = browserStarterSubjects()
  let settings = { ...DEFAULT_SETTINGS, ...(english ? { recognitionLanguage: 'en' as const, defaultFolder: 'Inbox', dailyNotesFolder: 'Daily Notes' } : {}) }
  const files = new Map(Object.entries(browserInitialFiles()))
  const initialFolders = [english ? 'Inbox' : 'Eingang', ...starterSubjects.map(({ name }) => name)]
  const folders = new Set(initialFolders)
  const folderColors = new Map<string, string>([[english ? 'Inbox' : 'Eingang', '#8b7cff'], ...starterSubjects.map(({ name, color }) => [name, color] as [string, string])])
  const assets = new Map<string, string>()
  const drawings = new Map<string, DrawingLibraryDocument>()
  const worksheets = new Map<string, WorksheetDocument>()
  const updateState: UpdateState = {
    status: 'up-to-date',
    supported: false,
    currentVersion: '2026.7.4-beta.9',
    latestVersion: '2026.7.4-beta.9',
    publishedAt: new Date().toISOString(),
    releaseNotes: [],
    downloadedBytes: 0,
    totalBytes: 0,
    progress: 0,
    error: null,
    checkedAt: new Date().toISOString(),
    installationKind: 'managed-appimage',
    autoCheckUpdates: true,
    autoDownloadUpdates: true,
    installUpdatesOnQuit: true,
    updateChannel: 'stable',
  }

  const tree = () => {
    const root: VaultEntry[] = []
    const directories = new Map<string, VaultEntry[]>()
    directories.set('', root)
    ;[...folders].sort().forEach((folder) => {
      const parts = folder.split('/')
      const name = parts.pop()!
      const parent = parts.join('/')
      const children: VaultEntry[] = []
      directories.set(folder, children)
      const bucket = directories.get(parent) ?? root
      bucket.push({ name, relativePath: folder, kind: 'folder', color: folderColors.get(folder), children })
    })
    files.forEach((content, relativePath) => {
      const parts = relativePath.split('/')
      const name = parts.pop()!
      const parent = parts.join('/')
      ;(directories.get(parent) ?? root).push({ name, relativePath, kind: 'file', extension: 'md', size: content.length })
    })
    const sort = (entries: VaultEntry[]) => entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, getUiLanguage()) : a.kind === 'folder' ? -1 : 1).forEach((entry) => entry.children && sort(entry.children))
    sort(root)
    return root
  }

  return {
    platform: 'browser-preview',
    bootstrap: async () => ({ vaultPath: english ? '/home/demo/Documents/FaNotes' : '/home/demo/Dokumente/FaNotes', vaultName: english ? 'School' : 'Schule', settings, onboardingRequired: false, starterSubjects }),
    reportRendererReady: () => undefined,
    completeOnboarding: async () => ({ vaultPath: english ? '/home/demo/Documents/FaNotes' : '/home/demo/Dokumente/FaNotes', vaultName: english ? 'School' : 'Schule', settings, onboardingRequired: false, starterSubjects }),
    selectVault: async () => ({ vaultPath: english ? '/home/demo/Documents/FaNotes' : '/home/demo/Dokumente/FaNotes', vaultName: english ? 'School' : 'Schule', settings, onboardingRequired: false, starterSubjects }),
    getCachedTree: async () => tree(),
    getFastTree: async () => tree(),
    getTree: async () => tree(),
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error('Datei nicht gefunden.')
      return content
    },
    readAssetDataUrl: async (path) => assets.get(path) ?? '',
    loadSpellingResources: loadBrowserSpellingResources,
    loadSpellingWordCandidates: loadBrowserSpellingWordCandidates,
    loadHandwritingRecognitionResources: loadBrowserHandwritingRecognitionResources,
    writeFile: async (path, content) => { files.set(path, content); return { modifiedAt: new Date().toISOString() } },
    createNote: async (parent = '', preferredName = english ? 'Untitled Note' : 'Unbenannte Notiz') => {
      const filename = preferredName.toLowerCase().endsWith('.md') ? preferredName : `${preferredName}.md`
      const path = uniquePath([parent, filename].filter(Boolean).join('/'), (candidate) => files.has(candidate))
      files.set(path, `# ${filename.replace(/\.md$/i, '')}\n\n`)
      return { relativePath: path, entry: { name: path.split('/').pop()!, relativePath: path, kind: 'file', extension: 'md' } }
    },
    createFolder: async (parent = '', preferredName = english ? 'New Folder' : 'Neuer Ordner') => {
      const path = uniquePath([parent, preferredName].filter(Boolean).join('/'), (candidate) => folders.has(candidate))
      folders.add(path)
      return { relativePath: path, entry: { name: path.split('/').pop()!, relativePath: path, kind: 'folder', children: [] } }
    },
    setFolderColor: async (path, color) => {
      if (!folders.has(path)) throw new Error('Ordner nicht gefunden.')
      if (color) folderColors.set(path, color)
      else folderColors.delete(path)
      return { color }
    },
    renameEntry: async (path, nextName) => {
      const parent = path.split('/').slice(0, -1).join('/')
      const next = [parent, nextName].filter(Boolean).join('/')
      if (files.has(path)) { const content = files.get(path)!; files.delete(path); files.set(next.toLowerCase().endsWith('.md') ? next : `${next}.md`, content); return next.toLowerCase().endsWith('.md') ? next : `${next}.md` }
      const movedFolders = [...folders].filter((candidate) => candidate === path || candidate.startsWith(`${path}/`))
      movedFolders.forEach((candidate) => {
        folders.delete(candidate)
        folders.add(candidate === path ? next : `${next}${candidate.slice(path.length)}`)
      })
      const movedFiles = [...files.entries()].filter(([candidate]) => candidate.startsWith(`${path}/`))
      movedFiles.forEach(([candidate, content]) => {
        files.delete(candidate)
        files.set(`${next}${candidate.slice(path.length)}`, content)
      })
      const movedColors = [...folderColors.entries()].filter(([candidate]) => candidate === path || candidate.startsWith(`${path}/`))
      movedColors.forEach(([candidate, color]) => {
        folderColors.delete(candidate)
        folderColors.set(candidate === path ? next : `${next}${candidate.slice(path.length)}`, color)
      })
      return next
    },
    trashEntry: async (path) => {
      ;[...files.keys()].forEach((candidate) => {
        if (candidate === path || candidate.startsWith(`${path}/`)) files.delete(candidate)
      })
      ;[...folders].forEach((candidate) => {
        if (candidate === path || candidate.startsWith(`${path}/`)) folders.delete(candidate)
      })
      ;[...folderColors.keys()].forEach((candidate) => {
        if (candidate === path || candidate.startsWith(`${path}/`)) folderColors.delete(candidate)
      })
    },
    search: async (query) => {
      const needle = query.toLocaleLowerCase('de')
      const noteHits = [...files.entries()].flatMap(([relativePath, content]) => content.toLocaleLowerCase('de').includes(needle) ? [{ relativePath, title: relativePath.split('/').pop()!.replace(/\.md$/i, ''), excerpt: content.replace(/[#*_`]/g, '').slice(0, 180), matches: 1, kind: 'note' as const }] : [])
      const drawingHits = [...drawings.values()].flatMap((drawing) => {
        try {
          const document = JSON.parse(drawing.drawingJson) as { searchTranscript?: unknown }
          const transcript = typeof document.searchTranscript === 'string' ? document.searchTranscript : ''
          const searchable = `${drawing.title}\n${transcript}`
          if (!searchable.toLocaleLowerCase('de').includes(needle)) return []
          return [{
            relativePath: drawing.dataRelativePath,
            title: drawing.title,
            excerpt: searchable.slice(0, 180),
            matches: 1,
            kind: 'drawing' as const,
            drawingId: drawing.id,
          }]
        } catch {
          return []
        }
      })
      return [...noteHits, ...drawingHits]
    },
    saveDrawing: async ({ id = crypto.randomUUID(), title, imageData, drawingJson }) => {
      const imageRelativePath = `.fanotes/assets/${id}.png`
      const dataRelativePath = `.fanotes/assets/${id}.json`
      let updatedAt = new Date().toISOString()
      try {
        const parsed = JSON.parse(drawingJson) as { updatedAt?: unknown }
        if (typeof parsed.updatedAt === 'string') updatedAt = parsed.updatedAt
      } catch {
        // The desktop side validates JSON; the preview keeps its fallback timestamp.
      }
      if (imageData) assets.set(imageRelativePath, imageData)
      drawings.set(id, { id, title, updatedAt, imageRelativePath, dataRelativePath, drawingJson })
      return { id, title, updatedAt, imageRelativePath, dataRelativePath }
    },
    listDrawings: async () => [...drawings.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ drawingJson: _drawingJson, ...item }) => item),
    readDrawing: async (id) => {
      const drawing = drawings.get(id)
      if (!drawing) throw new Error('Zeichnung nicht gefunden.')
      return { ...drawing }
    },
    importWorksheet: async () => {
      const id = crypto.randomUUID()
      const now = new Date().toISOString()
      const sourceRelativePath = `.fanotes/worksheets/${id}.png`
      const dataRelativePath = `.fanotes/worksheets/${id}.json`
      const document: WorksheetDocument = {
        schemaVersion: 1,
        id,
        title: 'Demo-Arbeitsblatt',
        kind: 'image',
        mimeType: 'image/png',
        sourceRelativePath,
        dataRelativePath,
        createdAt: now,
        updatedAt: now,
        textBoxes: [],
      }
      const demo = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1273" viewBox="0 0 900 1273"><rect width="900" height="1273" fill="#fff"/><text x="70" y="100" font-family="sans-serif" font-size="38" font-weight="700" fill="#242733">Demo-Arbeitsblatt</text><text x="70" y="154" font-family="sans-serif" font-size="20" fill="#555">Trage deine Antworten mit Tastatur oder Stift ein.</text>${Array.from({ length: 9 }, (_, index) => `<text x="75" y="${260 + index * 95}" font-family="sans-serif" font-size="24" fill="#252833">${index + 1}. Aufgabe ${index + 1}</text><line x1="300" y1="${268 + index * 95}" x2="820" y2="${268 + index * 95}" stroke="#aeb3c0" stroke-width="2"/>`).join('')}</svg>`
      assets.set(sourceRelativePath, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(demo)}`)
      worksheets.set(id, document)
      return { ...document, textBoxes: [] }
    },
    importOneNote: async () => null,
    readWorksheet: async (id) => {
      const document = worksheets.get(id)
      if (!document) throw new Error('Arbeitsblatt nicht gefunden.')
      return structuredClone(document)
    },
    saveWorksheet: async (document) => {
      const saved = { ...structuredClone(document), updatedAt: new Date().toISOString() }
      worksheets.set(document.id, saved)
      return structuredClone(saved)
    },
    lmStudioListModels: async () => [{
      key: 'fanotes/demo-local-8b',
      displayName: 'FaNotes Demo Local 8B',
      publisher: 'Browser-Vorschau',
      quantization: 'Q4_K_M',
      params: '8B',
      loaded: true,
      maxContextLength: 32_768,
      description: 'Lokales Vorschaumodell für die Browser-Demo.',
    }],
    lmStudioTransform: async ({ model, markdown, actions, instruction }) => {
      const additions = [
        actions.includes('summary') ? '\n\n## KI-Zusammenfassung\n\n- Lokal erzeugte Vorschau der Notiz.' : '',
        actions.includes('study') ? '\n\n## Lernfragen\n\n1. Was ist die wichtigste Aussage dieser Notiz?\n   <details><summary>Antwort</summary>Die Kernaussage aus dem vorhandenen Inhalt.</details>' : '',
        actions.includes('instruction') && instruction ? `\n\n> Freier Auftrag: ${instruction}` : '',
      ].join('')
      return { markdown: `${markdown.trimEnd()}${additions}\n`, model, stats: { inputTokens: 128, outputTokens: 64, tokensPerSecond: 42 } }
    },
    aiListModels: async (connection) => [{
      provider: connection.provider,
      key: `${connection.provider}/fanotes-demo`,
      displayName: `${connection.provider} · FaNotes Demo`,
      publisher: 'Browser-Vorschau',
      quantization: connection.provider === 'ollama' || connection.provider === 'lmstudio' ? 'Q4_K_M' : null,
      params: null,
      loaded: true,
      maxContextLength: 32_768,
      description: 'Vorschaumodell für den gemeinsamen AI-Bereich.',
    }],
    aiTransform: async ({ connection, markdown, actions, instruction }) => ({
      provider: connection.provider,
      model: connection.model,
      markdown: `${markdown.trimEnd()}${actions.includes('summary') ? '\n\n## AI-Zusammenfassung\n\n- Erzeugte Vorschau der Notiz.' : ''}${actions.includes('instruction') && instruction ? `\n\n> Freier Auftrag: ${instruction}` : ''}\n`,
      stats: { inputTokens: 128, outputTokens: 64, tokensPerSecond: 42 },
    }),
    saveSettings: async (next: AppSettings) => { settings = next; return settings },
    resetAppData: async () => { settings = { ...DEFAULT_SETTINGS }; return { restarting: false } },
    getUpdateState: async () => ({ ...updateState, autoCheckUpdates: settings.autoCheckUpdates, autoDownloadUpdates: settings.autoDownloadUpdates, installUpdatesOnQuit: settings.installUpdatesOnQuit, updateChannel: settings.updateChannel }),
    checkForUpdates: async () => ({ ...updateState, checkedAt: new Date().toISOString() }),
    downloadUpdate: async () => ({ ...updateState }),
    installUpdate: async () => ({ ...updateState }),
    onUpdateState: () => () => undefined,
    revealInFolder: async () => undefined,
    openExternal: async (url) => { window.open(url, '_blank', 'noopener,noreferrer') },
    onBeforeClose: () => () => undefined,
    confirmClose: () => undefined,
    cancelClose: () => undefined,
    requestClose: () => window.close(),
  }
}
