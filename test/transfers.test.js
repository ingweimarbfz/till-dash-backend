const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { matchPayments, transferTotals } = require('../src/transfers')
const { transfersLine } = require('../src/notify')

test('transferencias: cada cobro toma la referencia y el pagador de su pago, una sola vez', () => {
  const moves = [
    { id: 1, order_id: 10, method: 'nequi', amount: 20000, session_id: 5 },
    { id: 2, order_id: 10, method: 'nequi', amount: 20000, session_id: 5 },
    { id: 3, order_id: 11, method: 'daviplata', amount: 15000, session_id: 5 },
    { id: 4, receivable_id: 7, method: 'transferencia', amount: 50000, session_id: 5 }
  ]
  const orderPays = [
    { order_id: 10, method: 'nequi', amount: '20000.00', reference: 'M123', payer: 'Ana', session_id: 5 },
    { order_id: 10, method: 'nequi', amount: '20000.00', reference: 'M456', payer: 'Luis', session_id: 5 },
    { order_id: 11, method: 'nequi', amount: '15000.00', reference: 'X', session_id: 5 }
  ]
  const recvPays = [{ receivable_id: 7, method: 'transferencia', amount: 50000, reference: 'BANCO-9', session_id: 5 }]
  const r = matchPayments(moves, orderPays, recvPays)
  assert.deepEqual(r, [
    { reference: 'M123', payer: 'Ana' }, { reference: 'M456', payer: 'Luis' },
    { reference: null, payer: null }, { reference: 'BANCO-9', payer: null }
  ])
})

test('transferencias: totales por estado', () => {
  const t = transferTotals([{ amount: 10000, status: 'verificada' }, { amount: 5000, status: 'pendiente' }, { amount: 7000, status: 'pendiente' }, { amount: 3000, status: 'no_llego' }])
  assert.equal(t.count, 4); assert.equal(t.amount, 25000)
  assert.deepEqual(t.pendiente, { count: 2, amount: 12000 })
  assert.deepEqual(t.verificada, { count: 1, amount: 10000 })
  assert.deepEqual(t.no_llego, { count: 1, amount: 3000 })
})

test('transferencias: línea del cierre en Telegram', () => {
  assert.equal(transfersLine(null), null)
  assert.equal(transfersLine(transferTotals([])), null)
  assert.match(transfersLine(transferTotals([{ amount: 10000, status: 'verificada' }])), /verificadas: .*10\.000 \(1\)/)
  const l = transfersLine(transferTotals([{ amount: 10000, status: 'verificada' }, { amount: 5000, status: 'pendiente' }, { amount: 3000, status: 'no_llego' }]))
  assert.match(l, /Por verificar: .*5\.000 \(1\)/)
  assert.match(l, /No llegaron: .*3\.000 \(1\)/)
})
