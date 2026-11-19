const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { isDate, daysBetween, statusOf, adviceFor, markFirst, lotDTO, addDays } = require('../src/lots')

test('vencimientos: fechas y días que faltan', () => {
  assert.ok(isDate('2026-11-30'))
  assert.ok(!isDate('2026-02-30'))
  assert.ok(!isDate('30/11/2026'))
  assert.equal(daysBetween('2026-11-18', '2026-11-21'), 3)
  assert.equal(daysBetween('2026-11-18', '2026-11-17'), -1)
  assert.equal(addDays('2026-11-28', 5), '2026-12-03')
})

test('vencimientos: estado y recomendación del lote', () => {
  assert.equal(statusOf(-1, 15), 'vencido')
  assert.equal(statusOf(0, 15), 'urgente')
  assert.equal(statusOf(3, 15), 'urgente')
  assert.equal(statusOf(10, 15), 'proximo')
  assert.equal(statusOf(20, 15), 'ok')
  assert.equal(adviceFor('vencido').action, 'baja')
  assert.equal(adviceFor('urgente').action, 'promocion')
  assert.match(adviceFor('proximo', true).text, /adelante/)
})

test('vencimientos: el lote vigente que vence primero va adelante (FEFO)', () => {
  const today = '2026-11-18'
  const lots = [
    { id: 3, warehouse_id: 1, product_id: 7, expires_on: '2026-11-25', quantity: 4 },
    { id: 1, warehouse_id: 1, product_id: 7, expires_on: '2026-11-10', quantity: 2 }, // vencido: no va adelante
    { id: 2, warehouse_id: 1, product_id: 7, expires_on: '2026-11-20', quantity: 3 },
    { id: 4, warehouse_id: 2, product_id: 7, expires_on: '2026-11-30', quantity: 1 }
  ]
  const first = markFirst(lots, today).filter((x) => x.first).map((x) => x.l.id)
  assert.deepEqual(first, [2, 4])
  const dto = lotDTO({ ...lots[2], received: 3, unit_cost: null, product: { id: 7, name: 'Leche', unit: 'und', cost: 2000, price: 3500 } }, today, 15, true)
  assert.equal(dto.days, 2)
  assert.equal(dto.status, 'urgente')
  assert.equal(dto.costValue, 6000)
  assert.equal(dto.saleValue, 10500)
})
