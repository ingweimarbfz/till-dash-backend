const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://localhost'
process.env.SUPABASE_SECRET_KEY ||= 'x'
process.env.JWT_SECRET ||= 'x'
const { featureFor, annual, has, modeOf, limitsDTO } = require('../src/plan')

test('cada ruta queda ligada a su módulo del plan', () => {
  assert.strictEqual(featureFor('/reportes'), 'reportes')
  assert.strictEqual(featureFor('/finanzas/gastos'), 'finanzas')
  assert.strictEqual(featureFor('/descuentos/3'), 'promociones')
  assert.strictEqual(featureFor('/configuracion/apariencia'), 'marca')
  assert.strictEqual(featureFor('/configuracion'), null)
  assert.strictEqual(featureFor('/mesas'), 'mesas')
  assert.strictEqual(featureFor('/mesas/zonas/2'), 'mesas')
  assert.strictEqual(featureFor('/domicilios/bases'), 'domicilios')
  assert.strictEqual(featureFor('/clientes/7'), 'clientes')
  assert.strictEqual(featureFor('/pedidos'), null)
  assert.strictEqual(featureFor('/reportesx'), null)
})

test('sin plan no hay restricciones; con plan solo sus módulos', () => {
  assert.strictEqual(has({ features: null }, 'finanzas'), true)
  assert.strictEqual(has({ features: ['mesas'] }, 'finanzas'), false)
  assert.strictEqual(has({ features: ['mesas', 'finanzas'] }, 'finanzas'), true)
})

test('precio anual con descuento y redondeo cómodo', () => {
  assert.strictEqual(annual(79900, 16.7), 798700)
  assert.strictEqual(annual(42, 16.7), 420)
  assert.deepStrictEqual(limitsDTO({ max_sites: 1, max_admins: 1, max_employees: 5, max_tables: null, max_products: 150 }), { sites: 1, admins: 1, employees: 5, tables: null, products: 150 })
})

test('sin el módulo de mesas el establecimiento trabaja como distribuidora', () => {
  assert.strictEqual(modeOf({ features: null }), 'salon')
  assert.strictEqual(modeOf({ features: ['mesas', 'caja'] }), 'salon')
  assert.strictEqual(modeOf({ features: ['caja', 'domicilios', 'clientes'] }), 'distribuidora')
})
