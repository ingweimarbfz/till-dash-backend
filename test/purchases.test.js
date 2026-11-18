const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { parsePayment } = require('../src/purchases')

test('compras: toda entrada dice de dónde se pagó', () => {
  assert.match(parsePayment({}, { role: 'admin', total: 1000 }).error, /de dónde se pagó/)
  assert.match(parsePayment({ payment: 'regalo' }, { role: 'admin', total: 1000 }).error, /no válida/)
})

test('compras: inventario inicial sin pago solo para el super administrador', () => {
  assert.deepEqual(parsePayment({ payment: 'inicial' }, { role: 'superadmin', total: 156000 }), { pay: { method: 'inicial' } })
  assert.match(parsePayment({ payment: 'inicial' }, { role: 'admin', total: 156000 }).error, /super administrador/)
})

test('compras: caja y cuenta necesitan costo y origen', () => {
  assert.match(parsePayment({ payment: 'cuenta', payAccount: 'general' }, { role: 'admin', total: 0 }).error, /costo/)
  assert.deepEqual(parsePayment({ payment: 'cuenta', payAccount: 'general' }, { role: 'admin', total: 5000 }), { pay: { method: 'cuenta', account: 'general' } })
  assert.deepEqual(parsePayment({ payment: 'cuenta', payAccount: 'v12' }, { role: 'admin', total: 5000 }).pay.account, 'v12')
  assert.match(parsePayment({ payment: 'cuenta', payAccount: 'x;drop' }, { role: 'admin', total: 5000 }).error, /cuenta de Finanzas/)
  assert.match(parsePayment({ payment: 'caja' }, { role: 'admin', total: 5000 }).error, /turno de caja/)
  // Compatibilidad: solo paySessionId es pago con la caja.
  assert.deepEqual(parsePayment({ paySessionId: '7' }, { role: 'admin', total: 5000 }), { pay: { method: 'caja', sessionId: 7 } })
})

test('compras: a crédito exige un proveedor registrado', () => {
  assert.match(parsePayment({ payment: 'credito' }, { role: 'admin', total: 5000 }).error, /proveedor registrado/)
  assert.deepEqual(parsePayment({ payment: 'credito' }, { role: 'admin', total: 5000, supplierId: 3 }), { pay: { method: 'credito', supplierId: 3 } })
})
