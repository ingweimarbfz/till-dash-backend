// =====================================================================
// Caja, bóveda y cuentas por cobrar (TD-003)
// · Cajas por sucursal. Cada caja trabaja por turnos: apertura con base (opcional desde la bóveda),
//   cobros, abonos, ingresos y egresos, y cierre con arqueo (esperado vs. contado).
// · Al cerrar, el efectivo que no se queda de base pasa a la bóveda de la sucursal.
// · Bóveda: depósitos, retiros y consignaciones al banco (solo administrador).
// · Cuentas por cobrar: nacen al cobrar un pedido con "cuenta por cobrar" y se abonan en un turno.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { notify, cashOpenMessage, cashCloseMessage, vaultMessage } = require('../notify')
const { guard, workSite, sameSite, dbError, money, isMoney, PAY_METHODS, fullName } = require('../ops')

const router = express.Router()

const MOVE_TYPES = { apertura: 'Base de apertura', venta: 'Venta', abono: 'Abono a cuenta', ingreso: 'Ingreso', egreso: 'Egreso', a_boveda: 'A la bóveda', propina_pagada: 'Propina pagada' }
const VAULT_TYPES = { deposito: 'Depósito', retiro: 'Retiro', cierre_caja: 'Cierre de caja', base_caja: 'Base de caja', consignacion: 'Consignación al banco', ajuste: 'Ajuste' }

const registerDTO = (r) => ({ id: r.id, siteId: r.site_id, site: r.site?.name ?? null, name: r.name, active: r.active })

// Resumen de un turno: ventas por forma de pago, propinas, abonos, ingresos, egresos y efectivo esperado.
const sessionSummary = async (s) => {
  const [{ data: moves }, { data: orders }] = await Promise.all([
    supabase.from('cash_movements').select('*, user:users(name, last_name)').eq('session_id', s.id).order('created_at'),
    supabase.from('orders').select('id, number, total, tip, discount_total, courtesy_total, table:dining_tables(name), closed_at').eq('session_id', s.id).eq('status', 'cobrado').order('closed_at')
  ])
  const m = moves || []
  const byMethod = {}
  for (const x of m.filter((y) => y.type === 'venta' || y.type === 'abono')) byMethod[x.method] = (byMethod[x.method] || 0) + Number(x.amount)
  const sum = (t) => m.filter((x) => x.type === t).reduce((a, x) => a + Number(x.amount), 0)
  const expected = m.filter((x) => x.method === 'efectivo').reduce((a, x) => a + Number(x.amount), 0)
  const os = orders || []
  return {
    sales: sum('venta'), receivablePayments: sum('abono'), income: sum('ingreso'), expenses: -sum('egreso'), toVault: -sum('a_boveda'),
    tips: os.reduce((a, o) => a + Number(o.tip), 0), discounts: os.reduce((a, o) => a + Number(o.discount_total), 0),
    courtesies: os.reduce((a, o) => a + Number(o.courtesy_total), 0), orders: os.length,
    byMethod: Object.entries(byMethod).map(([method, amount]) => ({ method, label: PAY_METHODS[method], amount })),
    expectedCash: s.status === 'cerrada' ? Number(s.expected_cash) : expected,
    movements: m.map((x) => ({ id: x.id, type: x.type, typeLabel: MOVE_TYPES[x.type], method: x.method, methodLabel: PAY_METHODS[x.method], amount: Number(x.amount), ref: x.ref, note: x.note, orderId: x.order_id, user: fullName(x.user), createdAt: x.created_at })),
    orderList: os.map((o) => ({ id: o.id, number: o.number, table: o.table?.name ?? null, total: Number(o.total), tip: Number(o.tip), closedAt: o.closed_at }))
  }
}
const SESSION_COLUMNS = '*, register:cash_registers(name), site:sites(name), opener:users!cash_sessions_opened_by_fkey(name, last_name), closer:users!cash_sessions_closed_by_fkey(name, last_name)'
const sessionDTO = (s) => ({
  id: s.id, number: s.number, status: s.status, siteId: s.site_id, site: s.site?.name ?? null, registerId: s.register_id, register: s.register?.name ?? null,
  openingAmount: Number(s.opening_amount), expectedCash: s.expected_cash === null ? null : Number(s.expected_cash), countedCash: s.counted_cash === null ? null : Number(s.counted_cash),
  difference: s.difference === null ? null : Number(s.difference), toVault: Number(s.to_vault), openedBy: fullName(s.opener), closedBy: fullName(s.closer),
  openedById: s.opened_by, openedAt: s.opened_at, closedAt: s.closed_at, note: s.note, closeNote: s.close_note
})
const loadSession = async (id) => (await supabase.from('cash_sessions').select(SESSION_COLUMNS).eq('id', Number(id)).maybeSingle()).data

// ---------------------------------------------------------------- Cajas
router.get('/caja/cajas', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('cash_registers').select('*, site:sites(name)').order('site_id').order('name')
  const site = ADMIN.includes(req.user.role) ? req.siteId : req.user.site_id
  if (site) q = q.eq('site_id', site)
  const [{ data, error }, { data: open }] = await Promise.all([q, supabase.from('cash_sessions').select(SESSION_COLUMNS).eq('status', 'abierta')])
  if (error) throw error
  res.send(data.map((r) => {
    const s = (open || []).find((x) => x.register_id === r.id)
    return { ...registerDTO(r), session: s ? sessionDTO(s) : null }
  }))
}))
router.post('/caja/cajas', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'Escribe el nombre de la caja', 400)
  const site = await workSite(req, req.body.siteId)
  const { data, error } = await supabase.from('cash_registers').insert({ site_id: site, name }).select('*, site:sites(name)').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una caja con ese nombre en la sucursal', 409) : fail(res, error)
  await audit(req, 'crear', 'caja', data.id, { name })
  res.status(201).send(registerDTO(data))
}))
router.put('/caja/cajas/:id', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'Escribe el nombre de la caja', 400)
  const active = req.body.active !== false
  if (!active) {
    const { count } = await supabase.from('cash_sessions').select('id', { count: 'exact', head: true }).eq('register_id', Number(req.params.id)).eq('status', 'abierta')
    if (count) return fail(res, 'La caja tiene un turno abierto: ciérralo antes de desactivarla', 409)
  }
  const { data, error } = await supabase.from('cash_registers').update({ name, active }).eq('id', Number(req.params.id)).select('*, site:sites(name)').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una caja con ese nombre en la sucursal', 409) : fail(res, error)
  if (!data) return fail(res, 'Caja no encontrada', 404)
  await audit(req, 'editar', 'caja', data.id, { name, active })
  res.send(registerDTO(data))
}))

// ---------------------------------------------------------------- Turnos
router.get('/caja/turnos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  let q = supabase.from('cash_sessions').select(SESSION_COLUMNS).order('opened_at', { ascending: false }).limit(Math.min(Number(req.query.limite) || 60, 200))
  const site = ADMIN.includes(req.user.role) ? req.siteId : req.user.site_id
  if (site) q = q.eq('site_id', site)
  if (['abierta', 'cerrada'].includes(req.query.estado)) q = q.eq('status', req.query.estado)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(sessionDTO))
}))
router.get('/caja/turnos/:id', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  res.send({ ...sessionDTO(s), summary: await sessionSummary(s) })
}))
router.post('/caja/turnos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const b = req.body || {}
  if (!Number(b.registerId)) return fail(res, 'Elige la caja', 400)
  if (b.openingAmount !== undefined && !isMoney(b.openingAmount)) return fail(res, 'La base no es válida', 400)
  const { data: reg } = await supabase.from('cash_registers').select('id, name, site_id, site:sites(name)').eq('id', Number(b.registerId)).maybeSingle()
  if (!reg || !sameSite(req, reg.site_id)) return fail(res, 'Caja no encontrada', 404)
  const fromVault = Boolean(b.fromVault)
  const { data: id, error } = await supabase.rpc('open_cash_session', { p: { org_id: req.user.org_id, register_id: reg.id, user_id: req.user.id, opening_amount: money(b.openingAmount), from_vault: fromVault, note: clean(b.note) } })
  if (error) return dbError(res, error)
  const s = await loadSession(id)
  await audit(req, 'abrir', 'turno_caja', s.id, { number: s.number, register: reg.name, opening: Number(s.opening_amount), fromVault })
  notify('caja', () => cashOpenMessage({ number: s.number, register: reg.name, site: reg.site?.name, siteId: reg.site_id, amount: Number(s.opening_amount), fromVault, user: req.user }))
  res.status(201).send(sessionDTO(s))
}))
// Ingreso o egreso de efectivo (compras menores, pago de propinas, cambio…).
router.post('/caja/turnos/:id/movimientos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  if (s.status !== 'abierta') return fail(res, 'El turno ya está cerrado', 409)
  const b = req.body || {}
  const type = ['ingreso', 'egreso', 'propina_pagada'].includes(b.type) ? b.type : null
  if (!type) return fail(res, 'Elige si es ingreso o egreso', 400)
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  if (!clean(b.note)) return fail(res, 'Escribe el concepto', 400)
  const amount = money(b.amount) * (type === 'ingreso' ? 1 : -1)
  if (amount < 0) {
    const { data: cash } = await supabase.rpc('session_cash', { p_session: s.id })
    if (Number(cash) + amount < 0) return fail(res, `No hay suficiente efectivo en la caja (disponible: $${Math.round(Number(cash)).toLocaleString('es-CO')})`, 400)
  }
  const { data, error } = await supabase.from('cash_movements').insert({ session_id: s.id, type, method: 'efectivo', amount, ref: s.number, note: clean(b.note), user_id: req.user.id }).select('id').single()
  if (error) throw error
  await audit(req, type, 'turno_caja', s.id, { number: s.number, amount, note: clean(b.note) })
  res.status(201).send({ id: data.id })
}))
router.post('/caja/turnos/:id/cerrar', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  const b = req.body || {}
  if (!isMoney(b.countedCash)) return fail(res, 'Escribe el efectivo contado', 400)
  if (b.toVault !== undefined && b.toVault !== '' && !isMoney(b.toVault)) return fail(res, 'El valor para la bóveda no es válido', 400)
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('site_id', s.site_id).eq('status', 'abierto')
  const { data: open } = await supabase.from('cash_sessions').select('id').eq('site_id', s.site_id).eq('status', 'abierta')
  if (count && (open || []).length === 1 && !b.force) return fail(res, `Quedan ${count} pedido${count === 1 ? '' : 's'} abierto${count === 1 ? '' : 's'} en la sucursal. Cóbralos o confirma el cierre igualmente.`, 409)
  const before = await sessionSummary(s)
  const { data, error } = await supabase.rpc('close_cash_session', { p: { org_id: req.user.org_id, session_id: s.id, user_id: req.user.id, counted_cash: money(b.countedCash), to_vault: money(b.toVault), note: clean(b.note) } })
  if (error) return dbError(res, error)
  await audit(req, 'cerrar', 'turno_caja', s.id, { number: s.number, expected: Number(data.expected), counted: Number(data.counted), difference: Number(data.difference), toVault: Number(data.toVault) })
  notify('caja', () => cashCloseMessage({
    number: s.number, register: s.register?.name, site: s.site?.name, siteId: s.site_id, sales: before.sales, tips: before.tips, orders: before.orders,
    byMethod: Object.fromEntries(before.byMethod.map((x) => [x.label, x.amount])), expected: Number(data.expected), counted: Number(data.counted),
    difference: Number(data.difference), toVault: Number(data.toVault), user: req.user
  }))
  const after = await loadSession(s.id)
  res.send({ ...sessionDTO(after), summary: await sessionSummary(after) })
}))

// ---------------------------------------------------------------- Bóveda
router.get('/caja/boveda', auth(ADMIN), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const { data: vid, error } = await supabase.rpc('vault_of', { p_org: req.user.org_id, p_site: site })
  if (error) throw error
  const [{ data: v }, { data: moves }, { data: all }] = await Promise.all([
    supabase.from('vaults').select('*, site:sites(name)').eq('id', vid).maybeSingle(),
    supabase.from('vault_movements').select('*, user:users(name, last_name)').eq('vault_id', vid).order('created_at', { ascending: false }).limit(80),
    supabase.from('vaults').select('balance, site:sites(name)')
  ])
  res.send({
    id: v.id, siteId: v.site_id, site: v.site?.name, balance: Number(v.balance),
    total: (all || []).reduce((a, x) => a + Number(x.balance), 0),
    bySite: (all || []).map((x) => ({ site: x.site?.name, balance: Number(x.balance) })),
    movements: (moves || []).map((m) => ({ id: m.id, type: m.type, typeLabel: VAULT_TYPES[m.type], amount: Number(m.amount), balanceAfter: Number(m.balance_after), ref: m.ref, note: m.note, user: fullName(m.user), createdAt: m.created_at }))
  })
}))
router.post('/caja/boveda/movimientos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const type = ['deposito', 'retiro', 'consignacion', 'ajuste'].includes(b.type) ? b.type : null
  if (!type) return fail(res, 'Elige el tipo de movimiento', 400)
  const raw = Number(b.amount)
  if (!raw || (type !== 'ajuste' && raw < 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  if (type !== 'deposito' && !clean(b.note)) return fail(res, 'Escribe el concepto o la referencia', 400)
  const amount = type === 'deposito' ? money(raw) : type === 'ajuste' ? Math.round(raw) : -money(raw)
  const site = await workSite(req, b.siteId)
  const { data: vid } = await supabase.rpc('vault_of', { p_org: req.user.org_id, p_site: site })
  const { data, error } = await supabase.from('vault_movements').insert({ vault_id: vid, type, amount, note: clean(b.note), ref: clean(b.ref), user_id: req.user.id }).select('balance_after').single()
  if (error) return dbError(res, error)
  const { data: s } = await supabase.from('sites').select('name').eq('id', site).maybeSingle()
  await audit(req, type, 'boveda', vid, { amount, note: clean(b.note) })
  notify('caja', () => vaultMessage({ label: VAULT_TYPES[type], amount, balance: Number(data.balance_after), note: clean(b.note), site: s?.name, siteId: site, user: req.user }))
  res.status(201).send({ balance: Number(data.balance_after) })
}))

// ---------------------------------------------------------------- Cuentas por cobrar
const receivableDTO = (r) => ({
  id: r.id, number: r.number, siteId: r.site_id, site: r.site?.name ?? null, orderId: r.order_id, order: r.order?.number ?? null,
  customerName: r.customer_name, customerDoc: r.customer_doc, customerPhone: r.customer_phone, amount: Number(r.amount), paid: Number(r.paid),
  balance: Number(r.amount) - Number(r.paid), status: r.status, dueDate: r.due_date, overdue: r.status === 'pendiente' && r.due_date && r.due_date < new Date().toISOString().slice(0, 10),
  note: r.note, createdAt: r.created_at, paidAt: r.paid_at, createdBy: fullName(r.creator)
})
const CXC_COLUMNS = '*, site:sites(name), order:orders(number), creator:users!receivables_created_by_fkey(name, last_name)'

router.get('/cuentas-por-cobrar', auth(STAFF), guard('cajero'), h(async (req, res) => {
  let q = supabase.from('receivables').select(CXC_COLUMNS).order('created_at', { ascending: false }).limit(300)
  const site = ADMIN.includes(req.user.role) ? req.siteId : req.user.site_id
  if (site) q = q.eq('site_id', site)
  if (['pendiente', 'pagada', 'anulada'].includes(req.query.estado)) q = q.eq('status', req.query.estado)
  if (clean(req.query.q)) { const t = clean(req.query.q).replace(/[%,()]/g, ''); q = q.or(`customer_name.ilike.%${t}%,number.ilike.%${t}%,customer_doc.ilike.%${t}%`) }
  const { data, error } = await q
  if (error) throw error
  const rows = data.map(receivableDTO)
  res.send({ rows, pending: rows.filter((r) => r.status === 'pendiente').reduce((a, r) => a + r.balance, 0) })
}))
router.get('/cuentas-por-cobrar/:id', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const { data: r } = await supabase.from('receivables').select(CXC_COLUMNS).eq('id', Number(req.params.id)).maybeSingle()
  if (!r || !sameSite(req, r.site_id)) return fail(res, 'Cuenta no encontrada', 404)
  const { data: pays } = await supabase.from('receivable_payments').select('*, user:users(name, last_name)').eq('receivable_id', r.id).order('created_at')
  res.send({ ...receivableDTO(r), payments: (pays || []).map((p) => ({ id: p.id, method: p.method, methodLabel: PAY_METHODS[p.method], amount: Number(p.amount), reference: p.reference, user: fullName(p.user), createdAt: p.created_at })) })
}))
router.post('/cuentas-por-cobrar/:id/abonos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const b = req.body || {}
  const { data: r } = await supabase.from('receivables').select('id, site_id, number, customer_name').eq('id', Number(req.params.id)).maybeSingle()
  if (!r || !sameSite(req, r.site_id)) return fail(res, 'Cuenta no encontrada', 404)
  if (!PAY_METHODS[b.method] || b.method === 'cuenta_por_cobrar') return fail(res, 'Elige la forma de pago', 400)
  const { data: open } = await supabase.from('cash_sessions').select('id, opened_by').eq('site_id', r.site_id).eq('status', 'abierta')
  const session = Number(b.sessionId) ? (open || []).find((s) => s.id === Number(b.sessionId)) : (open || []).find((s) => s.opened_by === req.user.id) || ((open || []).length === 1 ? open[0] : null)
  if (!session) return fail(res, 'Abre un turno de caja en la sucursal para recibir el abono', 400)
  const { data, error } = await supabase.rpc('pay_receivable', { p: { org_id: req.user.org_id, receivable_id: r.id, session_id: session.id, user_id: req.user.id, method: b.method, amount: money(b.amount), reference: clean(b.reference) } })
  if (error) return dbError(res, error)
  await audit(req, 'abonar', 'cuenta_por_cobrar', r.id, { number: r.number, amount: money(b.amount), method: b.method })
  res.status(201).send({ balance: Number(data.balance) })
}))
router.post('/cuentas-por-cobrar/:id/anular', auth(ADMIN), h(async (req, res) => {
  const reason = clean(req.body?.reason)
  if (!reason) return fail(res, 'Escribe el motivo', 400)
  const { data, error } = await supabase.from('receivables').update({ status: 'anulada', note: reason }).eq('id', Number(req.params.id)).eq('status', 'pendiente').select('id, number').maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'La cuenta no está pendiente', 409)
  await audit(req, 'anular', 'cuenta_por_cobrar', data.id, { number: data.number, reason })
  res.send({ ok: true })
}))

module.exports = router
module.exports.MOVE_TYPES = MOVE_TYPES
module.exports.VAULT_TYPES = VAULT_TYPES
