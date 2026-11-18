const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { can, money, isMoney } = require('../src/ops')
const { validatePayments } = require('../src/routes/orders')
const { cashCloseMessage, courtesyMessage, callMessage } = require('../src/notify')

test('permisos por cargo', () => {
  assert.equal(can({ role: 'admin' }, 'cajero'), true)
  assert.equal(can({ role: 'empleado', positions: ['mesero'] }, 'cajero'), false)
  assert.equal(can({ role: 'empleado', positions: ['mesero', 'cajero'] }, 'cajero'), true)
  assert.equal(can({ role: 'cliente', positions: ['cajero'] }, 'cajero'), false)
})

test('formas de pago', () => {
  assert.equal(validatePayments([]), 'Agrega al menos una forma de pago')
  assert.equal(validatePayments([{ method: 'bitcoin', amount: 1 }]), 'Forma de pago no válida')
  assert.match(validatePayments([{ method: 'efectivo', amount: 50000, received: 20000 }]), /recibido es menor/)
  assert.equal(validatePayments([{ method: 'efectivo', amount: 50000, received: 60000 }, { method: 'tarjeta', amount: 9200 }]), null)
  assert.equal(money('1234.6'), 1235)
  assert.equal(isMoney(''), false)
  assert.equal(isMoney(0), true)
})

test('mensajes de Telegram de pedidos, caja y mesas', () => {
  const close = cashCloseMessage({ number: 'TC-00001', register: 'Caja 1', site: 'Centro', siteId: 2, sales: 79200, tips: 7200, orders: 1, byMethod: { Efectivo: 55000 }, expected: 255000, counted: 254000, difference: -1000, toVault: 150000, user: { name: 'Carlos' } })
  assert.equal(close.siteId, 2)
  assert.match(close.html, /Faltante: \$1\.000/)
  assert.match(close.html, /bóveda: \$150\.000/)
  const c = courtesyMessage({ order: { id: 1, number: 'P-00001' }, item: { name: 'Club <Dorada>', quantity: 1, unit_price: 8000 }, reason: 'Demora', user: { name: 'Ana' }, siteId: 2 })
  assert.match(c.html, /Club &lt;Dorada&gt;/)
  assert.match(callMessage({ table: 'Mesa 4', kind: 'cuenta' }).html, /PIDE LA CUENTA/)
})
