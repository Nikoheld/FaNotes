/**
 * Tiny event bus: a search result asks the PDF view to show a page and mark
 * the query there. Kept separate so the PDF view does not load the indexer.
 */
export type PdfRevealRequest = { path: string; page: number; query: string; token: number }
type RevealListener = (request: PdfRevealRequest) => void
const revealListeners = new Set<RevealListener>()
let pendingReveal: PdfRevealRequest | null = null

/** Asks the PDF view showing `path` to go to `page` and mark `query` there. */
export const requestPdfReveal = (path: string, page: number, query: string) => {
  pendingReveal = { path, page, query, token: Date.now() }
  for (const listener of revealListeners) listener(pendingReveal)
}

/** For the PDF view: receives requests, including one made just before it mounted. */
export const subscribePdfReveal = (path: string, listener: RevealListener) => {
  const wrapped: RevealListener = (request) => { if (request.path === path) { pendingReveal = null; listener(request) } }
  revealListeners.add(wrapped)
  if (pendingReveal && pendingReveal.path === path && Date.now() - pendingReveal.token < 15_000) wrapped(pendingReveal)
  return () => { revealListeners.delete(wrapped) }
}
