// Shared auth helpers — underscore prefix keeps Vercel from exposing this
// file as an endpoint. Single-user app: the token is a stateless HMAC derived
// from APP_PASSWORD, so every function can verify it without a sessions store
// and rotating the password invalidates all tokens instantly.

import { createHmac, createHash, timingSafeEqual } from 'node:crypto'

const TOKEN_CONTEXT = 'yelp-collections-auth-v1'

export function makeToken() {
  const secret = process.env.APP_PASSWORD
  if (!secret) return null
  return createHmac('sha256', secret).update(TOKEN_CONTEXT).digest('hex')
}

// Constant-time string compare — hash both sides first so lengths always match.
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

// True only when the request carries a valid Bearer token AND the env var is
// set — fails closed if APP_PASSWORD is missing.
export function verifyRequest(req) {
  const expected = makeToken()
  if (!expected) return false
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return false
  return safeEqual(token, expected)
}
