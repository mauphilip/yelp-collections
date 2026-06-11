// Vercel serverless function — Yelp Fusion API proxy
// API key stays server-side; client never sees it.
// No artificial rate limiting — Yelp enforces their own limits and we pass
// their rate-limit headers through so the client can handle 429s properly.

import { verifyRequest } from './_auth.js'

const YELP_BASE = 'https://api.yelp.com/v3'

// Allowed Yelp API paths this proxy will forward to
const ALLOWED_PATHS = [
  /^\/businesses\/search$/,
  /^\/businesses\/[^\s/?#]+$/,  // allow Unicode aliases (e.g. shirubē-santa-monica)
]

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // App auth — distinct from a Yelp upstream 401 (which carries body.yelp)
  if (!verifyRequest(req)) {
    return res.status(401).json({ error: 'auth_required' })
  }

  const apiKey = process.env.YELP_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'YELP_API_KEY not configured' })
  }

  // Extract the Yelp path from query param ?path=/businesses/search
  const yelpPath = req.query.path
  if (!yelpPath || !ALLOWED_PATHS.some(re => re.test(yelpPath))) {
    return res.status(400).json({ error: 'Invalid or disallowed path' })
  }

  // Forward remaining query params (everything except 'path') to Yelp
  const forwardParams = { ...req.query }
  delete forwardParams.path
  const qs = new URLSearchParams(forwardParams).toString()
  const url = `${YELP_BASE}${yelpPath}${qs ? '?' + qs : ''}`

  try {
    const upstream = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    })

    const body = await upstream.json()

    // Pass through Yelp's rate limit headers so the client knows where it stands
    const rateLimitHeaders = ['RateLimit-DailyLimit', 'RateLimit-Remaining', 'RateLimit-ResetTime']
    for (const h of rateLimitHeaders) {
      const val = upstream.headers.get(h)
      if (val) res.setHeader(h, val)
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: body.error?.description || 'Yelp API error',
        yelp: body,
        retryAfter: upstream.status === 429
          ? upstream.headers.get('Retry-After') || '60'
          : null,
      })
    }

    res.setHeader('X-Yelp-Attribution', 'true')
    return res.status(200).json(body)
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Yelp API', detail: err.message })
  }
}
