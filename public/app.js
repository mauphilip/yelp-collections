// ── Rate Limit Tracking (reads Yelp's actual headers, no artificial caps) ─────
// We don't throttle ourselves — Yelp enforces their own limits. We just track
// what they tell us so we can display remaining calls and handle 429s properly.

const RATE_KEY = 'yelp_rate'

function saveRateInfo(headers) {
  const info = {
    dailyLimit: headers.get('RateLimit-DailyLimit'),
    remaining: headers.get('RateLimit-Remaining'),
    resetTime: headers.get('RateLimit-ResetTime'),
    updated: Date.now(),
  }
  try { localStorage.setItem(RATE_KEY, JSON.stringify(info)) } catch {}
  return info
}

function loadRateInfo() {
  try { return JSON.parse(localStorage.getItem(RATE_KEY)) || {} } catch { return {} }
}

export function rateLimitStatus() {
  const info = loadRateInfo()
  if (!info.dailyLimit) return 'No rate info yet'
  return `${info.remaining}/${info.dailyLimit} calls remaining today`
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

// Returns { data, rateInfo, status }. On 429, returns retryAfter in seconds.
export async function yelpFetch(path, params = {}) {
  const qs = new URLSearchParams({ path, ...params }).toString()
  const res = await fetch(`/api/yelp?${qs}`)
  const rateInfo = saveRateInfo(res.headers)

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    const retryAfter = parseInt(body.retryAfter || '60', 10)
    return { data: null, rateInfo, status: 429, retryAfter }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }

  const data = await res.json()
  return { data, rateInfo, status: 200 }
}

export async function searchBusinesses(params) {
  const cacheKey = 'search_' + JSON.stringify(params)
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const { data, status, retryAfter } = await yelpFetch('/businesses/search', params)
  if (status === 429) throw new Error(`Rate limited — retry in ${retryAfter}s`)
  cacheSet(cacheKey, data, CACHE_TTL.search)
  return data
}

export async function getBusinessStatus(id) {
  const cacheKey = 'biz_' + id
  const cached = cacheGet(cacheKey)
  if (cached) return cached
  const { data, status, retryAfter } = await yelpFetch(`/businesses/${id}`)
  if (status === 429) throw new Error(`Rate limited — retry in ${retryAfter}s`)
  const bizStatus = {
    id: data.id,
    name: data.name,
    is_closed: data.is_closed,
    hours: data.hours,
    coordinates: data.coordinates,
  }
  cacheSet(cacheKey, bizStatus, CACHE_TTL.status)
  return bizStatus
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
    custom_image: '',  // user-set thumbnail override
    website: biz.url ? biz.url : '',  // business website from Yelp (if available)
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
// No artificial stagger — goes as fast as the API allows.
// On 429, waits for Yelp's retryAfter then continues.

export async function checkClosedBusinesses(onProgress, onDone) {
  const list = loadCollection()
  const expired = list.filter(b => !cacheGet('biz_' + b.id))
  let checked = 0
  const closed = []

  for (const b of expired) {
    try {
      const result = await yelpFetch(`/businesses/${b.id}`)
      if (result.status === 429) {
        onProgress && onProgress(checked, expired.length, b, `Rate limited — waiting ${result.retryAfter}s…`)
        await new Promise(r => setTimeout(r, result.retryAfter * 1000))
        // Retry once after waiting
        const retry = await yelpFetch(`/businesses/${b.id}`)
        if (retry.status === 429) {
          updateBusiness(b.id, { closed_status: 'unknown' })
        } else {
          const status = retry.data
          cacheSet('biz_' + b.id, status, CACHE_TTL.status)
          updateBusiness(b.id, { closed_status: status.is_closed ? 'closed' : 'open' })
          if (status.is_closed) closed.push(b)
        }
      } else {
        const status = result.data
        cacheSet('biz_' + b.id, status, CACHE_TTL.status)
        updateBusiness(b.id, { closed_status: status.is_closed ? 'closed' : 'open' })
        if (status.is_closed) closed.push(b)
      }
    } catch {
      updateBusiness(b.id, { closed_status: 'unknown' })
    }
    checked++
    onProgress && onProgress(checked, expired.length, b)
    // Small courtesy delay to avoid hammering — 500ms, not minutes
    await new Promise(r => setTimeout(r, 500))
  }

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

// Get display image (custom override or Yelp original)
export function getDisplayImage(biz) {
  return biz.custom_image || biz.image_url || ''
}

// ── Bulk Operations ──────────────────────────────────────────────────────────

export function bulkSetStatus(ids, status) {
  const list = loadCollection()
  let changed = false
  for (const b of list) {
    if (ids.includes(b.id) && b.status !== status) {
      b.status = status
      changed = true
    }
  }
  if (changed) saveCollection(list)
}

export function bulkAddTag(ids, tag) {
  const list = loadCollection()
  let changed = false
  for (const b of list) {
    if (ids.includes(b.id) && !b.tags.includes(tag)) {
      b.tags.push(tag)
      changed = true
    }
  }
  if (changed) saveCollection(list)
}

export function bulkRemoveTag(ids, tag) {
  const list = loadCollection()
  let changed = false
  for (const b of list) {
    if (ids.includes(b.id) && b.tags.includes(tag)) {
      b.tags = b.tags.filter(t => t !== tag)
      changed = true
    }
  }
  if (changed) saveCollection(list)
}

export function bulkRemove(ids) {
  saveCollection(loadCollection().filter(b => !ids.includes(b.id)))
}

// ── Rich Notes Rendering ─────────────────────────────────────────────────────
// Simple markdown-lite: lines starting with - or * become list items,
// blank lines become paragraph breaks.

export function renderNotes(text) {
  if (!text) return ''
  const lines = text.split('\n')
  let html = ''
  let inList = false

  for (const line of lines) {
    const trimmed = line.trim()
    const isListItem = /^[-*•]\s+/.test(trimmed)

    if (isListItem) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${escapeHtml(trimmed.replace(/^[-*•]\s+/, ''))}</li>`
    } else {
      if (inList) { html += '</ul>'; inList = false }
      if (trimmed === '') {
        html += ''
      } else {
        html += `<p>${escapeHtml(trimmed)}</p>`
      }
    }
  }
  if (inList) html += '</ul>'
  return html
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
