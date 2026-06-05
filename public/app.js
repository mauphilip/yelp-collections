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

export function getRateInfo() { return loadRateInfo() }

// Makes a minimal 1-call ping to Yelp to get fresh rate limit headers.
// Returns { remaining, dailyLimit, resetTime, updated } or throws.
export async function checkYelpRateLimit() {
  const res = await fetch('/api/yelp?path=/businesses/search&term=restaurant&location=los+angeles&limit=1')
  const info = saveRateInfo(res.headers)
  if (res.status === 401) throw new Error('API key missing or invalid')
  if (res.status === 429) throw new Error('Rate limited right now')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return info
}

// ── API Cache (24h for search results, 7d for business status) ────────────────
// Kept in localStorage — ephemeral, no need to persist across devices.

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

// ── Collections Store (Vercel KV via /api/collection) ─────────────────────────
// In-memory cache: loaded once per page load, mutations update cache synchronously
// and write to KV in the background (fire-and-forget). No page reload needed.
//
// Stored shape — full Yelp API response plus our custom fields:
//   { ...yelpApiFields, custom_image, tags, status, notes, saved_at, closed_status }

let _cache = null
let _tagMeta = {}

// Call once on page load before rendering. Populates the in-memory cache from KV.
export async function initCollection() {
  const res = await fetch('/api/collection')
  const { businesses, tagMeta } = await res.json()
  _cache = businesses
  _tagMeta = tagMeta || {}
  return _cache
}

// Synchronous after initCollection() has been called.
export function loadCollection() {
  return _cache || []
}

// Tag metadata — { "tagName": { color: "#hex" } }
export function getTagMeta() { return _tagMeta }

export function setTagColor(tag, color) {
  _tagMeta = { ..._tagMeta, [tag]: { ...(_tagMeta[tag] || {}), color } }
  fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTagMeta', tagMeta: _tagMeta }),
  }).catch(console.error)
}

export function removeTagMeta(tag) {
  const meta = { ..._tagMeta }
  delete meta[tag]
  _tagMeta = meta
  fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setTagMeta', tagMeta: _tagMeta }),
  }).catch(console.error)
}

// Import history
export async function getImports() {
  const res = await fetch('/api/collection')
  const { imports } = await res.json()
  return imports || []
}

export function saveImport(id, label, counts) {
  fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'saveImport', id, label, counts, timestamp: Date.now() }),
  }).catch(console.error)
}

export async function getImportQueue() {
  const res = await fetch('/api/collection')
  const { queue } = await res.json()
  return queue
}

export function setImportQueue(queue) {
  fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setImportQueue', queue }),
  }).catch(console.error)
}

// Writes cache synchronously, fires KV write in background.
function saveCollection(list) {
  _cache = list
  window.dispatchEvent(new CustomEvent('collection-updated'))
  fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set', businesses: list }),
  }).catch(err => console.error('KV write failed:', err))
}

// Stores the full Yelp API response plus our custom fields.
// If the ID already exists as a stub (not_found), replaces it with the real data.
export function saveBusiness(biz, tags = [], collectionName = '', import_id = '') {
  const list = loadCollection()
  const existing = list.find(b => b.id === biz.id)
  if (existing && !existing.not_found) return  // already properly imported
  // Remove stub if present so we can replace it cleanly
  const base = existing ? list.filter(b => b.id !== biz.id) : list
  const preservedTags = existing?.tags || []
  const tagList = [...new Set([...preservedTags, ...tags, ...(collectionName ? [collectionName] : [])])]
  base.push({
    ...biz,
    custom_image: existing?.custom_image || '',
    tags: tagList,
    status: existing?.status || 'want',
    notes: existing?.notes || '',
    saved_at: existing?.saved_at || Date.now(),
    import_id: import_id || '',
    import_date: import_id ? Date.now() : null,
    closed_status: null,
  })
  saveCollection(base)
}

// Saves a minimal stub when a business can't be fetched — flagged for cleanup.
export function saveStubBusiness(id, collectionName = '') {
  const list = loadCollection()
  if (list.find(b => b.id === id)) return
  list.push({
    id,
    name: id,
    url: `https://www.yelp.com/biz/${id}`,
    image_url: '',
    not_found: true,
    custom_image: '',
    tags: collectionName ? [collectionName] : [],
    status: 'want',
    notes: '',
    saved_at: Date.now(),
    closed_status: 'not_found',
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
  const fromBiz = loadCollection().flatMap(b => b.tags || [])
  const fromMeta = Object.keys(_tagMeta)
  return [...new Set([...fromBiz, ...fromMeta])].sort()
}

// ── Closed Business Checker ───────────────────────────────────────────────────
// No artificial stagger — goes as fast as the API allows.
// On 429, waits for Yelp's retryAfter then continues.

export async function checkClosedBusinesses(onProgress, onDone) {
  const list = loadCollection()
  const expired = list.filter(b => !b.not_found && !cacheGet('biz_' + b.id))
  let checked = 0
  const closed = []

  for (const b of expired) {
    try {
      const result = await yelpFetch(`/businesses/${b.id}`)
      if (result.status === 429) {
        onProgress && onProgress(checked, expired.length, b, `Rate limited — waiting ${result.retryAfter}s…`)
        await new Promise(r => setTimeout(r, result.retryAfter * 1000))
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
    await new Promise(r => setTimeout(r, 500))
  }

  const alreadyClosed = list.filter(b => b.closed_status === 'closed' && !expired.find(e => e.id === b.id))
  onDone && onDone([...closed, ...alreadyClosed])
}

// ── Filtering & Sorting ───────────────────────────────────────────────────────

// Returns true (open), false (closed), or null (no hours data)
export function isOpenNow(biz) {
  if (!biz.hours?.[0]?.open?.length) return null
  const now  = new Date()
  // Yelp day: 0 = Monday … 6 = Sunday; JS: 0 = Sunday
  const day  = (now.getDay() + 6) % 7
  const time = String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0')
  return biz.hours[0].open.some(s => {
    if (s.day !== day) return false
    return s.is_overnight ? (time >= s.start || time < s.end) : (time >= s.start && time < s.end)
  })
}

export function filterAndSort(list, { tags, price, minRating, status, sortBy, showClosed, openNow }) {
  let out = [...list]
  if (!showClosed) out = out.filter(b => b.closed_status !== 'closed')
  if (openNow)     out = out.filter(b => isOpenNow(b) === true)
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

export async function geocodeZip(zip) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&countrycodes=us&format=json`)
  if (!res.ok) throw new Error(`Geocode request failed: ${res.status}`)
  const data = await res.json()
  if (!data.length) throw new Error('ZIP code not found')
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
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

// ── Global tag operations ─────────────────────────────────────────────────────

export function renameTagGlobal(oldTag, newTag) {
  const list = loadCollection()
  let changed = false
  for (const b of list) {
    if (!b.tags?.includes(oldTag)) continue
    b.tags = [...new Set(b.tags.map(t => t === oldTag ? newTag : t))]
    changed = true
  }
  if (changed) saveCollection(list)
  // Move tag meta to new name
  if (_tagMeta[oldTag]) {
    _tagMeta = { ..._tagMeta, [newTag]: _tagMeta[oldTag] }
    delete _tagMeta[oldTag]
    fetch('/api/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setTagMeta', tagMeta: _tagMeta }),
    }).catch(console.error)
  }
}

export function deleteTagGlobal(tag) {
  const list = loadCollection()
  let changed = false
  for (const b of list) {
    if (!b.tags?.includes(tag)) continue
    b.tags = b.tags.filter(t => t !== tag)
    changed = true
  }
  if (changed) saveCollection(list)
  removeTagMeta(tag)
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
