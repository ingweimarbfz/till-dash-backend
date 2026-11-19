const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { badgesFor, areasFor, countTickets } = require('../src/routes/badges')

const emp = (...positions) => ({ role: 'empleado', positions })

test('contadores: cada usuario ve los de su menú', () => {
  assert.deepEqual(badgesFor({ role: 'admin' }), ['comandas', 'mesas', 'pedidos', 'domicilios', 'caja', 'incidentes'])
  assert.deepEqual(badgesFor(emp('cocina')), ['comandas', 'incidentes'])
  assert.deepEqual(badgesFor(emp('mesero')), ['mesas', 'pedidos', 'domicilios', 'incidentes'])
  assert.deepEqual(badgesFor(emp('domiciliario')), ['domicilios', 'incidentes'])
  assert.deepEqual(badgesFor(emp('bartender')), ['comandas', 'pedidos', 'domicilios', 'incidentes'])
})

test('contadores: sin el módulo del plan no hay contador', () => {
  const has = (f) => !['comandas', 'incidentes', 'carta_qr'].includes(f)
  assert.deepEqual(badgesFor({ role: 'superadmin' }, has), ['pedidos', 'domicilios', 'caja'])
})

test('contadores: comandas por área y por pedido', () => {
  assert.deepEqual(areasFor(emp('cocina')), ['cocina'])
  assert.deepEqual(areasFor(emp('bartender', 'barista')), ['bar', 'barista'])
  assert.deepEqual(areasFor({ role: 'admin' }), ['cocina', 'bar', 'barista'])
  // Dos productos del mismo pedido en cocina cuentan una comanda; el mismo pedido en bar cuenta otra.
  assert.equal(countTickets([{ order_id: 1, area: 'cocina' }, { order_id: 1, area: 'cocina' }, { order_id: 1, area: 'bar' }, { order_id: 2, area: 'cocina' }]), 3)
  assert.equal(countTickets([]), 0)
})
