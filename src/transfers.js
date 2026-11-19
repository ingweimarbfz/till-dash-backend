// =====================================================================
// Verificación de transferencias (TD-017)
// · Los cobros y abonos por Nequi, Daviplata o transferencia bancaria no entran al efectivo de la caja:
//   hay que confirmar que sí llegaron a la cuenta o al celular.
// · Cada uno es un movimiento de caja (cash_movements). Su revisión queda en transfer_checks:
//   verificada (llegó) o no_llego, con la cuenta donde se revisó, una nota y la foto del comprobante.
//   Sin revisión = pendiente.
// =====================================================================
const supabase = require('./db')
const { PAY_METHODS, fullName } = require('./ops')

const TRANSFER_METHODS = ['transferencia', 'nequi', 'daviplata']
const CHECK_STATUS = { pendiente: 'Por verificar', verificada: 'Llegó', no_llego: 'No llegó' }

const MOVE_COLUMNS = 'id, session_id, type, method, amount, order_id, receivable_id, ref, note, created_at, user:users(name, last_name), session:cash_sessions!inner(id, number, status, site_id, register:cash_registers(name))'
const CHECK_COLUMNS = 'movement_id, status, account, note, has_proof, checked_at, checker:users!transfer_checks_checked_by_fkey(name, last_name)'

// Referencia y pagador de cada cobro: vienen del pago del pedido (order_payments) o del abono
// (receivable_payments). Un pedido puede tener dos pagos con el mismo medio (cuenta dividida): se
// emparejan por medio y valor, cada pago una sola vez.
const matchPayments = (moves, orderPays, recvPays) => {
  const used = new Set()
  const pick = (list, m, key) => {
    const p = list.find((x, i) => !used.has(`${key}${i}`) && Number(x[key === 'o' ? 'order_id' : 'receivable_id']) === Number(key === 'o' ? m.order_id : m.receivable_id) &&
      x.method === m.method && Math.round(Number(x.amount)) === Math.round(Number(m.amount)) && (!x.session_id || !m.session_id || Number(x.session_id) === Number(m.session_id)))
    if (!p) return null
    used.add(`${key}${list.indexOf(p)}`)
    return p
  }
  return moves.map((m) => {
    const p = m.order_id ? pick(orderPays, m, 'o') : m.receivable_id ? pick(recvPays, m, 'r') : null
    return { reference: p?.reference || null, payer: p?.payer || null }
  })
}

const transferDTO = (m, c, extra = {}) => ({
  id: m.id, sessionId: m.session_id, session: m.session?.number ?? null, sessionOpen: m.session?.status === 'abierta', register: m.session?.register?.name ?? null,
  type: m.type, method: m.method, methodLabel: PAY_METHODS[m.method], amount: Number(m.amount), ref: m.ref, orderId: m.order_id, receivableId: m.receivable_id,
  table: extra.table ?? null, reference: extra.reference ?? null, payer: extra.payer ?? null, chargedBy: fullName(m.user), createdAt: m.created_at,
  status: c?.status || 'pendiente', statusLabel: CHECK_STATUS[c?.status || 'pendiente'], account: c?.account ?? null, checkNote: c?.note ?? null,
  hasProof: Boolean(c?.has_proof), checkedBy: fullName(c?.checker), checkedAt: c?.checked_at ?? null
})

// Totales por estado: cuántas y cuánto suma cada una.
const transferTotals = (rows) => {
  const t = { count: 0, amount: 0, verificada: { count: 0, amount: 0 }, pendiente: { count: 0, amount: 0 }, no_llego: { count: 0, amount: 0 } }
  for (const r of rows) { t.count++; t.amount += r.amount; t[r.status].count++; t[r.status].amount += r.amount }
  return t
}

const inChunks = async (ids, fn) => {
  const out = []
  for (let i = 0; i < ids.length; i += 200) out.push(...((await fn(ids.slice(i, i + 200))).data || []))
  return out
}

// Transferencias de un turno (sessionId) o de una sucursal en un rango de fechas.
const loadTransfers = async ({ sessionId, siteId, from, to } = {}) => {
  let q = supabase.from('cash_movements').select(MOVE_COLUMNS).in('method', TRANSFER_METHODS).in('type', ['venta', 'abono']).gt('amount', 0).order('created_at')
  if (sessionId) q = q.eq('session_id', Number(sessionId))
  if (siteId) q = q.eq('session.site_id', Number(siteId))
  if (from) q = q.gte('created_at', from)
  if (to) q = q.lt('created_at', to)
  const { data: moves, error } = await q.limit(2000)
  if (error) throw error
  if (!moves.length) return []
  const orderIds = [...new Set(moves.map((m) => m.order_id).filter(Boolean))]
  const recvIds = [...new Set(moves.map((m) => m.receivable_id).filter(Boolean))]
  const [checks, orderPays, recvPays, orders] = await Promise.all([
    inChunks(moves.map((m) => m.id), (ids) => supabase.from('transfer_checks').select(CHECK_COLUMNS).in('movement_id', ids)),
    inChunks(orderIds, (ids) => supabase.from('order_payments').select('*').in('order_id', ids).in('method', TRANSFER_METHODS).order('id')),
    inChunks(recvIds, (ids) => supabase.from('receivable_payments').select('*').in('receivable_id', ids).in('method', TRANSFER_METHODS).order('id')),
    inChunks(orderIds, (ids) => supabase.from('orders').select('id, type, customer_name, table:dining_tables!orders_table_id_fkey(name)').in('id', ids))
  ])
  const byCheck = new Map(checks.map((c) => [Number(c.movement_id), c]))
  const byOrder = new Map(orders.map((o) => [Number(o.id), o]))
  const refs = matchPayments(moves, orderPays, recvPays)
  return moves.map((m, i) => {
    const o = byOrder.get(Number(m.order_id))
    const table = o ? (o.table?.name || (o.type === 'domicilio' ? `Domicilio${o.customer_name ? ` · ${o.customer_name}` : ''}` : null)) : null
    return transferDTO(m, byCheck.get(Number(m.id)), { ...refs[i], table })
  })
}

module.exports = { TRANSFER_METHODS, CHECK_STATUS, MOVE_COLUMNS, matchPayments, transferTotals, loadTransfers }
