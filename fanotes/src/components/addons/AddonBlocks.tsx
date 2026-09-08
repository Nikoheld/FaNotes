import { useEffect, useState } from 'react'
import type { AddonBlock } from '../../lib/addons/blocks'
import { MarkdownPreview } from '../MarkdownPreview'

// Renders the JSON block tree an add-on hands to the host. Add-ons never get a
// DOM handle: this component is the only way their UI reaches the screen, so
// everything it shows was already normalised by lib/addons/blocks.ts.

export type AddonBlockEvents = {
  onAction: (actionId: string, itemId?: string) => void
  onInput: (inputId: string, value: unknown) => void
}

type BlockProps = { block: AddonBlock; events: AddonBlockEvents; values: Record<string, unknown>; onValue: (id: string, value: unknown) => void }

function TextInputBlock({ block, events, values, onValue }: BlockProps & { block: Extract<AddonBlock, { type: 'input' }> }) {
  const external = typeof values[block.id] === 'string' ? (values[block.id] as string) : block.value
  const [draft, setDraft] = useState(external)
  useEffect(() => { setDraft(external) }, [external])
  const commit = () => {
    if (draft === external) return
    onValue(block.id, draft)
    events.onInput(block.id, draft)
  }
  return (
    <label className="addon-block addon-block--input">
      {block.label ? <span>{block.label}</span> : null}
      {block.multiline ? (
        <textarea
          data-i18n-ignore
          value={draft}
          rows={block.rows}
          placeholder={block.placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <input
          data-i18n-ignore
          type="text"
          value={draft}
          placeholder={block.placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
              events.onAction(`submit:${block.id}`)
            }
          }}
        />
      )}
    </label>
  )
}

function Block({ block, events, values, onValue }: BlockProps) {
  switch (block.type) {
    case 'heading': {
      const Tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4'
      return <Tag className="addon-block addon-block--heading" data-i18n-ignore>{block.text}</Tag>
    }
    case 'text':
      return <p className={`addon-block addon-block--text${block.muted ? ' is-muted' : ''}`} data-i18n-ignore>{block.text}</p>
    case 'markdown':
      return (
        <div className="addon-block addon-block--markdown" data-i18n-ignore>
          <MarkdownPreview content={block.text} className="addon-block__markdown" emptyMessage="" />
        </div>
      )
    case 'callout':
      return <div className={`addon-block addon-block--callout tone-${block.tone}`} role={block.tone === 'error' ? 'alert' : undefined} data-i18n-ignore>{block.text}</div>
    case 'button':
      return (
        <button
          type="button"
          className={`addon-block addon-block--button${block.primary ? ' is-primary' : ''}${block.danger ? ' is-danger' : ''}`}
          disabled={block.disabled}
          onClick={() => events.onAction(block.id)}
          data-i18n-ignore
        >
          {block.label}
        </button>
      )
    case 'input':
      return <TextInputBlock block={block} events={events} values={values} onValue={onValue} />
    case 'select': {
      const value = typeof values[block.id] === 'string' ? (values[block.id] as string) : block.value
      return (
        <label className="addon-block addon-block--select">
          {block.label ? <span>{block.label}</span> : null}
          <select
            data-i18n-ignore
            value={value}
            onChange={(event) => {
              onValue(block.id, event.target.value)
              events.onInput(block.id, event.target.value)
            }}
          >
            {block.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      )
    }
    case 'checkbox': {
      const checked = typeof values[block.id] === 'boolean' ? (values[block.id] as boolean) : block.checked
      return (
        <label className="addon-block addon-block--checkbox">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => {
              onValue(block.id, event.target.checked)
              events.onInput(block.id, event.target.checked)
            }}
          />
          <span data-i18n-ignore>{block.label}</span>
        </label>
      )
    }
    case 'list':
      return (
        <ul className="addon-block addon-block--list" data-i18n-ignore>
          {block.items.length === 0 && block.empty ? <li className="addon-block__empty">{block.empty}</li> : null}
          {block.items.map((item, index) => (
            <li key={`${item.id}-${index}`}>
              <button type="button" onClick={() => events.onAction(block.id, item.id)}>
                <span className="addon-block__list-title">{item.title}</span>
                {item.detail ? <span className="addon-block__list-detail">{item.detail}</span> : null}
                {item.badge ? <span className="addon-block__list-badge">{item.badge}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )
    case 'keyvalue':
      return (
        <dl className="addon-block addon-block--keyvalue" data-i18n-ignore>
          {block.items.map((item, index) => (
            <div key={`${item.key}-${index}`}>
              <dt>{item.key}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )
    case 'progress':
      return (
        <div className="addon-block addon-block--progress" data-i18n-ignore>
          {block.label ? <span>{block.label}</span> : null}
          <progress value={block.value} max={1} />
        </div>
      )
    case 'divider':
      return <hr className="addon-block addon-block--divider" />
    case 'row':
      return (
        <div className="addon-block addon-block--row">
          {block.children.map((child, index) => <Block key={index} block={child} events={events} values={values} onValue={onValue} />)}
        </div>
      )
    default:
      return null
  }
}

export function AddonBlocks({ blocks, events, values, onValue }: { blocks: AddonBlock[]; events: AddonBlockEvents; values: Record<string, unknown>; onValue: (id: string, value: unknown) => void }) {
  return (
    <div className="addon-blocks">
      {blocks.map((block, index) => <Block key={index} block={block} events={events} values={values} onValue={onValue} />)}
    </div>
  )
}
