const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://localhost'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { rowFrom, customerDTO } = require('../src/routes/customers')

test('cliente nuevo: nombre obligatorio, tipo, domicilio y plazo válidos', () => {
  assert.strictEqual(rowFrom({}).error, 'Escribe el nombre del cliente')
  const { row } = rowFrom({ name: '  Tienda Don Pepe ', kind: 'tienda', phone: '300 123 4567', zone: 'Norte', deliveryFee: '3000', creditDays: '15', payMethod: 'nequi' })
  assert.strictEqual(row.name, 'Tienda Don Pepe')
  assert.strictEqual(row.kind, 'tienda')
  assert.strictEqual(row.delivery_fee, 3000)
  assert.strictEqual(row.credit_days, 15)
  assert.strictEqual(row.pay_method, 'nequi')
  assert.strictEqual(rowFrom({ name: 'X', kind: 'raro' }).row.kind, 'persona')
  assert.ok(rowFrom({ name: 'X', creditDays: 400 }).error)
  assert.ok(rowFrom({ name: 'X', deliveryFee: -1 }).error)
})

test('edición parcial: solo cambia lo que llega', () => {
  assert.deepStrictEqual(rowFrom({ zone: 'Sur' }, true).row, { zone: 'Sur' })
  assert.deepStrictEqual(rowFrom({ deliveryFee: '' }, true).row, { delivery_fee: null })
  assert.ok(rowFrom({ name: '' }, true).error)
})

test('el cliente sale con su tipo legible y el domicilio como número', () => {
  const c = customerDTO({ id: 1, name: 'Licorera 24h', kind: 'licorera', delivery_fee: '5000', credit_days: null, active: true })
  assert.strictEqual(c.kindLabel, 'Licorera')
  assert.strictEqual(c.deliveryFee, 5000)
})
