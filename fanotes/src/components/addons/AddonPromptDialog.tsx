import { Puzzle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DialogFrame } from '../DialogFrame'

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
    <DialogFrame
      icon={<Puzzle size={18} />}
      eyebrow="Add-on"
      title={request.title}
      dynamicTitle
      titleId="addon-prompt-title"
      onClose={cancel}
      size="sm"
      className="addon-prompt"
      footer={(
        <>
          <button type="button" className="secondary-button" onClick={cancel}>Abbrechen</button>
          <button type="button" className="primary-button" onClick={submit}>OK</button>
        </>
      )}
    >
      <p className="dialog-frame__lede addon-prompt__message" data-i18n-ignore>{request.message}</p>
      {request.multiline ? (
        <textarea ref={inputRef as React.RefObject<HTMLTextAreaElement>} data-autofocus="" data-i18n-ignore rows={6} value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          data-autofocus=""
          data-i18n-ignore
          type="text"
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
        />
      )}
    </DialogFrame>
  )
}
