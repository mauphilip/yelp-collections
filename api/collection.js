// Vercel serverless function — collection + tag meta CRUD backed by Upstash Redis (KV)

const KV_KEY      = 'yelp_collection'
const TAG_META_KEY = 'yelp_tag_meta'
const IMPORTS_KEY  = 'yelp_imports'
const IMPORT_QUEUE_KEY = 'yelp_import_queue'

async function kvRead(key) {
  const res = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
  })
  const { result } = await res.json()
  if (!result) return null
  let parsed = typeof result === 'string' ? JSON.parse(result) : result
  if (typeof parsed === 'string') parsed = JSON.parse(parsed)
  return parsed
}

async function kvWrite(key, data) {
  await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'text/plain',
    },
    body: JSON.stringify(data),
  })
}

async function kvGet()              { return (await kvRead(KV_KEY))              || [] }
async function kvGetTagMeta()       { return (await kvRead(TAG_META_KEY))       || {} }
async function kvGetImports()       { return (await kvRead(IMPORTS_KEY))        || [] }
async function kvGetImportQueue()   { return (await kvRead(IMPORT_QUEUE_KEY))   || null }
async function kvSet(data)          { await kvWrite(KV_KEY, data) }
async function kvSetTagMeta(data)   { await kvWrite(TAG_META_KEY, data) }
async function kvSetImports(data)   { await kvWrite(IMPORTS_KEY, data) }
async function kvSetImportQueue(data) { if (data) await kvWrite(IMPORT_QUEUE_KEY, data); else await kvRead(IMPORT_QUEUE_KEY) && kvWrite(IMPORT_QUEUE_KEY, null) }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')

  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return res.status(500).json({ error: 'KV not configured' })
  }

  // GET — return collection + tag meta + imports + queue
  if (req.method === 'GET') {
    const [businesses, tagMeta, imports, queue] = await Promise.all([
      kvGet(), kvGetTagMeta(), kvGetImports(), kvGetImportQueue()
    ])
    return res.status(200).json({ businesses, tagMeta, imports, queue })
  }

  // POST — mutations
  if (req.method === 'POST') {
    const body = req.body || {}
    const { action } = body

    if (action === 'set') {
      await kvSet(body.businesses || [])
      return res.status(200).json({ ok: true })
    }
    if (action === 'add') {
      const list = await kvGet()
      if (!list.find(b => b.id === body.business?.id)) {
        list.push(body.business); await kvSet(list)
      }
      return res.status(200).json({ ok: true })
    }
    if (action === 'update') {
      const list = await kvGet()
      const idx = list.findIndex(b => b.id === body.id)
      if (idx !== -1) { list[idx] = { ...list[idx], ...body.patch }; await kvSet(list) }
      return res.status(200).json({ ok: true })
    }
    if (action === 'remove') {
      const list = await kvGet()
      await kvSet(list.filter(b => b.id !== body.id))
      return res.status(200).json({ ok: true })
    }
    if (action === 'setTagMeta') {
      await kvSetTagMeta(body.tagMeta || {})
      return res.status(200).json({ ok: true })
    }
    if (action === 'getImports') {
      const imports = await kvGetImports()
      return res.status(200).json({ imports })
    }
    if (action === 'saveImport') {
      const imports = await kvGetImports()
      imports.push({
        id: body.id || Date.now().toString(),
        timestamp: body.timestamp || Date.now(),
        label: body.label || '',
        counts: body.counts || { total: 0, success: 0, closed: 0, failed: 0, notfound: 0 },
      })
      await kvSetImports(imports)
      return res.status(200).json({ ok: true })
    }
    if (action === 'setImportQueue') {
      await kvSetImportQueue(body.queue)
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
