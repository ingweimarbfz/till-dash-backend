const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { inSite, priceAt, availableAt, siteIdsOf } = require('../src/catalog')
const { bestFor } = require('../src/promo')

test('catálogo por sucursal (TD-024)', () => {
  // Sin sucursales elegidas aplica en todas; con sucursales, solo en ellas.
  assert.equal(inSite({ site_ids: [] }, 2), true)
  assert.equal(inSite({ site_ids: [1, 3] }, 2), false)
  assert.equal(inSite({ site_ids: [1, 3] }, 3), true)
  assert.equal(inSite({ site_ids: [1] }, null), true)
  // El producto se vende si él y su categoría aplican en la sucursal.
  const p = { id: 7, price: 10000, site_ids: [], category: { site_ids: [1] } }
  assert.equal(availableAt(p, 1), true)
  assert.equal(availableAt(p, 2), false)
  // Precio propio de la sucursal o el general.
  const prices = new Map([[7, [{ siteId: 2, price: 12000 }]]])
  assert.equal(priceAt(p, 2, prices), 12000)
  assert.equal(priceAt(p, 1, prices), 10000)
  assert.equal(priceAt(p, null, prices), 10000)
  assert.deepEqual(siteIdsOf(['2', 2, 0, 'x', 5]), [2, 5])
  // La promoción se calcula sobre el precio de la sucursal.
  const promo = { id: 1, active: true, scope: 'todos', type: 'porcentaje', value: 10, weekdays: [] }
  assert.equal(bestFor([promo], { ...p, price: priceAt(p, 2, prices) }).price, 10800)
})
