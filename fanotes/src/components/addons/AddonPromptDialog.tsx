import { useEffect, useRef, useState } from 'react'

export type AddonPromptRequest = {
  title: string
  message: string
  placeholder?: string
  value?: string
  multiline?: boolean
  resolve: (value: string | null) => void
}

/** Text prompt add-ons can open through `fanotes.ui.prompt`; always shows which add-on is asking. */
export function AddonPromptDialog({ request }: { request: AddonPromptRequest | null }) {
  const [value, setValue] = useState(request?.value ?? '')
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    setValue(request?.value ?? '')
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [request])

  if (!request) return null
  const submit = () => request.resolve(value)
  const cancel = () => request.resolve(null)
  return (
    <div className="modal-backdrop addon-prompt-backdrop" role="presentation" onMouseDown={cancel}>
      <section className="addon-prompt" role="dialog" aria-modal="true" aria-label={request.title} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }}>
        <header>
          <h3 data-i18n-ignore>{request.title}</h3>
          <p data-i18n-ignore>{request.message}</p>
        </header>
        {request.multiline ? (
          <textarea ref={inputRef as React.RefObject<HTMLTextAreaElement>} data-i18n-ignore rows={6} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            data-i18n-ignore
            type="text"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
          />
        )}
        <footer>
          <button type="button" className="addon-btn" onClick={cancel}>Abbrechen</button>
          <button type="button" className="addon-btn addon-btn--primary" onClick={submit}>OK</button>
        </footer>
      </section>
    </div>
  )
}
