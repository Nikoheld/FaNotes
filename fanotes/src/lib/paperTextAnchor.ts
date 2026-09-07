/**
 * Camera anchor inside a virtualised text editor.
 *
 * CodeMirror renders only the lines near the viewport and *estimates* the
 * height of the rest, so a paper pixel offset is not a stable coordinate for
 * a long note: the same line sits at a different offset until every line
 * above it has been measured once. A document position plus the offset from
 * that line's top is stable — it names the text that was under the viewport
 * edge, whatever the current height estimate is.
 *
 * The editor registers a provider on its host element; the camera looks it
 * up through the DOM so it never has to import the editor bundle.
 */
export type PaperTextAnchor = {
  /** Document offset of the line block under the viewport top edge. */
  pos: number
  /** Unzoomed CSS px from that line's top to the viewport top edge (may be negative). */
  offset: number
}

export type PaperTextAnchorProvider = {
  anchorAtClientY: (clientY: number) => PaperTextAnchor | null
  /** Current client-space y for a stored anchor; null while the text is not laid out. */
  clientYForAnchor: (anchor: PaperTextAnchor) => number | null
}

export const PAPER_TEXT_ANCHOR_ATTR = 'data-paper-text-anchor'

/** Minimal slice of an EditorView the anchor math needs (client-space, scaled). */
export type AnchorEditorView = {
  documentTop: number
  scaleY: number
  state: { doc: { length: number } }
  lineBlockAt: (pos: number) => { from: number; top: number }
  lineBlockAtHeight: (height: number) => { from: number; top: number }
}

const usedScale = (scale: number) => (Number.isFinite(scale) && scale > 0 ? scale : 1)

export const textAnchorFromView = (view: AnchorEditorView, clientY: number): PaperTextAnchor | null => {
  if (!Number.isFinite(clientY) || !Number.isFinite(view.documentTop)) return null
  const block = view.lineBlockAtHeight(clientY - view.documentTop)
  if (!block) return null
  const lineTop = view.documentTop + block.top
  return {
    pos: Math.max(0, Math.round(block.from)),
    offset: Math.round(((clientY - lineTop) / usedScale(view.scaleY)) * 100) / 100,
  }
}

export const clientYFromTextAnchor = (view: AnchorEditorView, anchor: PaperTextAnchor): number | null => {
  if (!Number.isFinite(view.documentTop)) return null
  const pos = Math.max(0, Math.min(view.state.doc.length, Math.round(anchor.pos)))
  const block = view.lineBlockAt(pos)
  if (!block) return null
  return view.documentTop + block.top + anchor.offset * usedScale(view.scaleY)
}

export const normalizeTextAnchor = (raw: unknown): PaperTextAnchor | null => {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const pos = record.pos
  const offset = record.offset
  if (typeof pos !== 'number' || !Number.isFinite(pos) || pos < 0) return null
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return null
  return { pos: Math.round(pos), offset: Math.round(offset * 100) / 100 }
}

const providers = new WeakMap<Element, PaperTextAnchorProvider>()

export const registerPaperTextAnchorProvider = (host: Element, provider: PaperTextAnchorProvider) => {
  providers.set(host, provider)
  host.setAttribute(PAPER_TEXT_ANCHOR_ATTR, '')
  return () => {
    if (providers.get(host) === provider) {
      providers.delete(host)
      host.removeAttribute(PAPER_TEXT_ANCHOR_ATTR)
    }
  }
}

export const findPaperTextAnchorProvider = (root: ParentNode | null): PaperTextAnchorProvider | null => {
  if (!root) return null
  const hosts = root.querySelectorAll(`[${PAPER_TEXT_ANCHOR_ATTR}]`)
  for (const host of hosts) {
    const provider = providers.get(host)
    if (provider) return provider
  }
  return null
}
