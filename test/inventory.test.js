const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { isLow } = require('../src/stock')
const { qty, UNITS } = require('../src/routes/inventory')
const { statusOf, bestFor, priceWith } = require('../src/promo')
const { atBogota, validatePromotion } = require('../src/routes/promotions')
const { lowStockMessage, transferMessage } = require('../src/notify')

test('stock bajo: en el mínimo o agotado', () => {
  assert.equal(isLow(5, 5), true)
  assert.equal(isLow(6, 5), false)
  assert.equal(isLow(0, 0), true)
  assert.equal(isLow(1, 0), false)
  assert.equal(isLow('2.5', '3'), true)
})

test('cantidades con hasta 3 decimales y unidades', () => {
  assert.equal(qty('1.23456'), 1.235)
  assert.equal(qty(10), 10)
  assert.ok(UNITS.ml && UNITS.botella)
})

test('promociones: precio, vigencia y la más barata', () => {
  const now = new Date('2026-11-17T23:30:00Z') // martes 6:30 p. m. en Colombia
  const happy = { id: 1, active: true, type: 'porcentaje', value: 50, scope: 'todos', time_from: '17:00', time_to: '19:00', weekdays: [2] }
  const late = { id: 2, active: true, type: 'valor', value: 1000, scope: 'productos', product_ids: [7], time_from: '22:00', time_to: '02:00', weekdays: [] }
  assert.equal(statusOf(happy, now), 'vigente')
  assert.equal(statusOf(late, now), 'fuera_de_horario')
  assert.equal(statusOf(late, new Date('2026-11-18T06:00:00Z')), 'vigente') // 1:00 a. m., cruza la medianoche
  assert.equal(priceWith(happy, 9000), 4500)
  assert.equal(bestFor([happy, late], { id: 7, category_id: 1, price: 9000 }, now).price, 4500)
  assert.equal(statusOf({ ...happy, active: false }, now), 'inactiva')
})

test('promociones: validación y fechas de Colombia', () => {
  assert.equal(atBogota('2026-11-20T18:00'), '2026-11-20T23:00:00.000Z')
  assert.deepEqual(validatePromotion({ name: 'Happy hour', type: 'porcentaje', value: 30, scope: 'todos' }), [])
  assert.ok(validatePromotion({ name: 'X', type: 'porcentaje', value: 130, scope: 'productos' }).length >= 2)
  assert.ok(validatePromotion({ name: 'X', type: 'valor', value: 1, timeFrom: '17:00' }).some((e) => e.includes('franja')))
})

test('mensajes de Telegram de inventario', () => {
  const w = { name: 'Bodega Centro', site: 'Centro', siteId: 2, isMain: false }
  const m = lowStockMessage([{ name: 'Ron <añejo>', unit: 'botella', stock: 0, minStock: 2, warehouse: w }, { name: 'Limón', unit: 'kg', stock: 1.5, minStock: 3, warehouse: w }])
  assert.equal(m.siteId, 2)
  assert.match(m.html, /STOCK BAJO/)
  assert.match(m.html, /Ron &lt;añejo&gt;/)
  assert.match(m.html, /1,5 kg/)
  const t = transferMessage({ ref: 'TR-00001', from: { name: 'Bodega principal', isMain: true, siteId: null }, to: w, items: [{ name: 'Limón', unit: 'kg', quantity: 2 }], user: { name: 'Ana' } })
  assert.equal(t.siteId, 2)
  assert.match(t.html, /TR-00001/)
})
