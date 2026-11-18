const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const db = require('../src/db')
const { buildReport, rangeOf } = require('../src/routes/reports')

// Base falsa: cada tabla devuelve sus filas sin importar los filtros.
const fixtures = {
  orders: [
    { id: 1, number: 'P-1', site_id: 1, type: 'mesa', guests: 2, waiter_id: 7, gross: 60000, courtesy_total: 8000, subtotal: 52000, discount_total: 2000, discount_name: 'Frecuente', tip: 5000, total: 55000, closed_at: '2026-11-16T23:30:00Z', status: 'cobrado', table: { name: 'Mesa 1' } },
    { id: 2, number: 'P-2', site_id: 1, type: 'llevar', guests: null, waiter_id: 8, gross: 20000, courtesy_total: 0, subtotal: 20000, discount_total: 0, tip: 0, total: 20000, closed_at: '2026-11-17T15:00:00Z', status: 'cobrado' }
  ],
  order_items: [
    { id: 10, order_id: 1, product_id: 3, name: 'Cerveza', quantity: 4, list_price: 8000, unit_price: 8000, courtesy: false, status: 'entregado', product: { cost: 3000, category: { name: 'Bebidas', emoji: '🍺' } } },
    { id: 11, order_id: 1, product_id: 3, name: 'Cerveza', quantity: 1, list_price: 8000, unit_price: 8000, courtesy: true, courtesy_reason: 'Demora', status: 'entregado', product: { cost: 3000, category: { name: 'Bebidas', emoji: '🍺' } } },
    { id: 12, order_id: 2, product_id: 4, name: 'Hamburguesa', quantity: 1, list_price: 20000, unit_price: 20000, courtesy: false, status: 'entregado', product: { cost: 9000, category: { name: 'Comida', emoji: '🍔' } } }
  ],
  order_payments: [{ order_id: 1, method: 'efectivo', amount: 55000 }, { order_id: 2, method: 'nequi', amount: 20000 }],
  tip_payouts: [{ id: 1, user_id: 7, amount: 5000, created_at: '2026-11-17T03:00:00Z', user: { name: 'Laura' }, session: { number: 'TC-1', site_id: 1 } }],
  incidents: [{ id: 1, number: 'IN-1', type: 'rotura', title: 'Copas', cost: 18000, status: 'abierto', occurred_at: '2026-11-17T01:00:00Z' }],
  sites: [{ id: 1, name: 'Centro' }],
  users: [{ id: 7, name: 'Laura', last_name: 'Gómez' }, { id: 8, name: 'Carlos' }]
}
const builder = (table, rows) => {
  let data = rows
  const q = {
    select: () => q, eq: (k, v) => { if (k === 'status') data = data.filter((r) => r.status === undefined || r.status === v); return q },
    gte: () => q, lt: () => q, neq: () => q, order: () => q, in: () => q, not: () => q,
    range: () => Promise.resolve({ data, error: null }),
    then: (ok, ko) => Promise.resolve({ data, error: null }).then(ok, ko)
  }
  return q
}
db.from = (table) => builder(table, fixtures[table] || [])

test('rango de fechas por defecto: últimos 7 días', () => {
  const r = rangeOf({ hasta: '2026-11-17' })
  assert.deepEqual(r, { from: '2026-11-11', to: '2026-11-17' })
})

test('reporte de ventas, productos, meseros y propinas', async () => {
  const r = await buildReport({ query: { desde: '2026-11-16', hasta: '2026-11-17' }, siteId: null })
  assert.equal(r.totals.sales, 70000) // 55.000 + 20.000 − 5.000 de propina
  assert.equal(r.totals.orders, 2)
  assert.equal(r.totals.tips, 5000)
  assert.equal(r.totals.tipsPaid, 5000)
  assert.equal(r.totals.cost, 3000 * 5 + 9000)
  assert.equal(r.byDay.length, 2)
  assert.equal(r.byDay[0].sales, 50000) // 16 nov a las 6:30 p. m. en Colombia
  const beer = r.products.find((p) => p.name === 'Cerveza')
  assert.equal(beer.qty, 5); assert.equal(beer.courtesyQty, 1); assert.equal(beer.revenue, 32000)
  assert.equal(r.waiters[0].name, 'Laura Gómez'); assert.equal(r.waiters[0].tipsReceived, 5000)
  assert.equal(r.courtesies.length, 1)
  assert.equal(r.discounts[0].amount, 2000)
  assert.equal(r.byMethod[0].label, 'Efectivo')
  assert.equal(r.incidents.byType[0].cost, 18000)
})

test('uso de las mesas: tiempo promedio y venta por hora', () => {
  const { tableStats } = require('../src/routes/reports')
  const o = (id, table, mins, total) => ({ id, table_id: table, table: { name: `Mesa ${table}`, area: { name: 'Salón' } }, guests: 2, total, tip: 0, opened_at: '2026-11-17T00:00:00Z', closed_at: new Date(Date.parse('2026-11-17T00:00:00Z') + mins * 60000).toISOString() })
  const r = tableStats([o(1, 1, 60, 100000), o(2, 1, 120, 100000), o(3, 2, 30, 60000), o(4, 2, 900, 10)])
  assert.equal(r.turns, 3) // la de 15 horas no cuenta
  assert.equal(r.avgMinutes, 70)
  assert.equal(r.rows[0].name, 'Mesa 2') // 120.000 por hora contra 66.667
  assert.equal(r.rows[0].perHour, 120000)
  assert.equal(r.rows[1].avgMinutes, 90)
})
