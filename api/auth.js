// Vercel serverless function — exchanges the app password for an API token.
// The password is checked server-side against APP_PASSWORD; the client never
// ships with it embedded. Fails closed (503) when the env var is unset.

import { makeToken, safeEqual } from './_auth.js'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const secret = process.env.APP_PASSWORD
  if (!secret) {
    return res.status(503).json({ error: 'Server password not configured' })
  }

  const { password } = req.body || {}
  if (!password || !safeEqual(password, secret)) {
    return res.status(401).json({ error: 'Invalid password' })
  }

  return res.status(200).json({ token: makeToken() })
}
