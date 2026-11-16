'use strict'

// Shared by the OneNote importer (writes the guard into every page) and main.cjs (re-applies it
// when a page is served). A page found in a vault is never trusted just because it carries a
// marker: main verifies the SHA-256 stored in the worksheet document and prepends the policy
// again, so even a forged page/document pair runs under `default-src 'none'` in a sandboxed frame.

const crypto = require('node:crypto')

const ONENOTE_PAGE_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const ONENOTE_PAGE_MARKER = '<meta name="fanotes-onenote-safe-v1" content="1">'
const ONENOTE_PAGE_POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${ONENOTE_PAGE_POLICY}">`

const pageSha256 = (html) => crypto.createHash('sha256').update(html, 'utf8').digest('hex')

/**
 * The page as the frame receives it: the policy comes first, before any markup of the page.
 * A page can add further policies but never remove this one.
 */
const guardedPageHtml = (html) => `${ONENOTE_PAGE_POLICY_META}${html}`

/** True only for a page whose guard was written by the importer (the marker must precede the policy in the head). */
const hasImporterGuard = (html) => {
  const marker = html.indexOf(ONENOTE_PAGE_MARKER)
  return marker >= 0 && html.indexOf(ONENOTE_PAGE_POLICY_META) === marker + ONENOTE_PAGE_MARKER.length
    && /^(?:<!doctype html><html><head>|[\s\S]{0,4096}?<head>)$/iu.test(html.slice(0, marker))
}

module.exports = { ONENOTE_PAGE_POLICY, ONENOTE_PAGE_MARKER, ONENOTE_PAGE_POLICY_META, pageSha256, guardedPageHtml, hasImporterGuard }
