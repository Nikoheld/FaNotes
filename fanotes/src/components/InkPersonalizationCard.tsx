import { Check, Download, LoaderCircle, Trash2, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clearInkPersonalization,
  exportInkPersonalBundle,
  fitInkPersonalStyle,
  importInkPersonalBundle,
  importInkPersonalModel,
  inkPersonalizationSummary,
  removeInkPersonalModel,
  setInkPersonalizationEnabled,
  type InkPersonalizationSummary,
} from '../lib/inkPersonalization'

const percent = (value: number | null) => value === null ? '–' : `${value.toFixed(1)} %`

/**
 * Desktop handwriting personalization: confirmed lines, the fitted writer style, and an optional
 * fine-tuned model. Hidden capabilities stay local; the model itself is stored by the native host.
 */
export function InkPersonalizationCard() {
  const [summary, setSummary] = useState<InkPersonalizationSummary | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [reportFile, setReportFile] = useState<File | null>(null)
  const [debugOn, setDebugOn] = useState(() => {
    try { return globalThis.localStorage?.getItem('fanotesInkDebug') === '1' } catch { return false }
  })
  const trainingInput = useRef<HTMLInputElement>(null)
  const modelInput = useRef<HTMLInputElement>(null)
  const reportInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    setSummary(await inkPersonalizationSummary())
  }, [])

  useEffect(() => {
    void refresh().catch((error) => {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Die persönliche Handschrift konnte nicht geladen werden.' })
    })
  }, [refresh])

  const run = async (label: string, action: () => Promise<string>) => {
    setBusy(label)
    setNotice(null)
    try {
      setNotice({ kind: 'success', text: await action() })
      await refresh()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Das hat nicht geklappt.' })
    } finally {
      setBusy(null)
    }
  }

  if (!summary) {
    return notice ? <div className="settings-inline-error" role="status">{notice.text}</div> : null
  }
  if (!summary.available) {
    return (
      <div className="settings-resource-note">
        <span>Die Stifterkennung läuft nur in der Desktop-App für Windows und Linux.</span>
      </div>
    )
  }

  return (
    <div className="settings-ink-personal">
      <div className="setting-row">
        <div className="setting-copy">
          <span>Persönliche Handschrift</span>
          <small>
            {summary.lines} bestätigte Zeilen · {summary.vocabulary} eigene Wörter
            {summary.style ? ' · Schreibstil angepasst' : ''}
            {summary.errorBefore !== null && summary.errorAfter !== null
              ? ` · ${percent(summary.errorBefore)} → ${percent(summary.errorAfter)} auf zurückgehaltenen Zeilen`
              : ''}
          </small>
        </div>
        <div className="setting-control">
          <button
            type="button"
            className={`toggle ${summary.enabled ? 'is-on' : ''}`}
            role="switch"
            aria-checked={summary.enabled}
            aria-label="Persönliche Anpassung"
            disabled={busy !== null}
            onClick={() => void run('toggle', async () => {
              await setInkPersonalizationEnabled(!summary.enabled)
              return summary.enabled ? 'Basis-Modell aktiv.' : 'Persönliche Anpassung aktiv.'
            })}
          >
            <span />
          </button>
        </div>
      </div>
      <div className="settings-resource-note">
        <span>
          Bestätigte Konvertierungen lernen lokal mit. Ab {summary.minimumLines} Zeilen passt FaNotes Stiftbreite,
          Neigung und Grösse an deine Schrift an. Ein feiner abgestimmtes Modell entsteht offline aus dem Export
          und wird hier importiert.
        </span>
      </div>
      <div className="settings-ink-actions">
        <button
          type="button"
          className="settings-inline-button"
          disabled={busy !== null || summary.lines < summary.minimumLines}
          onClick={() => void run('fit', async () => {
            const profile = await fitInkPersonalStyle()
            return profile.style
              ? `Schreibstil angepasst${profile.errorAfter !== null ? ` · ${percent(profile.errorAfter)} Zeichenfehler` : ''}.`
              : 'Der bisherige Stil liest deine Zeilen mindestens so gut; er bleibt.'
          })}
        >
          {busy === 'fit' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          Stil anpassen
        </button>
        <button
          type="button"
          className="settings-inline-button"
          disabled={busy !== null || summary.lines === 0}
          onClick={() => void run('export', async () => {
            const bundle = await exportInkPersonalBundle()
            const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = 'fanotes-handschrift.json'
            link.click()
            URL.revokeObjectURL(url)
            return `${bundle.lines.length} Zeilen exportiert.`
          })}
        >
          <Download size={15} />
          Training exportieren
        </button>
        <button type="button" className="settings-inline-button" disabled={busy !== null} onClick={() => trainingInput.current?.click()}>
          <Upload size={15} />
          Training importieren
        </button>
        <input
          ref={trainingInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            void run('import', async () => {
              const parsed = JSON.parse(await file.text()) as unknown
              const added = await importInkPersonalBundle(parsed)
              return `${added} neue Zeilen übernommen.`
            })
          }}
        />
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <span>Persönliches Modell</span>
          <small>
            {summary.model?.installed
              ? `${summary.model.name ?? 'Modell'} · ${summary.model.compatible ? 'passend zur Basis' : 'andere Basisversion'}${summary.model.errorAfter !== null ? ` · ${percent(summary.model.errorAfter)}` : ''}`
              : 'Optional. Aus dem exportierten Training mit scripts/ink-model/personalize.py erzeugt.'}
          </small>
        </div>
        <div className="setting-control settings-ink-actions">
          <button type="button" className="settings-inline-button" disabled={busy !== null} onClick={() => reportInput.current?.click()}>
            <Upload size={15} />
            {reportFile ? reportFile.name : 'Bericht (.json)'}
          </button>
          <button type="button" className="settings-inline-button" disabled={busy !== null} onClick={() => modelInput.current?.click()}>
            <Upload size={15} />
            Modell laden
          </button>
          {summary.model?.installed && (
            <button
              type="button"
              className="settings-inline-button"
              disabled={busy !== null}
              onClick={() => void run('remove-model', async () => {
                await removeInkPersonalModel()
                return 'Persönliches Modell entfernt. Die Basis bleibt.'
              })}
            >
              <Trash2 size={15} />
              Entfernen
            </button>
          )}
          <input
            ref={reportInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              event.target.value = ''
              setReportFile(file)
              if (file) setNotice({ kind: 'success', text: `Bericht ${file.name} ist bereit. Lade jetzt das ONNX-Modell.` })
            }}
          />
          <input
            ref={modelInput}
            type="file"
            accept=".onnx,application/octet-stream"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) return
              const report = reportFile ?? undefined
              void run('model', async () => {
                const state = await importInkPersonalModel(file, report)
                setReportFile(null)
                return state.compatible ? 'Persönliches Modell aktiv.' : 'Modell gespeichert, passt aber nicht zur aktuellen Basis.'
              })
            }}
          />
        </div>
      </div>
      <div className="setting-row">
        <div className="setting-copy">
          <span>Erkennungsdiagnose</span>
          <small>Schreibt pro Zeile Text, Alternativen und Zeiten in die Entwicklerkonsole.</small>
        </div>
        <div className="setting-control">
          <button
            type="button"
            className={`toggle ${debugOn ? 'is-on' : ''}`}
            role="switch"
            aria-checked={debugOn}
            aria-label="Erkennungsdiagnose"
            onClick={() => {
              const next = !debugOn
              try { globalThis.localStorage?.setItem('fanotesInkDebug', next ? '1' : '0') } catch { /* private mode */ }
              setDebugOn(next)
            }}
          >
            <span />
          </button>
        </div>
      </div>
      <div className="settings-ink-actions">
        <button
          type="button"
          className="settings-inline-button"
          disabled={busy !== null || summary.lines === 0}
          onClick={() => void run('clear', async () => {
            await clearInkPersonalization()
            return 'Persönliches Training gelöscht.'
          })}
        >
          <X size={15} />
          Training löschen
        </button>
      </div>
      {notice && <div className={notice.kind === 'error' ? 'settings-inline-error' : 'settings-resource-note'} role="status">{notice.text}</div>}
    </div>
  )
}
