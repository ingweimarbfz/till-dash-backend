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
