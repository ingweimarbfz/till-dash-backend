const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { tipBalance, cleanPayments, tipOwner } = require('../src/tips')

test('propinas: cada propina es del mesero o, en un domicilio con domiciliario, del domiciliario', () => {
  assert.equal(tipOwner({ type: 'mesa', waiter_id: 1, courier_id: null }), 1)
  assert.equal(tipOwner({ type: 'domicilio', waiter_id: 1, courier_id: 9 }), 9)
  assert.equal(tipOwner({ type: 'domicilio', waiter_id: 1, courier_id: null }), 1)
})

test('propinas: por pagar = generadas − pagadas, y por empleado lo que le falta', () => {
  const staff = [{ id: 1, name: 'Ana', role: 'empleado', positions: ['mesero'] }, { id: 2, name: 'Luis', role: 'empleado', positions: ['mesero'] }, { id: 3, name: 'Caro', role: 'empleado', positions: ['cajero'] }]
  const orders = [
    { waiter_id: 1, tip: '10000', type: 'mesa' }, { waiter_id: 1, tip: 5000, type: 'mesa' },
    { waiter_id: 2, tip: 8000, type: 'mesa' }, { waiter_id: 1, courier_id: 9, tip: 2000, type: 'domicilio', courier: { name: 'Pedro' } },
    { waiter_id: null, tip: 1000, type: 'mostrador' }
  ]
  const payouts = [{ user_id: 1, amount: 6000, created_at: '2026-11-18T10:00:00Z', user: { name: 'Ana' } }, { user_id: 1, amount: 4000, created_at: '2026-11-19T10:00:00Z' }]
  const r = tipBalance(orders, payouts, staff)
  assert.equal(r.generated, 26000)
  assert.equal(r.paid, 10000)
  assert.equal(r.pending, 16000)
  assert.equal(r.unassigned, 1000)
  const by = Object.fromEntries(r.people.map((p) => [p.userId, p]))
  assert.deepEqual([by[1].generated, by[1].received, by[1].pending, by[1].payments, by[1].lastPaidAt], [15000, 10000, 5000, 2, '2026-11-19T10:00:00Z'])
  assert.equal(by[2].pending, 8000)
  assert.equal(by[9].name, 'Pedro'); assert.equal(by[9].pending, 2000)
  assert.equal(by[3].pending, 0) // aparece para poder pagarle aunque no haya atendido pedidos
  assert.equal(r.people[0].userId, 2) // primero a quien más se le debe
})

test('propinas: si se pagó de más, por pagar no queda negativo', () => {
  const r = tipBalance([{ waiter_id: 1, tip: 1000 }], [{ user_id: 1, amount: 3000 }])
  assert.equal(r.pending, 0); assert.equal(r.people[0].pending, 0)
})

test('propinas: validación del pago', () => {
  assert.deepEqual(cleanPayments([{ userId: 1, amount: '5000' }, { userId: 2, amount: 0 }, { userId: 3, amount: 2500.4 }]), { payments: [{ user_id: 1, amount: 5000 }, { user_id: 3, amount: 2500 }], total: 7500 })
  assert.match(cleanPayments([]).error, /cuánto/)
  assert.match(cleanPayments([{ userId: 1, amount: 1 }, { userId: 1, amount: 2 }]).error, /dos veces/)
  assert.match(cleanPayments([{ amount: 1000 }]).error, /empleado/)
  assert.match(cleanPayments([{ userId: 1, amount: -5 }]).error, /Revisa/)
})

const { payPeriod, prevPeriod, payrollDue, cleanPayroll, cleanEarnings } = require('../src/tips')
const { payFrom } = require('../src/routes/users')

test('nómina: periodos quincenales y mensuales', () => {
  assert.deepEqual(payPeriod('2026-11-19', 'quincenal'), { from: '2026-11-16', to: '2026-11-30' })
  assert.deepEqual(payPeriod('2026-02-03', 'quincenal'), { from: '2026-02-01', to: '2026-02-15' })
  assert.deepEqual(payPeriod('2028-02-20', 'mensual'), { from: '2028-02-01', to: '2028-02-29' })
  assert.deepEqual(prevPeriod('2026-11-16', 'quincenal'), { from: '2026-11-01', to: '2026-11-15' })
  assert.deepEqual(prevPeriod('2026-01-01', 'quincenal'), { from: '2025-12-16', to: '2025-12-31' })
  assert.deepEqual(prevPeriod('2026-01-01', 'mensual'), { from: '2025-12-01', to: '2025-12-31' })
})

test('nómina: se sugiere el periodo más antiguo sin pagar (anterior o actual)', () => {
  assert.deepEqual(payrollDue('2026-11-19', 'quincenal', []), { from: '2026-11-01', to: '2026-11-15', current: false })
  assert.deepEqual(payrollDue('2026-11-19', 'quincenal', ['2026-11-01']), { from: '2026-11-16', to: '2026-11-30', current: true })
  assert.equal(payrollDue('2026-11-19', 'quincenal', ['2026-11-01', '2026-11-16']), null)
  assert.deepEqual(payrollDue('2026-11-19', 'mensual', ['2026-10-01']), { from: '2026-11-01', to: '2026-11-30', current: true })
})

test('pagos al personal: validación', () => {
  assert.deepEqual(cleanEarnings([3, '3', 'x', -1, 7]), [3, 7])
  assert.deepEqual(cleanPayroll([{ userId: 2, amount: '750000', from: '2026-11-01', to: '2026-11-15' }]).payroll, [{ user_id: 2, amount: 750000, period_from: '2026-11-01', period_to: '2026-11-15' }])
  assert.ok(cleanPayroll([{ userId: 2, amount: 1, from: '2026-11-15', to: '2026-11-01' }]).error)
  assert.deepEqual(payFrom({ payMode: 'turno', hourRate: '8000.4', salary: 9 }), { pay_mode: 'turno', hour_rate: 8000, salary: 0, pay_period: 'mensual' })
  assert.deepEqual(payFrom({ payMode: 'nomina', salary: 1500000, payPeriod: 'quincenal' }), { pay_mode: 'nomina', hour_rate: 0, salary: 1500000, pay_period: 'quincenal' })
  assert.throws(() => payFrom({ payMode: 'turno' }), /valor de la hora/)
  assert.equal(payFrom({}).pay_mode, 'ninguno')
})
