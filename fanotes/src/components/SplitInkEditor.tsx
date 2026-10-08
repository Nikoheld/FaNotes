import { useEffect, useState } from 'react'
import { DrawingBoard } from './DrawingBoard'
import type { DrawingSavePayload, DrawingSaveResult } from './DrawingBoard'
import type { AppSettings, DrawingLibraryDocument } from '../types'

/** Pen editor for the focused split pane. It keeps its own undo stack and autosave. */
export function SplitInkEditor({
  path,
  title,
  load,
  settings,
  onSaveDrawing,
}: {
  path: string
  title: string
  load: () => Promise<DrawingLibraryDocument | null>
  settings: AppSettings
  onSaveDrawing: (payload: DrawingSavePayload, notePath: string) => Promise<DrawingSaveResult>
}) {
  const [document, setDocument] = useState<DrawingLibraryDocument | null>(null)
  useEffect(() => {
    let cancelled = false
    void load().then((next) => { if (!cancelled) setDocument(next) })
    return () => { cancelled = true }
  }, [load, path])
  return (
    <DrawingBoard
      settings={settings}
      drawingId={document?.id}
      initialDrawingJson={document?.drawingJson}
      title={`Handschrift · ${title}`}
      inline
      inputActive
      sectionsEnabled
      onSaveDrawing={(payload) => onSaveDrawing(payload, path)}
      onClose={() => undefined}
      onInsertMarkdown={() => false}
      onSettingsChange={() => undefined}
      onDirtyChange={() => undefined}
      onOpenGlyphenWerk={() => undefined}
    />
  )
}
