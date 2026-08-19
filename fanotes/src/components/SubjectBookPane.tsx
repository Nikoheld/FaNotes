import { BookOpen, LoaderCircle, PenLine, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { DrawingBoardHandle, DrawingSavePayload } from './DrawingBoard'
import { PdfNoteView } from './PdfNoteView'
import { SafeBoundary } from './SafeBoundary'
import { SUBJECT_BOOK_TOOLBAR_SLOT_ID, type SubjectBookRecord } from '../lib/subjectBook'
import type { AppSettings, DrawingLibraryDocument } from '../types'

const DrawingBoard = lazy(() => import('./DrawingBoard').then((module) => ({ default: module.DrawingBoard })))

type SubjectBookPaneProps = {
  book: SubjectBookRecord
  settings: AppSettings
  pageCountHint?: number
  onPageChange: (page: number, pageCount: number) => void
  onClose?: () => void
  popout?: boolean
}

export function SubjectBookPane({
  book,
  settings,
  onPageChange,
  onClose,
  popout = false,
}: SubjectBookPaneProps) {
  const [inking, setInking] = useState(false)
  const [drawing, setDrawing] = useState<DrawingLibraryDocument | null>(null)
  const [drawingKey, setDrawingKey] = useState(0)
  const boardRef = useRef<DrawingBoardHandle>(null)
  const title = book.bookPath.replace(/^.*\//u, '').replace(/\.pdf$/iu, '') || 'Buch'

  useEffect(() => {
    let alive = true
    setDrawing(null)
    setInking(false)
    if (!window.fanotes.readFamdInk) return
    void window.fanotes.readFamdInk(book.bookPath)
      .then((document) => {
        if (!alive) return
        setDrawing(document)
        setDrawingKey((current) => current + 1)
      })
      .catch(() => {
        if (!alive) return
        setDrawing(null)
        setDrawingKey((current) => current + 1)
      })
    return () => { alive = false }
  }, [book.bookPath])

  const saveInk = useCallback(async (payload: DrawingSavePayload) => {
    const asset = await window.fanotes.saveDrawing({
      ...payload,
      noteRelativePath: book.bookPath,
    })
    setDrawing({
      id: asset.id,
      title: asset.title ?? payload.title,
      updatedAt: asset.updatedAt ?? new Date().toISOString(),
      imageRelativePath: asset.imageRelativePath,
      dataRelativePath: asset.dataRelativePath,
      drawingJson: payload.drawingJson,
    })
    return { ...asset, markdown: '' }
  }, [book.bookPath])

  return (
    <section className={`subject-book-pane ${popout ? 'is-popout' : ''} ${inking ? 'is-inking' : ''}`} aria-label={`Buch ${title}`}>
      <header className="subject-book-pane-bar">
        <strong><BookOpen size={14} /> {title}</strong>
        <div id={SUBJECT_BOOK_TOOLBAR_SLOT_ID} className="subject-book-pdf-toolbar" />
        <button
          type="button"
          className={`toolbar-button ${inking ? 'active' : ''}`}
          title="Notizen im Buch"
          aria-pressed={inking}
          onClick={() => setInking((current) => !current)}
        >
          <PenLine size={14} /><span>Notizen</span>
        </button>
        {onClose && (
          <button type="button" className="toolbar-button" title="Buch schließen" aria-label="Buch schließen" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </header>
      <div className="subject-book-pane-body">
        <SafeBoundary name="Fachbuch" fallbackTitle="Das Buch konnte nicht angezeigt werden">
          <PdfNoteView
            path={book.bookPath}
            title={title}
            toolbarSlotId={SUBJECT_BOOK_TOOLBAR_SLOT_ID}
            initialPage={book.lastPage}
            inputDisabled={inking}
            onPageChange={onPageChange}
          />
        </SafeBoundary>
        {drawingKey > 0 && (
          <Suspense fallback={inking ? <div className="inline-ink-loading"><LoaderCircle className="spin" size={16} /> Stiftebene wird geladen …</div> : null}>
            <DrawingBoard
              ref={boardRef}
              key={`${book.bookPath}:${drawingKey}`}
              settings={settings}
              drawingId={drawing?.id}
              initialDrawingJson={drawing?.drawingJson}
              title={`Buchnotiz · ${title}`}
              inline
              inputActive={inking}
              onSaveDrawing={saveInk}
              onInsertMarkdown={() => false}
            />
          </Suspense>
        )}
      </div>
    </section>
  )
}
