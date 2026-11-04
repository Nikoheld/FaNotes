// Firebase Cloud Messaging HTTP v1. A missing service account skips the send.
// Payloads are data messages: an event name, never a grade.

import { createSign } from 'node:crypto'
import { promises as fs } from 'node:fs'

export const FCM_ACCOUNT_FILE = '/etc/fanotes/fcm-service-account.json'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

export const isValidFcmToken = (token) => (
  typeof token === 'string'
  && token.length >= 20
  && token.length <= 4096
  && /^[A-Za-z0-9:_\-.]+$/u.test(token)
)

export const parseServiceAccount = (text) => {
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  if (!parsed || parsed.type !== 'service_account') return null
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@')) return null
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) return null
  if (typeof parsed.project_id !== 'string' || !/^[a-z0-9-]{4,60}$/u.test(parsed.project_id)) return null
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    project_id: parsed.project_id,
  }
}

export const readServiceAccount = async (file) => {
  try { return parseServiceAccount(await fs.readFile(file, 'utf8')) } catch { return null }
}

const b64url = (value) => Buffer.from(value).toString('base64url')

export const serviceAccountJwt = (account, nowMs) => {
  const iat = Math.floor(nowMs / 1000)
  const exp = iat + 3600
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  signer.end()
  const signature = signer.sign(account.private_key).toString('base64url')
  return { jwt: `${header}.${payload}.${signature}`, exp }
}

const COLLAPSE_KEY = {
  reauth: 'kanti-reauth',
  test: 'kanti-test',
  sync: 'kanti-sync',
}

/** High priority wakes the phone. Timetable-only refreshes do not. */
export const fcmPriorityForChanges = (changes) => {
  const categories = (Array.isArray(changes) ? changes : [])
    .map((change) => change?.category)
    .filter((category) => typeof category === 'string' && category)
  if (categories.some((category) => category !== 'timetable')) return 'HIGH'
  return null
}

export const fcmDataMessage = (token, event, options = {}) => {
  const priority = options.priority === 'NORMAL' ? 'NORMAL' : 'HIGH'
  return {
    message: {
      token,
      data: { event: String(event) },
      android: {
        priority,
        collapse_key: COLLAPSE_KEY[event] || 'kanti-sync',
        ttl: priority === 'HIGH' ? '21600s' : '3600s',
      },
    },
  }
}

export const fcmDropToken = (status, body) => {
  const text = String(body || '')
  if (status === 404) return true
  return text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')
}

export const exchangeServiceAccount = async (account, fetchImpl, nowMs) => {
  const signed = serviceAccountJwt(account, nowMs)
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signed.jwt,
    }).toString(),
  })
  const body = await response.text()
  if (!response.ok && response.status !== 200) {
    const error = new Error('fcm-auth')
    error.status = response.status
    throw error
  }
  let parsed = {}
  try { parsed = JSON.parse(body) } catch { parsed = {} }
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) throw new Error('fcm-auth')
  const expiresIn = Number(parsed.expires_in) || 3600
  return { token: parsed.access_token, exp: Math.floor(nowMs / 1000) + expiresIn, projectId: account.project_id }
}
