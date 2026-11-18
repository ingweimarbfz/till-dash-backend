const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { summarize, fundSite } = require('../src/routes/finance')

const report = {
  totals: { sales: 1000000, cost: 400000, tips: 50000, discounts: 10000, courtesies: 5000 },
  byDay: [{ date: '2026-10-31', sales: 300000 }, { date: '2026-11-01', sales: 700000 }],
  incidents: { rows: [{ cost: 20000, charged: false }, { cost: 15000, charged: true }] }
}
const base = {
  report, range: { from: '2026-10-31', to: '2026-11-01' },
  expenses: [
    { category: 'arriendo', amount: 200000, paid_on: '2026-11-01', source: 'fondo' },
    { category: 'compras', amount: 150000, paid_on: '2026-11-01', source: 'fondo' },
    { category: 'servicios', amount: 30000, paid_on: '2026-10-31', source: 'socio', partner_id: 2 }
  ],
  entries: [{ kind: 'otro_ingreso', amount: 50000, received_on: '2026-11-01' }, { kind: 'aporte_socio', amount: 500000, received_on: '2026-11-01', partner_id: 1 }],
  withdrawals: [{ partner_id: 1, kind: 'utilidad', amount: 100000 }],
  partners: [{ id: 1, name: 'Ana', share_pct: 60 }, { id: 2, name: 'Beto', share_pct: 30 }]
}

test('estado de resultados: compras e aportes no son gasto ni ingreso; pérdidas sin cobrar sí', () => {
  const r = summarize(base)
  const s = r.statement
  assert.strictEqual(s.gross, 600000)
  assert.strictEqual(s.opex, 230000) // arriendo + servicios, sin compras de inventario
  assert.strictEqual(s.purchases, 150000)
  assert.strictEqual(s.losses, 20000) // la rotura cobrada al responsable no cuenta
  assert.strictEqual(s.otherIncome, 50000) // el aporte del socio no es ingreso
  assert.strictEqual(s.net, 600000 - 230000 - 20000 + 50000)
  assert.deepStrictEqual(r.funding.map((f) => f.key), ['aporte_socio', 'otro_ingreso'])
})

test('utilidad por socio según su participación y lo ya pagado', () => {
  const r = summarize(base)
  const [ana, beto] = r.partners.rows
  assert.strictEqual(r.partners.distributable, 400000)
  assert.strictEqual(ana.share, 240000); assert.strictEqual(ana.paid, 100000); assert.strictEqual(ana.pending, 140000); assert.strictEqual(ana.contributed, 500000)
  assert.strictEqual(beto.share, 120000); assert.strictEqual(beto.contributed, 30000)
  assert.strictEqual(r.partners.retained, 40000) // 10 % sin repartir
})

test('con pérdida no hay utilidad para repartir y los meses salen en orden', () => {
  const r = summarize({ ...base, expenses: [{ category: 'nomina', amount: 2000000, paid_on: '2026-11-01', source: 'fondo' }] })
  assert.ok(r.statement.net < 0)
  assert.strictEqual(r.partners.distributable, 0)
  assert.deepStrictEqual(r.byMonth.map((m) => m.month), ['2026-10', '2026-11'])
})

test('fondo: vacío o general es el fondo general', () => {
  assert.strictEqual(fundSite(''), null); assert.strictEqual(fundSite('general'), null); assert.strictEqual(fundSite('3'), 3)
})
