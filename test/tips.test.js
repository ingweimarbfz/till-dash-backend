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
