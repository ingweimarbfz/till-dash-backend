const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { FLOW, paysCash, cashFigures } = require('../src/routes/deliveries')
const { itemsBlock } = require('../src/ops')

test('domicilio: no sale sin productos ni con comandas sin entregar', () => {
  assert.match(itemsBlock('P-1', []), /no tiene productos/)
  assert.match(itemsBlock('P-1', [{ status: 'anulado', area: 'bar' }]), /no tiene productos/)
  assert.match(itemsBlock('P-1', [{ status: 'pendiente', area: 'cocina' }, { status: 'entregado', area: 'bar' }]), /comandas \(cocina\)/)
  assert.match(itemsBlock('P-1', [{ status: 'listo', area: 'bar' }]), /comandas \(bar\)/)
  assert.equal(itemsBlock('P-1', [{ status: 'entregado', area: 'cocina' }, { status: 'listo', area: 'ninguna' }, { status: 'anulado', area: 'bar' }]), null)
})

test('domicilio: no salta de por despachar a entregado', () => {
  assert.deepEqual(FLOW.por_despachar, ['en_camino'])
  assert.ok(FLOW.en_camino.includes('entregado'))
  assert.ok(!FLOW.entregado.includes('por_despachar'))
})

test('domicilio: dinero recibido solo aplica a pagos en efectivo', () => {
  assert.equal(paysCash({ delivery_pay_method: 'efectivo' }), true)
  assert.equal(paysCash({ delivery_pay_method: null }), true)
  assert.equal(paysCash({ delivery_pay_method: 'nequi' }), false)
})

test('domicilio: valores que registra el domiciliario al recibir el dinero', () => {
  // Pedido abierto con domicilio de 5.000 (total 45.000); el domiciliario lo deja en 6.000 y el cliente da 50.000.
  assert.deepEqual(cashFigures({ total: 45000, delivery_fee: 5000, cash_received_fee: 6000, cash_received_amount: 50000 }), { fee: 6000, amount: 46000, received: 50000, change: 4000 })
  // Sin registro: se toma el domicilio del pedido y pago exacto.
  assert.deepEqual(cashFigures({ total: 45000, delivery_fee: 5000, cash_received_fee: null, cash_received_amount: null }), { fee: 5000, amount: 45000, received: 45000, change: 0 })
})
