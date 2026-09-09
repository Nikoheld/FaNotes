// Add-ons never touch the DOM. They describe their panels as a small JSON block
// tree and FaNotes renders it (see components/addons/AddonBlocks.tsx). This
// module normalises untrusted block trees into a bounded, well-typed shape so
// the renderer can trust every field.

export type AddonBlock =
  | { type: 'heading'; text: string; level: 1 | 2 | 3 }
  | { type: 'text'; text: string; muted: boolean }
  | { type: 'markdown'; text: string }
  | { type: 'callout'; tone: 'info' | 'success' | 'warning' | 'error'; text: string }
  | { type: 'button'; id: string; label: string; primary: boolean; danger: boolean; disabled: boolean }
  | { type: 'input'; id: string; label: string; value: string; placeholder: string; multiline: boolean; rows: number }
  | { type: 'select'; id: string; label: string; value: string; options: Array<{ value: string; label: string }> }
  | { type: 'checkbox'; id: string; label: string; checked: boolean }
  | { type: 'list'; id: string; items: Array<{ id: string; title: string; detail: string; badge: string }>; empty: string }
  | { type: 'keyvalue'; items: Array<{ key: string; value: string }> }
  | { type: 'progress'; value: number; label: string }
  | { type: 'divider' }
  | { type: 'row'; children: AddonBlock[] }

export const ADDON_BLOCK_LIMITS = Object.freeze({
  maxBlocks: 400,
  maxDepth: 4,
  maxText: 20_000,
  maxShort: 200,
  maxListItems: 500,
  maxOptions: 200,
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number, fallback = '') => (typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback)

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/u

const ident = (value: unknown, fallback: string) => (typeof value === 'string' && ID_PATTERN.test(value) ? value : fallback)

let anonymousCounter = 0

const normaliseBlock = (raw: unknown, depth: number, budget: { left: number }): AddonBlock | null => {
  if (!isRecord(raw) || budget.left <= 0) return null
  budget.left -= 1
  const { maxText, maxShort } = ADDON_BLOCK_LIMITS
  switch (raw.type) {
    case 'heading': {
      const level = raw.level === 1 || raw.level === 3 ? raw.level : 2
      return { type: 'heading', text: text(raw.text, maxShort), level }
    }
    case 'text':
      return { type: 'text', text: text(raw.text, maxText), muted: raw.muted === true }
    case 'markdown':
      return { type: 'markdown', text: text(raw.text, maxText) }
    case 'callout': {
      const tone = raw.tone === 'success' || raw.tone === 'warning' || raw.tone === 'error' ? raw.tone : 'info'
      return { type: 'callout', tone, text: text(raw.text, maxText) }
    }
    case 'button':
      return {
        type: 'button',
        id: ident(raw.id, `button-${++anonymousCounter}`),
        label: text(raw.label, maxShort, 'Aktion'),
        primary: raw.primary === true,
        danger: raw.danger === true,
        disabled: raw.disabled === true,
      }
    case 'input': {
      const rows = typeof raw.rows === 'number' && Number.isFinite(raw.rows) ? Math.max(2, Math.min(20, Math.round(raw.rows))) : 4
      return {
        type: 'input',
        id: ident(raw.id, `input-${++anonymousCounter}`),
        label: text(raw.label, maxShort),
        value: text(raw.value, maxText),
        placeholder: text(raw.placeholder, maxShort),
        multiline: raw.multiline === true,
        rows,
      }
    }
    case 'select': {
      const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, ADDON_BLOCK_LIMITS.maxOptions).map((option) => {
        if (isRecord(option)) return { value: text(option.value, maxShort), label: text(option.label, maxShort) || text(option.value, maxShort) }
        const value = text(option, maxShort)
        return { value, label: value }
      })
      return { type: 'select', id: ident(raw.id, `select-${++anonymousCounter}`), label: text(raw.label, maxShort), value: text(raw.value, maxShort), options }
    }
    case 'checkbox':
      return { type: 'checkbox', id: ident(raw.id, `checkbox-${++anonymousCounter}`), label: text(raw.label, maxShort), checked: raw.checked === true }
    case 'list': {
      const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, ADDON_BLOCK_LIMITS.maxListItems).map((item, index) => {
        if (!isRecord(item)) return { id: `item-${index}`, title: text(item, maxShort), detail: '', badge: '' }
        return {
          id: typeof item.id === 'string' ? item.id.slice(0, 400) : `item-${index}`,
          title: text(item.title, maxShort),
          detail: text(item.detail, maxShort * 3),
          badge: text(item.badge, 24),
        }
      })
      return { type: 'list', id: ident(raw.id, `list-${++anonymousCounter}`), items, empty: text(raw.empty, maxShort) }
    }
    case 'keyvalue': {
      const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, ADDON_BLOCK_LIMITS.maxListItems).flatMap((item) => (
        isRecord(item) ? [{ key: text(item.key, maxShort), value: text(item.value, maxShort * 2) }] : []
      ))
      return { type: 'keyvalue', items }
    }
    case 'progress': {
      const value = typeof raw.value === 'number' && Number.isFinite(raw.value) ? Math.max(0, Math.min(1, raw.value)) : 0
      return { type: 'progress', value, label: text(raw.label, maxShort) }
    }
    case 'divider':
      return { type: 'divider' }
    case 'row': {
      if (depth >= ADDON_BLOCK_LIMITS.maxDepth) return null
      const children = (Array.isArray(raw.children) ? raw.children : [])
        .map((child) => normaliseBlock(child, depth + 1, budget))
        .filter((child): child is AddonBlock => child !== null)
      return { type: 'row', children }
    }
    default:
      return null
  }
}

/** Accepts anything an add-on sends and returns a bounded block list (never throws). */
export const normaliseAddonBlocks = (raw: unknown): AddonBlock[] => {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? [raw] : []
  const budget = { left: ADDON_BLOCK_LIMITS.maxBlocks }
  return list.map((block) => normaliseBlock(block, 0, budget)).filter((block): block is AddonBlock => block !== null)
}

export const countAddonBlocks = (blocks: AddonBlock[]): number => blocks.reduce((total, block) => total + 1 + (block.type === 'row' ? countAddonBlocks(block.children) : 0), 0)
