// ── Rate Limiter (persisted across sessions/restarts) ─────────────────────────
// State stored in localStorage so a page reload or app restart never causes a burst.

const RATE_KEY = 'yelp_rate'
const RATE_LIMITS = { minute: { max: 5, window: 60_000 }, hour: { max: 50, window: 3_600_000 } }

function loadRate() {
  try { return JSON.parse(localStorage.getItem(RATE_KEY)) || {} } catch { return {} }
}
function saveRate(state) { localStorage.setItem(RATE_KEY, JSON.stringify(state)) }

function checkAndRecord() {
  const now = Date.now()
  const state = loadRate()
  for (const [key, cfg] of Object.entries(RATE_LIMITS)) {
    if (!state[key] || now - state[key].start >= cfg.window) {
      state[key] = { start: now, count: 0 }
    }
    if (state[key].count >= cfg.max) {
      const wait = Math.ceil((cfg.window - (now - state[key].start)) / 1000)
      saveRate(state)
      throw new Error(`Rate limit: too many requests. Try again in ${wait}s.`)
    }
  }
  for (const key of Object.keys(RATE_LIMITS)) state[key].count++
  saveRate(state)
}

function rateLimitStatus() {
  const now = Date.now()
  const state = loadRate()
  return Object.entries(RATE_LIMITS).map(([key, cfg]) => {
    const s = state[key] || { start: now, count: 0 }
    const remaining = cfg.max - (now - s.start < cfg.window ? s.count : 0)
    return `${remaining}/${cfg.max} per ${key}`
  }).join(' · ')
}

// ── API Cache (24h for search results, 7d for business status) ────────────────

const CACHE_TTL = { search: 24 * 3_600_000, status: 7 * 24 * 3_600_000 }

function cacheGet(key) {
  try {
    const raw = localStorage.getItem('yc_' + key)
    if (!raw) return null
    const { ts, data, ttl } = JSON.parse(raw)
    if (Date.now() - ts > ttl) { localStorage.removeItem('yc_' + key); return null }
    return data
  } catch { return null }
}

function cacheSet(key, data, ttl) {
  try { localStorage.setItem('yc_' + key, JSON.stringify({ ts: Date.now(), data, ttl })) } catch {}
}

// ── Yelp API calls ────────────────────────────────────────────────────────────

async function yelpFetch(path, params = {}) {
  checkAndRecord()  // throws if rate limited
  const qs = new URLSearchParams({ path, ...params }).toString()
  const res = await fetch(`/api/yelp?${qs}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function searchBusinesses(params) {
  const cacheKey = 'search_' + JSON.stringify(params)
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const data = await yelpFetch('/businesses/search', params)
  cacheSet(cacheKey, data, CACHE_TTL.search)
  return data
}

export async function getBusinessStatus(id) {
  const cacheKey = 'biz_' + id
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const data = await yelpFetch(`/businesses/${id}`)
  // Store only the fields we need for status checks
  const status = {
    id: data.id,
    name: data.name,
    is_closed: data.is_closed,
    hours: data.hours,
    coordinates: data.coordinates,
  }
  cacheSet(cacheKey, status, CACHE_TTL.status)
  return status
}

// ── Collections Store (localStorage) ─────────────────────────────────────────
// A "saved business" object looks like:
// { id, name, url, image_url, rating, review_count, price, categories,
//   coordinates, location, tags: [], status: 'want'|'been', notes: '', saved_at }

const STORE_KEY = 'yelp_collections'

export function loadCollection() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || [] } catch { return [] }
}

function saveCollection(list) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list))
  window.dispatchEvent(new CustomEvent('collection-updated'))
}

export function saveBusiness(biz, tags = [], collectionName = '') {
  const list = loadCollection()
  if (list.find(b => b.id === biz.id)) return  // already saved
  const tagList = collectionName ? [...new Set([...tags, collectionName])] : tags
  list.push({
    id: biz.id,
    name: biz.name,
    url: biz.url,
    image_url: biz.image_url,
    rating: biz.rating,
    review_count: biz.review_count,
    price: biz.price || '',
    categories: biz.categories || [],
    coordinates: biz.coordinates,
    location: biz.location,
    tags: tagList,
    status: 'want',
    notes: '',
    saved_at: Date.now(),
    closed_status: null,  // populated later by status checker
  })
  saveCollection(list)
}

export function removeBusiness(id) {
  saveCollection(loadCollection().filter(b => b.id !== id))
}

export function updateBusiness(id, patch) {
  const list = loadCollection()
  const idx = list.findIndex(b => b.id === id)
  if (idx === -1) return
  list[idx] = { ...list[idx], ...patch }
  saveCollection(list)
}

export function addTag(id, tag) {
  const list = loadCollection()
  const b = list.find(b => b.id === id)
  if (!b || b.tags.includes(tag)) return
  b.tags.push(tag)
  saveCollection(list)
}

export function removeTag(id, tag) {
  const list = loadCollection()
  const b = list.find(b => b.id === id)
  if (!b) return
  b.tags = b.tags.filter(t => t !== tag)
  saveCollection(list)
}

export function getAllTags() {
  return [...new Set(loadCollection().flatMap(b => b.tags))].sort()
}

// ── Closed Business Checker ───────────────────────────────────────────────────
// Staggered: 1 request per 2 seconds, skips businesses with fresh cache.
// Calls onProgress(checked, total, business) after each check.
// Calls onDone(closedList) when all done.

export async function checkClosedBusinesses(onProgress, onDone) {
  const list = loadCollection()
  const expired = list.filter(b => !cacheGet('biz_' + b.id))
  let checked = 0
  const closed = []

  for (const b of expired) {
    await new Promise(r => setTimeout(r, 2000))  // stagger requests
    try {
      const status = await getBusinessStatus(b.id)
      updateBusiness(b.id, { closed_status: status.is_closed ? 'closed' : 'open' })
      if (status.is_closed) closed.push(b)
    } catch {
      updateBusiness(b.id, { closed_status: 'unknown' })
    }
    checked++
    onProgress && onProgress(checked, expired.length, b)
  }

  // Also flag ones already known to be closed from previous checks
  const alreadyClosed = list.filter(b => b.closed_status === 'closed' && !expired.find(e => e.id === b.id))
  onDone && onDone([...closed, ...alreadyClosed])
}

// ── Filtering & Sorting ───────────────────────────────────────────────────────

export function filterAndSort(list, { tags, price, minRating, status, sortBy, showClosed }) {
  let out = [...list]
  if (!showClosed) out = out.filter(b => b.closed_status !== 'closed')
  if (tags && tags.length) out = out.filter(b => tags.every(t => b.tags.includes(t)))
  if (price && price.length) out = out.filter(b => price.includes(b.price))
  if (minRating) out = out.filter(b => b.rating >= minRating)
  if (status) out = out.filter(b => b.status === status)

  if (sortBy === 'rating') out.sort((a, b) => b.rating - a.rating)
  else if (sortBy === 'name') out.sort((a, b) => a.name.localeCompare(b.name))
  else if (sortBy === 'saved') out.sort((a, b) => b.saved_at - a.saved_at)
  else if (sortBy === 'distance' && window._userLat) {
    const dist = b => Math.hypot((b.coordinates?.latitude - window._userLat) || 0, (b.coordinates?.longitude - window._userLng) || 0)
    out.sort((a, b) => dist(a) - dist(b))
  }
  return out
}

// ── Random Picker ─────────────────────────────────────────────────────────────

export function pickRandom(list) {
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function starsHtml(rating) {
  const full = Math.floor(rating)
  const half = rating % 1 >= 0.5
  let s = '★'.repeat(full)
  if (half) s += '½'
  return `<span class="stars" title="${rating}">${s}</span>`
}

export function categoryLabel(biz) {
  return (biz.categories || []).map(c => c.title).join(', ')
}

export { rateLimitStatus }
