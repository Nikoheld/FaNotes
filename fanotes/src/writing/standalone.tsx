// Stand-alone writing mode (the Android app's WebView loads writing.html):
// `?path=Folder/Name.story` opens a story, `?create=Folder&title=Name`
// creates one first. `?lang=en` switches the interface to English.
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import '../styles.css'
import { setUiLanguage } from '../i18n'
import { writerId } from './model/ids'
import { androidBridge, installAndroidHost } from './androidHost'
import { createProject, saveImportedProject, storyHost } from './storage'
import { ImportDialog } from './import/ImportDialog'
import { WritingMode } from './ui/WritingMode'

const params = new URLSearchParams(window.location.search)
const bridge = androidBridge()
if (bridge) installAndroidHost(bridge)

function Standalone() {
  const [path, setPath] = useState<string | null>(params.get('path'))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (path || params.get('create') === null) return
    const host = storyHost()
    if (!host) { setError('No story host.'); return }
    const english = params.get('lang') === 'en'
    createProject(host, params.get('create') ?? '', { title: params.get('title') || (english ? 'Story' : 'Geschichte'), language: english ? 'en-US' : 'de', deviceId: writerId() })
      .then((created) => { setPath(created); bridge?.saved(JSON.stringify([`${created}/story.json`])) })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
  }, [path])
  const importInto = params.get('import')
  if (!path && importInto !== null) {
    return (
      <ImportDialog
        onImport={async (story) => {
          const host = storyHost()
          if (!host) throw new Error('No story host.')
          const created = await saveImportedProject(host, importInto, story)
          bridge?.saved(JSON.stringify([`${created}/story.json`]))
          setPath(created)
        }}
        onClose={() => bridge?.close()}
      />
    )
  }
  if (error) return <p style={{ padding: 24 }}>{error}</p>
  if (!path) return null
  return <WritingMode path={path} onClose={() => bridge?.close()} onSaved={(paths) => bridge?.saved(JSON.stringify(paths))} />
}

void setUiLanguage(params.get('lang') === 'en' ? 'en' : 'de').catch(() => undefined).finally(() => {
  document.documentElement.lang = params.get('lang') === 'en' ? 'en' : 'de'
  createRoot(document.getElementById('root')!).render(<Standalone />)
})
