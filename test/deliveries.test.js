const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { FLOW } = require('../src/routes/deliveries')
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
