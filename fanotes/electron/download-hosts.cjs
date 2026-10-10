'use strict'

const isHuggingFaceHost = (hostname) => {
  const host = String(hostname || '').toLowerCase().replace(/\.$/u, '')
  return host === 'huggingface.co'
    || host.endsWith('.huggingface.co')
    || host === 'hf.co'
    || host.endsWith('.hf.co')
}

/**
 * A model download may follow redirects only when the final host is the host
 * we asked for, or another Hugging Face host when the request started there.
 * Anything else is rejected before a byte is written.
 */
function assertModelDownloadUrl(originalUrl, finalUrl) {
  const original = originalUrl instanceof URL ? originalUrl : new URL(String(originalUrl))
  const final = new URL(String(finalUrl || originalUrl))
  if (final.protocol !== 'https:' || final.username || final.password || original.protocol !== 'https:') {
    throw new Error('Unsicheres Downloadziel abgelehnt.')
  }
  const originalHost = original.hostname.toLowerCase().replace(/\.$/u, '')
  const finalHost = final.hostname.toLowerCase().replace(/\.$/u, '')
  if (finalHost === originalHost) return final
  if (isHuggingFaceHost(originalHost) && isHuggingFaceHost(finalHost)) return final
  throw new Error('Unsicheres Downloadziel abgelehnt.')
}

module.exports = { assertModelDownloadUrl, isHuggingFaceHost }
