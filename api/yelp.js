// Vercel serverless function — Yelp Fusion API proxy
// API key stays server-side; client never sees it.
// Server enforces a secondary rate limit as a safety net on top of client-side limiting.

const YELP_BASE = 'https://api.yelp.com/v3'

// In-memory sliding window (resets on cold start, but client-side limiter is the primary guard)
const requestLog = []
const SERVER_LIMIT_PER_MIN = 10  // generous; client already caps at 5

function isServerRateLimited() {
  const now = Date.now()
  const cutoff = now - 60_000
  while (requestLog.length && requestLog[0] < cutoff) requestLog.shift()
  if (requestLog.length >= SERVER_LIMIT_PER_MIN) return true
  requestLog.push(now)
  return false
}

// Allowed Yelp API paths this proxy will forward to
const ALLOWED_PATHS = [
  /^\/businesses\/search$/,
  /^\/businesses\/[A-Za-z0-9_-]+$/,
  /^\/users\/[A-Za-z0-9_-]+\/collections$/,
  /^\/collections\/[A-Za-z0-9_-]+\/businesses$/,
]

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const apiKey = process.env.YELP_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'YELP_API_KEY not configured' })
  }

  if (isServerRateLimited()) {
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a moment.' })
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

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: body.error?.description || 'Yelp API error', yelp: body })
    }

    // Required by Yelp ToS: do not cache responses beyond 24h (we enforce that client-side)
    res.setHeader('X-Yelp-Attribution', 'true')
    return res.status(200).json(body)
  } catch (err) {
    return res.status(502).json({ error: 'Failed to reach Yelp API', detail: err.message })
  }
}
