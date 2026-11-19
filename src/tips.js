// =====================================================================
// Propinas por pagar (TD-020)
// · Lo que los clientes dejan de propina entra con el cobro del pedido (orders.tip).
// · Ya no se reparten en el cierre del turno: se pagan cuando se quiera desde Caja → Propinas (tip_payouts).
// · Por pagar = propinas de los pedidos cobrados − propinas pagadas.
// · Cada propina es de quien atendió el pedido: el mesero, o el domiciliario en un domicilio con domiciliario.
// · Antes del TD-020 las propinas de los domiciliarios se les pagaban en el cierre junto con su parte del
//   domicilio (courier_payouts.tips): esas cuentan como pagadas.
// =====================================================================
const { fullName } = require('./ops')

const TIP_SOURCES = { cierre: 'Cierre de turno', caja: 'Caja del turno', fondo: 'Fondo de la sucursal', transferencia: 'Transferencia' }

// Quién se ganó la propina del pedido.
const tipOwner = (o) => (o.type === 'domicilio' && o.courier_id ? o.courier_id : o.waiter_id || null)

// orders: [{waiter_id, courier_id, type, tip}] · payouts: [{user_id, amount, created_at}] (incluye las propinas
// pagadas a domiciliarios en cierres anteriores) · staff: [{id, name, last_name, role, positions}]
const tipBalance = (orders, payouts, staff = []) => {
  const people = new Map()
  const person = (id, u) => {
    if (!people.has(id)) people.set(id, { userId: id, name: fullName(u) || 'Empleado', role: u?.role ?? null, positions: u?.positions || [], generated: 0, received: 0, payments: 0, lastPaidAt: null })
    return people.get(id)
  }
  for (const u of staff) person(u.id, u)
  let generated = 0; let unassigned = 0
  for (const o of orders) {
    const t = Number(o.tip) || 0
    if (t <= 0) continue
    generated += t
    const id = tipOwner(o)
    if (id) person(id, o.type === 'domicilio' && o.courier_id ? o.courier : o.waiter).generated += t
    else unassigned += t
  }
  let paid = 0
  for (const p of payouts) {
    const amt = Number(p.amount) || 0
    if (amt <= 0 || !p.user_id) continue
    paid += amt
    const x = person(p.user_id, p.user)
    x.received += amt; x.payments += 1
    if (!x.lastPaidAt || p.created_at > x.lastPaidAt) x.lastPaidAt = p.created_at
  }
  const rows = [...people.values()].map((x) => ({
    ...x, generated: Math.round(x.generated), received: Math.round(x.received),
    // Lo que le falta según los pedidos que atendió (si antes se repartió en grupo, puede haber recibido más o menos).
    pending: Math.max(0, Math.round(x.generated - x.received))
  })).sort((a, b) => b.pending - a.pending || b.generated - a.generated || a.name.localeCompare(b.name))
  return { generated: Math.round(generated), paid: Math.round(paid), pending: Math.max(0, Math.round(generated - paid)), unassigned: Math.round(unassigned), people: rows }
}

// Pagos del formulario: [{userId, amount}] → [{user_id, amount}]
const cleanPayments = (list) => {
  const out = []
  const seen = new Set()
  for (const p of Array.isArray(list) ? list : []) {
    const amount = Math.round(Number(p?.amount))
    if (!Number.isFinite(amount) || amount < 0) return { error: 'Revisa los valores a pagar' }
    if (!amount) continue
    const userId = Number(p.userId)
    if (!userId) return { error: 'Elige el empleado de cada pago' }
    if (seen.has(userId)) return { error: 'Un empleado aparece dos veces en el pago' }
    seen.add(userId)
    out.push({ user_id: userId, amount })
  }
  if (!out.length) return { error: 'Escribe cuánto se le paga a cada empleado' }
  return { payments: out, total: out.reduce((a, p) => a + p.amount, 0) }
}

const payoutDTO = (t) => ({
  id: t.id, number: t.number || null, userId: t.user_id, name: fullName(t.user), amount: Number(t.amount),
  source: t.source || 'cierre', sourceLabel: TIP_SOURCES[t.source || 'cierre'], method: t.method || 'efectivo', session: t.session?.number ?? null,
  note: t.note || null, paidBy: fullName(t.payer), createdAt: t.created_at
})

module.exports = { TIP_SOURCES, tipOwner, tipBalance, cleanPayments, payoutDTO }

// ---------------------------------------------------------------- Pagos al personal (turnos, domicilios y nómina)
const EARNING_KINDS = { turno: 'Turno', domicilios: 'Domicilios', nomina: 'Nómina' }
const pad = (n) => String(n).padStart(2, '0')
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()  // m: 1-12
// Periodo de nómina que contiene el día (YYYY-MM-DD): quincena (1-15 / 16-fin) o mes completo.
const payPeriod = (day, period = 'mensual') => {
  const [y, m, d] = day.split('-').map(Number)
  const end = lastDay(y, m)
  if (period === 'quincenal') return d <= 15 ? { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-15` } : { from: `${y}-${pad(m)}-16`, to: `${y}-${pad(m)}-${pad(end)}` }
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(end)}` }
}
// Periodo anterior al que empieza en `from`.
const prevPeriod = (from, period = 'mensual') => {
  const [y, m, d] = from.split('-').map(Number)
  if (period === 'quincenal' && d === 16) return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-15` }
  const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y
  return period === 'quincenal' ? { from: `${py}-${pad(pm)}-16`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` } : { from: `${py}-${pad(pm)}-01`, to: `${py}-${pad(pm)}-${pad(lastDay(py, pm))}` }
}
// Lo que se sugiere pagar de nómina: el periodo más antiguo sin pagar entre el anterior y el actual.
const payrollDue = (today, period, paidFroms = []) => {
  const cur = payPeriod(today, period)
  const prev = prevPeriod(cur.from, period)
  const paid = new Set(paidFroms)
  if (!paid.has(prev.from)) return { ...prev, current: false }
  if (!paid.has(cur.from)) return { ...cur, current: true }
  return null
}

const cleanEarnings = (ids) => {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))]
  return list
}
const cleanPayroll = (list) => {
  const out = []
  for (const p of Array.isArray(list) ? list : []) {
    const amount = Math.round(Number(p?.amount))
    const day = /^\d{4}-\d{2}-\d{2}$/
    if (!Number(p?.userId) || !(amount > 0) || !day.test(p.from || '') || !day.test(p.to || '') || p.to < p.from) return { error: 'Revisa el empleado, el periodo y el valor de la nómina' }
    out.push({ user_id: Number(p.userId), amount, period_from: p.from, period_to: p.to })
  }
  return { payroll: out }
}

const earningDTO = (e) => ({
  id: e.id, userId: e.user_id, name: fullName(e.user), kind: e.kind, kindLabel: EARNING_KINDS[e.kind], session: e.session?.number ?? null,
  hours: e.hours === null ? null : Number(e.hours), rate: e.rate === null ? null : Number(e.rate), extraHours: e.extra_hours === null || e.extra_hours === undefined ? null : Number(e.extra_hours), fixed: Boolean(e.fixed), deliveries: e.deliveries, periodFrom: e.period_from, periodTo: e.period_to,
  amount: Number(e.amount), note: e.note, status: e.status, createdAt: e.created_at,
  paidAt: e.paid_at, paidSource: e.paid_source, paidSourceLabel: e.paid_source ? TIP_SOURCES[e.paid_source] : null, paidMethod: e.paid_method, paidNumber: e.paid_number, paidBy: fullName(e.payer)
})

module.exports.EARNING_KINDS = EARNING_KINDS
module.exports.payPeriod = payPeriod
module.exports.prevPeriod = prevPeriod
module.exports.payrollDue = payrollDue
module.exports.cleanEarnings = cleanEarnings
module.exports.cleanPayroll = cleanPayroll
module.exports.earningDTO = earningDTO
