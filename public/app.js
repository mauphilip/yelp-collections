// ── Auth ──────────────────────────────────────────────────────────────────────
// The login page exchanges the password for a server-derived token (stored in
// yc_auth). Every write and every Yelp-proxy call sends it as a Bearer header.
// Legacy value '1' (pre-auth deploys) is treated as absent → forces re-login.

export function authHeaders() {
  const token = localStorage.getItem('yc_auth')
  if (!token || token === '1') return {}
  return { Authorization: `Bearer ${token}` }
}

// Server said our token is bad/missing → clear it and send the user to login.
function handleAuthFailure() {
  localStorage.removeItem('yc_auth')
  location.replace('login.html')
}

// ── Error toast ───────────────────────────────────────────────────────────────
// Small fixed banner so failed background writes are never silent.

export function notifyError(msg) {
  let el = document.getElementById('yc-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'yc-toast'
    el.style.cssText = 'position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);z-index:99999;' +
      'background:var(--ink,#161616);color:var(--bg,#F4F4EF);border:1.5px solid var(--ink,#161616);' +
      'border-radius:4px;box-shadow:0 3px 0 rgba(22,22,22,.85);padding:.6rem 1rem;font-size:.84rem;' +
      'font-weight:600;max-width:90vw;display:none;'
    document.body.appendChild(el)
  }
  el.textContent = '⚠ ' + msg
  el.style.display = 'block'
  clearTimeout(el._hideTimer)
  el._hideTimer = setTimeout(() => { el.style.display = 'none' }, 6000)
}

// POST to /api/collection with auth + 401 handling. Throws on non-OK.
async function apiPost(payload) {
  const res = await fetch('/api/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
  })
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}))
    if (body.error === 'auth_required') { handleAuthFailure(); throw new Error('auth required') }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

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
  const res = await fetch('/api/yelp?path=/businesses/search&term=restaurant&location=los+angeles&limit=1', { headers: authHeaders() })
  const info = saveRateInfo(res.headers)
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}))
    if (body.error === 'auth_required') { handleAuthFailure(); throw new Error('auth required') }
    throw new Error('API key missing or invalid')
  }
  if (res.status === 429) throw new Error('Rate limited right now')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return info
}

// ── Yelp API liveness (post-trial detection) ──────────────────────────────────
// One canary call, cached 24h, so admin can grey out Yelp-dependent features
// once the trial key dies instead of letting every button error cryptically.

const ALIVE_KEY = 'yelp_alive'

export async function checkYelpAlive(force = false) {
  try {
    const cached = JSON.parse(localStorage.getItem(ALIVE_KEY) || 'null')
    if (!force && cached && Date.now() - cached.ts < 24 * 3_600_000) return cached.ok
  } catch {}
  let ok
  try {
    const res = await fetch('/api/yelp?path=/businesses/search&term=cafe&location=los+angeles&limit=1', { headers: authHeaders() })
    saveRateInfo(res.headers)
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}))
      if (body.error === 'auth_required') { handleAuthFailure(); return true } // app auth, not Yelp death
      ok = false // Yelp key invalid/expired
    } else {
      ok = res.ok || res.status === 429 // rate-limited still means the key works
    }
  } catch {
    // Network failure is inconclusive — don't cry wolf, keep last known state
    try { return JSON.parse(localStorage.getItem(ALIVE_KEY) || 'null')?.ok ?? true } catch { return true }
  }
  try { localStorage.setItem(ALIVE_KEY, JSON.stringify({ ok, ts: Date.now() })) } catch {}
  return ok
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
  const res = await fetch(`/api/yelp?${qs}`, { headers: authHeaders() })
  const rateInfo = saveRateInfo(res.headers)

  if (res.status === 429) {
    const body = await res.json().catch(() => ({}))
    const retryAfter = parseInt(body.retryAfter || '60', 10)
    return { data: null, rateInfo, status: 429, retryAfter }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    if (res.status === 401 && err.error === 'auth_required') { handleAuthFailure() }
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
// Never throws — on failure it returns an empty collection and shows a visible
// error banner instead of leaving the page blank.
export async function initCollection() {
  try {
    const res = await fetch('/api/collection')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { businesses, tagMeta } = await res.json()
    _cache = businesses || []
    _tagMeta = tagMeta || {}
  } catch (err) {
    console.error('initCollection failed:', err)
    _cache = _cache || []
    _tagMeta = _tagMeta || {}
    notifyError("Couldn't load your collection — the server may be down. Showing nothing rather than stale data; reload to retry.")
  }
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
  persist({ action: 'setTagMeta', tagMeta: _tagMeta }, 'Tag color')
}

export async function setTagListMeta(tag, patch) {
  _tagMeta = { ..._tagMeta, [tag]: { ...(_tagMeta[tag] || {}), ...patch } }
  await apiPost({ action: 'setTagMeta', tagMeta: _tagMeta })
}

export function removeTagMeta(tag) {
  const meta = { ..._tagMeta }
  delete meta[tag]
  _tagMeta = meta
  persist({ action: 'setTagMeta', tagMeta: _tagMeta }, 'Tag delete')
}

// Import history
export async function getImports() {
  const res = await fetch('/api/collection')
  const { imports } = await res.json()
  return imports || []
}

export function saveImport(id, label, counts) {
  persist({ action: 'saveImport', id, label, counts, timestamp: Date.now() }, 'Import history')
}

export async function getImportQueue() {
  const res = await fetch('/api/collection')
  const { queue } = await res.json()
  return queue
}

export function setImportQueue(queue) {
  persist({ action: 'setImportQueue', queue }, 'Import queue')
}

// Updates the in-memory cache + notifies listeners (no server write).
function saveLocal(list) {
  _cache = list
  window.dispatchEvent(new CustomEvent('collection-updated'))
}

// Background-persist helper — surfaces failures as a toast instead of
// silently losing the write in the console.
function persist(payload, what = 'Save') {
  apiPost(payload).catch(err => {
    console.error('KV write failed:', err)
    notifyError(`${what} failed — your change may not be saved. Check your connection and retry.`)
  })
}

// Writes cache synchronously, fires whole-list KV write in background.
// Use ONLY for bulk/multi-business mutations — single-business edits go
// through targeted action:'update'/'add'/'remove' to avoid clobbering
// concurrent edits from another tab/device with a stale full list.
function saveCollection(list) {
  saveLocal(list)
  persist({ action: 'set', businesses: list })
}

// ── Backup / Restore ──────────────────────────────────────────────────────────

export function exportBackup() {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    businesses: loadCollection(),
    tagMeta: getTagMeta(),
  }
}

// Replaces the whole collection + tag meta. AWAITED — a restore must not be
// fire-and-forget; throws if either write fails.
export async function replaceCollection(businesses, tagMeta = {}) {
  _cache = businesses
  _tagMeta = tagMeta
  window.dispatchEvent(new CustomEvent('collection-updated'))
  await apiPost({ action: 'set', businesses })
  await apiPost({ action: 'setTagMeta', tagMeta })
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
  const record = {
    ...biz,
    not_found: false,  // explicit — server 'update' merges over a stub's not_found:true
    custom_image: existing?.custom_image || '',
    tags: tagList,
    status: existing?.status || 'want',
    notes: existing?.notes || '',
    saved_at: existing?.saved_at || Date.now(),
    import_id: import_id || '',
    import_date: import_id ? Date.now() : null,
    closed_status: null,
  }
  base.push(record)
  saveLocal(base)
  if (existing) {
    // Stub replacement rewrites the record in place server-side
    persist({ action: 'update', id: biz.id, patch: record }, 'Import')
  } else {
    persist({ action: 'add', business: record }, 'Import')
  }
}

// Saves a minimal stub when a business can't be fetched — flagged for cleanup.
export function saveStubBusiness(id, collectionName = '') {
  const list = loadCollection()
  if (list.find(b => b.id === id)) return
  const stub = {
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
  }
  list.push(stub)
  saveLocal(list)
  persist({ action: 'add', business: stub }, 'Import')
}

export function removeBusiness(id) {
  saveLocal(loadCollection().filter(b => b.id !== id))
  persist({ action: 'remove', id }, 'Remove')
}

export function updateBusiness(id, patch) {
  const list = loadCollection()
  const idx = list.findIndex(b => b.id === id)
  if (idx === -1) return
  list[idx] = { ...list[idx], ...patch }
  saveLocal(list)
  // Targeted patch — server merges into the stored record, so a concurrent
  // edit to a DIFFERENT business from another device can't be clobbered.
  persist({ action: 'update', id, patch }, 'Update')
}

export function addTag(id, tag) {
  const list = loadCollection()
  const b = list.find(b => b.id === id)
  if (!b || b.tags.includes(tag)) return
  b.tags = [...b.tags, tag]
  saveLocal(list)
  persist({ action: 'update', id, patch: { tags: b.tags } }, 'Tag')
}

export function removeTag(id, tag) {
  const list = loadCollection()
  const b = list.find(b => b.id === id)
  if (!b) return
  b.tags = b.tags.filter(t => t !== tag)
  saveLocal(list)
  persist({ action: 'update', id, patch: { tags: b.tags } }, 'Tag')
}

export function getAllTags() {
  const fromBiz = loadCollection().flatMap(b => b.tags || [])
  const fromMeta = Object.keys(_tagMeta)
  return [...new Set([...fromBiz, ...fromMeta])].sort()
}

export function getAllCities() {
  return [...new Set(loadCollection().map(b => b.location?.city).filter(Boolean))].sort()
}

export function getCollectionStats() {
  const list = loadCollection().filter(b => !b.not_found)
  const want = list.filter(b => b.status === 'want').length
  const been = list.filter(b => b.status === 'been').length
  const skip = list.filter(b => b.status === 'skip').length
  const closed = list.filter(b => b.closed_status === 'closed').length
  const prices = { '$': 0, '$$': 0, '$$$': 0, '$$$$': 0, '?': 0 }
  for (const b of list) prices[b.price || '?'] = (prices[b.price || '?'] || 0) + 1
  const catCounts = {}
  for (const b of list) for (const c of b.categories || []) catCounts[c.title] = (catCounts[c.title] || 0) + 1
  const topCats = Object.entries(catCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const cityCounts = {}
  for (const b of list) { const c = b.location?.city; if (c) cityCounts[c] = (cityCounts[c] || 0) + 1 }
  const topCities = Object.entries(cityCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)
  return { total: list.length, want, been, skip, closed, prices, topCats, topCities }
}

// ── Closed Business Checker ───────────────────────────────────────────────────
// No artificial stagger — goes as fast as the API allows.
// On 429, waits for Yelp's retryAfter then continues.

export async function checkClosedBusinesses(onProgress, onDone) {
  const list = loadCollection()
  const expired = list.filter(b => !b.not_found && !isManual(b) && !cacheGet('biz_' + b.id))
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

export function filterAndSort(list, { tags, price, minRating, status, sortBy, showClosed, showSkip, openNow, hasTags, maxDistanceMiles, cities }) {
  let out = [...list]
  if (!showClosed) out = out.filter(b => b.closed_status !== 'closed')
  if (!showSkip && !status) out = out.filter(b => b.status !== 'skip')
  if (openNow)     out = out.filter(b => isOpenNow(b) === true)
  if (hasTags)     out = out.filter(b => b.tags?.length > 0)
  if (tags && tags.length) out = out.filter(b => tags.every(t => b.tags.includes(t)))
  if (price && price.length) out = out.filter(b => price.includes(b.price))
  if (minRating) out = out.filter(b => b.rating >= minRating)
  if (status) out = out.filter(b => b.status === status)
  if (cities && cities.length) out = out.filter(b => cities.includes(b.location?.city))

  const refLat = window._filterLat ?? window._userLat
  const refLng = window._filterLng ?? window._userLng
  if (maxDistanceMiles && refLat != null) {
    out = out.filter(b => {
      const { latitude, longitude } = b.coordinates || {}
      if (!latitude || !longitude) return false
      return haversineMiles(refLat, refLng, latitude, longitude) <= maxDistanceMiles
    })
  }

  if (sortBy === 'rating') out.sort((a, b) => b.rating - a.rating)
  else if (sortBy === 'name') out.sort((a, b) => a.name.localeCompare(b.name))
  else if (sortBy === 'saved') out.sort((a, b) => b.saved_at - a.saved_at)
  else if (sortBy === 'distance' && refLat != null) {
    out.sort((a, b) => haversineMiles(refLat, refLng, a.coordinates?.latitude, a.coordinates?.longitude)
                     - haversineMiles(refLat, refLng, b.coordinates?.latitude, b.coordinates?.longitude))
  }
  return out
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  if (!lat2 || !lng2) return Infinity
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

export async function geocodeZip(zip) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zip)}&countrycodes=us&format=json`)
  if (!res.ok) throw new Error(`Geocode request failed: ${res.status}`)
  const data = await res.json()
  if (!data.length) throw new Error('ZIP code not found')
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
}

// ── Tag Suggestions ───────────────────────────────────────────────────────────

export function getSuggestedTags(businesses, existingTags) {
  const tagLower = (existingTags || []).map(t => t.toLowerCase())
  const counts = {}
  for (const biz of businesses) {
    for (const cat of (biz.categories || [])) {
      const title = cat.title
      if (!title) continue
      const tl = title.toLowerCase()
      // Skip if already covered by an existing tag (fuzzy)
      const covered = tagLower.some(t => t.includes(tl) || tl.includes(t))
      if (covered) continue
      counts[title] = (counts[title] || 0) + 1
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count, keywords: category }))
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

// Sanitize a stored color before injecting into an inline style attribute.
// Only hex colors pass through; anything else (including CSS injection
// attempts like "red;background:url(...)") falls back.
export function safeColor(c, fallback = 'var(--text-subtle)') {
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback
}

// Manually-entered business (no Yelp record behind it) — skip Yelp API
// batch features for these (closed check, refresh hours, freshness sync).
export function isManual(biz) {
  return biz.manual === true || String(biz.id).startsWith('manual-')
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
    persist({ action: 'setTagMeta', tagMeta: _tagMeta }, 'Tag rename')
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

// ── Yelp Data Sync ────────────────────────────────────────────────────────
// Fields sourced from Yelp API — safe to overwrite with fresh data.
// Excludes rating/review_count (change constantly, not meaningful to patch).
export const YELP_PATCH_FIELDS = [
  'name', 'price', 'categories', 'location', 'coordinates',
  'phone', 'display_phone', 'hours', 'transactions',
]

// Returns array of { field, oldVal, newVal } for any changed fields.
export function diffYelpFields(stored, fresh) {
  const diffs = []
  for (const field of YELP_PATCH_FIELDS) {
    if (JSON.stringify(stored[field] ?? null) !== JSON.stringify(fresh[field] ?? null)) {
      diffs.push({ field, oldVal: stored[field], newVal: fresh[field] })
    }
  }
  // is_closed maps to closed_status
  if (fresh.is_closed !== undefined) {
    const freshStatus = fresh.is_closed ? 'closed' : 'open'
    const knownStatus = stored.closed_status && !['unknown', 'not_found'].includes(stored.closed_status)
    if (knownStatus && stored.closed_status !== freshStatus) {
      diffs.push({ field: 'closed_status', oldVal: stored.closed_status, newVal: freshStatus })
    }
  }
  return diffs
}

// Returns a new business object with fresh Yelp fields merged in,
// preserving all user fields (tags, status, notes, custom_image, saved_at, etc.).
export function applyYelpPatch(stored, fresh) {
  const patched = { ...stored }
  for (const field of YELP_PATCH_FIELDS) {
    if (fresh[field] !== undefined) patched[field] = fresh[field]
  }
  if (fresh.is_closed !== undefined) patched.closed_status = fresh.is_closed ? 'closed' : 'open'
  return patched
}

// Applies multiple Yelp patches in a single KV write.
// patches: [{ id, fresh }] where fresh is the new Yelp API response.
export function batchPatchCollection(patches) {
  const list = loadCollection()
  let changed = false
  for (const { id, fresh } of patches) {
    const idx = list.findIndex(b => b.id === id)
    if (idx === -1) continue
    list[idx] = applyYelpPatch(list[idx], fresh)
    changed = true
  }
  if (changed) saveCollection(list)
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
