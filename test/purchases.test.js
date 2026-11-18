const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://localhost'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { sourcesFor, addDays, PAY_SOURCES } = require('../src/purchases')

test('con Finanzas: caja, cuenta y crédito; inventario inicial solo el super administrador', () => {
  assert.deepStrictEqual(sourcesFor({ finance: true, role: 'admin' }), ['caja', 'cuenta', 'credito'])
  assert.deepStrictEqual(sourcesFor({ finance: true, role: 'superadmin' }), ['caja', 'cuenta', 'credito', 'inicial'])
})

test('sin Finanzas no hay cuentas que validar: caja o pagado por fuera', () => {
  assert.deepStrictEqual(sourcesFor({ finance: false, role: 'admin' }), ['caja', 'externo'])
  assert.deepStrictEqual(sourcesFor({ finance: false, role: 'superadmin' }), ['caja', 'externo', 'inicial'])
})

test('cada forma de pago tiene su nombre', () => {
  for (const k of ['caja', 'cuenta', 'credito', 'inicial', 'externo']) assert.ok(PAY_SOURCES[k])
})

test('vencimiento del crédito: suma los días de plazo del proveedor', () => {
  assert.strictEqual(addDays('2026-11-18', 30), '2026-12-18')
  assert.strictEqual(addDays('2026-12-20', 15), '2027-01-04')
  assert.strictEqual(addDays('2026-11-18', 0), '2026-11-18')
})
