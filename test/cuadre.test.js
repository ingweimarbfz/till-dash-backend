const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'

// Base de datos falsa en memoria con lo mínimo del query builder de supabase-js que usa el cuadre.
const DB = {}
const query = (table) => {
  const filters = []
  let single = false
  const q = {
    select: () => q, order: () => q,
    eq: (c, v) => (filters.push((r) => r[c] === v), q),
    gte: (c, v) => (filters.push((r) => r[c] !== null && new Date(r[c]) >= new Date(v)), q),
    lt: (c, v) => (filters.push((r) => r[c] !== null && new Date(r[c]) < new Date(v)), q),
    is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), q),
    in: (c, vs) => (filters.push((r) => vs.includes(r[c])), q),
    range: () => q,
    maybeSingle: () => ((single = true), q),
    then: (ok, ko) => {
      const rows = (DB[table] || []).filter((r) => filters.every((f) => f(r)))
      return Promise.resolve({ data: single ? rows[0] || null : rows, error: null }).then(ok, ko)
    }
  }
  return q
}
require.cache[require.resolve('../src/db')] = { id: 'db', loaded: true, exports: { from: query } }
const { buildCuadre, jornadaStart, jornadaToday } = require('../src/routes/cuadre')

test('cuadre: la jornada empieza a la hora de corte (hora de Colombia)', () => {
  assert.equal(jornadaStart('2026-11-19', 6), '2026-11-19T11:00:00.000Z')
  assert.equal(jornadaStart('2026-11-19', 0), '2026-11-19T05:00:00.000Z')
  assert.match(jornadaToday(6), /^\d{4}-\d{2}-\d{2}$/)
})

test('cuadre: turno de 4 p. m. a 2 a. m. y otro abierto a las 3 a. m. son la misma jornada y cuadran', async () => {
  // Hora de Colombia = UTC-5. 19 nov 4 p. m. = 21:00Z; 20 nov 2 a. m. = 07:00Z.
  const T = (s) => new Date(s).toISOString()
  Object.assign(DB, {
    app_settings: [{ day_cutoff_hour: 6 }],
    sites: [], vaults: [{ id: 1, site_id: null, kind: 'principal', name: 'General', balance: 100000 }],
    cash_sessions: [
      // Turno de la jornada anterior (18 nov), no debe entrar.
      { id: 9, number: 9, status: 'cerrada', opened_at: T('2026-11-18T21:00:00Z'), closed_at: T('2026-11-19T07:00:00Z'), opening_amount: 50000, expected_cash: 50000, counted_cash: 50000, difference: 0, to_vault: 0, next_float: 0 },
      { id: 10, number: 10, status: 'cerrada', opened_at: T('2026-11-19T21:00:00Z'), closed_at: T('2026-11-20T07:00:00Z'), opening_amount: 100000, expected_cash: 150000, counted_cash: 150000, difference: 0, to_vault: 50000, next_float: 100000 },
      { id: 11, number: 11, status: 'cerrada', opened_at: T('2026-11-20T08:00:00Z'), closed_at: T('2026-11-20T08:30:00Z'), opening_amount: 100000, expected_cash: 110000, counted_cash: 110000, difference: 0, to_vault: 0, next_float: 110000 }
    ],
    orders: [
      { id: 1, status: 'cobrado', session_id: 10, gross: 22000, courtesy_total: 0, discount_total: 0, tip: 2000, total: 24000, closed_at: T('2026-11-19T23:00:00Z') },
      { id: 2, status: 'cobrado', session_id: 10, gross: 30000, courtesy_total: 0, discount_total: 0, tip: 0, total: 30000, closed_at: T('2026-11-20T06:00:00Z') },
      { id: 3, status: 'cobrado', session_id: 11, gross: 10000, courtesy_total: 0, discount_total: 0, tip: 0, total: 10000, closed_at: T('2026-11-20T08:10:00Z') },
      { id: 4, status: 'cobrado', session_id: 9, gross: 99000, courtesy_total: 0, discount_total: 0, tip: 4000, total: 103000, closed_at: T('2026-11-19T06:00:00Z') }
    ],
    cash_movements: [
      { session_id: 10, type: 'venta', method: 'efectivo', amount: 24000, created_at: T('2026-11-19T23:00:00Z') },
      { session_id: 10, type: 'venta', method: 'nequi', amount: 30000, created_at: T('2026-11-20T06:00:00Z') },
      { session_id: 11, type: 'venta', method: 'efectivo', amount: 10000, created_at: T('2026-11-20T08:10:00Z') },
      { session_id: 9, type: 'venta', method: 'efectivo', amount: 103000, created_at: T('2026-11-19T06:00:00Z') }
    ],
    tip_payouts: [{ session_id: 10, amount: 2000 }, { session_id: 9, amount: 4000 }],
    order_payments: [],
    expenses: [],
    vault_movements: [{ vault_id: 1, type: 'cierre_caja', amount: 50000, session_id: 10, created_at: T('2026-11-20T07:00:00Z') }]
  })
  const d = await buildCuadre({ day: '2026-11-19', siteId: null })
  assert.deepEqual(d.shifts.map((s) => s.id), [10, 11])
  assert.equal(d.jornada.from, '2026-11-19T11:00:00.000Z')
  assert.equal(d.sold.orders, 3)
  assert.equal(d.sold.charged, 64000)
  assert.equal(d.totals.sales, 64000)
  assert.equal(d.totals.tips, 2000)
  assert.equal(d.totals.tipsPaid, 2000)
  assert.ok(d.balanced, JSON.stringify(d.checks.filter((c) => !c.ok)))

  // Con corte a medianoche (día calendario) el turno de las 3 a. m. pasa a la jornada del 20.
  DB.app_settings = [{ day_cutoff_hour: 0 }]
  const cal = await buildCuadre({ day: '2026-11-19', siteId: null })
  assert.deepEqual(cal.shifts.map((s) => s.id), [10])
  assert.ok(cal.balanced)
})
