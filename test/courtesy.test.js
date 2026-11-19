const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'

// Base de datos falsa: productos y sin promociones.
const PRODUCTS = [
  { id: 1, name: 'Aguardiente 750 ml', price: 95000, cost: 50000, active: true, track_stock: true, courtesy_allowed: false, category: { area: 'bar' } },
  { id: 2, name: 'Agua sin gas', price: 4500, cost: 1200, active: true, track_stock: true, courtesy_allowed: true, category: { area: 'ninguna' } }
]
const chain = (data) => { const q = { select: () => q, eq: () => q, in: () => q, then: (r) => Promise.resolve({ data }).then(r) }; return q }
const db = require.resolve('../src/db')
require.cache[db] = { id: db, filename: db, loaded: true, exports: { from: (t) => chain(t === 'products' ? PRODUCTS : []) } }
const { buildItems } = require('../src/routes/orders')

const mesero = { user: { id: 7, role: 'empleado', positions: ['mesero'] } }
const cajero = { user: { id: 8, role: 'empleado', positions: ['cajero'] } }

test('cortesía al agregar: el producto habilitado sale en $0 con motivo', async () => {
  const { rows, error } = await buildItems(mesero, [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 1, courtesy: true }])
  assert.equal(error, undefined)
  assert.equal(rows[0].courtesy, undefined)
  assert.equal(rows[1].courtesy, true)
  assert.equal(rows[1].courtesy_reason, 'Cortesía de la casa')
  assert.equal(rows[1].courtesy_by, 7)
  const r2 = await buildItems(mesero, [{ productId: 2, quantity: 2, courtesy: true, courtesyReason: 'Con el aguardiente' }])
  assert.equal(r2.rows[0].courtesy_reason, 'Con el aguardiente')
})

test('cortesía al agregar: el mesero no puede regalar productos no habilitados, la caja sí', async () => {
  const r = await buildItems(mesero, [{ productId: 1, quantity: 1, courtesy: true }])
  assert.match(r.error, /no está habilitado como cortesía/)
  const c = await buildItems(cajero, [{ productId: 1, quantity: 1, courtesy: true }])
  assert.equal(c.rows[0].courtesy, true)
})

test('cortesía al agregar: desde el QR no se puede', async () => {
  const r = await buildItems({ user: { id: null } }, [{ productId: 2, quantity: 1, courtesy: true }], { allowCourtesy: false })
  assert.equal(r.rows[0].courtesy, undefined)
})
