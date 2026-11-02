import { type Context, Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()

// Ensure all unexpected errors return standard JSON: { "error": "message" }
app.onError((err, c) => {
  return c.json({ error: err.message || 'Internal server error' }, 500)
})

async function safeJson<T>(c: Context): Promise<Partial<T>> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// ---------------------------------------------------------------------------
// Homes
// ---------------------------------------------------------------------------
app.post('/api/homes', async (c) => {
  const body = await safeJson<{ name?: unknown }>(c)
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 422)
  }
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)')
    .bind(id, body.name.trim())
    .run()
  return c.json({ id, name: body.name.trim() }, 201)
})

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------
app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const body = await safeJson<{ name?: unknown }>(c)
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return c.json({ error: 'name is required' }, 422)
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, body.name.trim())
    .run()
  return c.json({ id, homeId, name: body.name.trim() }, 201)
})

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------
app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const body = await safeJson<{ title?: unknown; totalCents?: unknown }>(c)
  const { title, totalCents } = body

  // Validate totalCents: must be a positive integer
  if (typeof totalCents !== 'number' || !Number.isInteger(totalCents) || totalCents <= 0) {
    return c.json({ error: 'totalCents must be a positive integer' }, 422)
  }

  // Fetch members in the order they were added
  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY created_at ASC, rowid ASC',
  )
    .bind(homeId)
    .all<{ id: string }>()

  if (members.length === 0) {
    return c.json({ error: 'home has no members' }, 422)
  }

  const billId = crypto.randomUUID()
  const billTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : 'Bill'

  await c.env.DB.prepare('INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)')
    .bind(billId, homeId, billTitle, totalCents)
    .run()

  // Distribute cents: base share + give remainder 1 cent at a time to first members
  const base = Math.floor(totalCents / members.length)
  const remainder = totalCents % members.length

  const shares: { id: string; memberId: string; amountCents: number; paidAt: null }[] = []
  const insertShare = c.env.DB.prepare(
    'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
  )

  const stmts = members.map((member, idx) => {
    const shareId = crypto.randomUUID()
    const amount = base + (idx < remainder ? 1 : 0)
    shares.push({ id: shareId, memberId: member.id, amountCents: amount, paidAt: null })
    return insertShare.bind(shareId, billId, member.id, amount)
  })

  await c.env.DB.batch(stmts)

  return c.json({ id: billId, homeId, title: billTitle, totalCents, shares }, 201)
})

// ---------------------------------------------------------------------------
// Pay a share
// ---------------------------------------------------------------------------
app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const idempotencyKey = c.req.header('Idempotency-Key')

  if (!idempotencyKey || idempotencyKey.trim() === '') {
    return c.json({ error: 'Idempotency-Key header is required' }, 400)
  }

  // Verify bill exists
  const bill = await c.env.DB.prepare('SELECT id FROM bills WHERE id = ?').bind(billId).first()
  if (!bill) return c.json({ error: 'bill not found' }, 404)

  // Fetch share (must belong to this bill)
  const share = await c.env.DB.prepare(
    'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ? AND bill_id = ?',
  )
    .bind(shareId, billId)
    .first<{
      id: string
      member_id: string
      amount_cents: number
      paid_at: string | null
      idempotency_key: string | null
    }>()

  if (!share) return c.json({ error: 'share not found' }, 404)

  // Already paid — check idempotency
  if (share.paid_at !== null) {
    if (share.idempotency_key === idempotencyKey) {
      return c.json({
        id: share.id,
        memberId: share.member_id,
        amountCents: share.amount_cents,
        paidAt: share.paid_at,
      })
    }
    return c.json({ error: 'share already paid with a different key' }, 409)
  }

  // Mark as paid — use conditional UPDATE for concurrency safety (optimistic locking)
  const paidAt = new Date().toISOString()
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, idempotency_key = ? WHERE id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, idempotencyKey, shareId)
    .run()

  if (result.meta.changes === 0) {
    // Another concurrent request updated it first — check idempotency
    const updated = await c.env.DB.prepare(
      'SELECT id, member_id, amount_cents, paid_at, idempotency_key FROM shares WHERE id = ?',
    )
      .bind(shareId)
      .first<{
        id: string
        member_id: string
        amount_cents: number
        paid_at: string | null
        idempotency_key: string | null
      }>()

    if (updated && updated.idempotency_key === idempotencyKey) {
      return c.json({
        id: updated.id,
        memberId: updated.member_id,
        amountCents: updated.amount_cents,
        paidAt: updated.paid_at,
      })
    }
    return c.json({ error: 'share already paid with a different key' }, 409)
  }

  return c.json({
    id: share.id,
    memberId: share.member_id,
    amountCents: share.amount_cents,
    paidAt,
  })
})

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------
app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  const home = await c.env.DB.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  if (!home) return c.json({ error: 'home not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT
       m.id          AS memberId,
       m.name        AS name,
       COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND s.paid_at IS NULL THEN s.amount_cents ELSE 0 END), 0) AS outstandingCents
     FROM members m
     LEFT JOIN shares s ON s.member_id = m.id
                        AND s.bill_id IN (SELECT id FROM bills WHERE home_id = ?)
     WHERE m.home_id = ?
     GROUP BY m.id, m.name, m.created_at, m.rowid
     ORDER BY m.created_at ASC, m.rowid ASC`,
  )
    .bind(homeId, homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()

  return c.json({ balances: results })
})

export default app
