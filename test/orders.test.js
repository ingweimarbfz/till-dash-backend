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

test('cuenta dividida entre personas', () => {
  const { validateSplit, apportion } = require('../src/split')
  assert.deepEqual(apportion(100000, [1, 1, 1]), [33334, 33333, 33333])
  assert.deepEqual(apportion(10, [0, 0]), [5, 5])
  assert.equal(apportion(99999, [3, 7, 11]).reduce((a, x) => a + x, 0), 99999)
  const order = { items: [
    { id: 1, name: 'Cerveza', quantity: 3, unit_price: 8000, courtesy: false, status: 'listo' },
    { id: 2, name: 'Picada', quantity: 1, unit_price: 30000, courtesy: false, status: 'listo' },
    { id: 3, name: 'Agua', quantity: 1, unit_price: 3000, courtesy: true, status: 'listo' },
    { id: 4, name: 'Vino', quantity: 1, unit_price: 50000, courtesy: false, status: 'anulado' }
  ] }
  // Partes iguales con dos pagos de la primera persona.
  const eq = validateSplit({ mode: 'iguales', persons: [{ name: 'Ana', amount: 27000 }, { name: '', amount: 27000 }] },
    [{ method: 'efectivo', amount: 20000, person: 0 }, { method: 'nequi', amount: 7000, person: 0 }, { method: 'tarjeta', amount: 27000, person: 1 }], order)
  assert.equal(eq.error, undefined)
  assert.deepEqual(eq.payers, ['Ana', 'Ana', 'Persona 2'])
  assert.match(validateSplit({ mode: 'valor', persons: [{ name: 'Ana', amount: 30000 }, { name: 'Luis', amount: 24000 }] }, [{ method: 'efectivo', amount: 30000, person: 0 }, { method: 'efectivo', amount: 20000, person: 1 }], order).error, /Luis.*faltan \$4\.000/)
  assert.match(validateSplit({ mode: 'valor', persons: [{ name: 'Ana', amount: 54000 }] }, [], order).error, /al menos 2/)
  assert.match(validateSplit({ mode: 'valor', persons: [{ name: 'Ana', amount: 54000 }, { name: 'ana', amount: 1 }] }, [], order).error, /dos personas/)
  // Por productos: Ana 2 cervezas + media picada, Luis 1 cerveza + media picada + el agua de cortesía. Propina 10 % = 5.400.
  const persons = [
    { name: 'Ana', amount: 34100, items: [{ itemId: 1, quantity: 2 }, { itemId: 2, quantity: 0.5 }] },
    { name: 'Luis', amount: 25300, items: [{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 0.5 }, { itemId: 3, quantity: 1 }] }
  ]
  const pays = [{ method: 'efectivo', amount: 34100, person: 0 }, { method: 'tarjeta', amount: 25300, person: 1 }]
  const bp = validateSplit({ mode: 'productos', persons }, pays, order)
  assert.equal(bp.error, undefined)
  assert.equal(bp.split.persons[0].consumption, 31000)
  assert.equal(bp.split.total, 59400)
  assert.match(validateSplit({ mode: 'productos', persons: [persons[0], { ...persons[1], items: persons[1].items.slice(0, 2) }] }, pays, order).error, /Falta asignar Agua/)
  assert.match(validateSplit({ mode: 'productos', persons: [{ ...persons[0], amount: 30000 }, { ...persons[1], amount: 29400 }] }, [{ method: 'efectivo', amount: 30000, person: 0 }, { method: 'tarjeta', amount: 29400, person: 1 }], order).error, /no corresponde/)
  assert.match(validateSplit({ mode: 'productos', persons: [{ ...persons[0], items: [...persons[0].items, { itemId: 4, quantity: 1 }] }, persons[1]] }, pays, order).error, /no está en el pedido/)
})
