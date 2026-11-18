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
const { resolveSupplier } = require('../suppliers')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { notify, cashOpenMessage, cashCloseMessage, vaultMessage, cashRequestMessage, cashReopenMessage } = require('../notify')
const { guard, workSite, sameSite, dbError, money, isMoney, PAY_METHODS, fullName } = require('../ops')

const router = express.Router()
const { courierSettlement } = require('./deliveries')

const MOVE_TYPES = { apertura: 'Base de apertura', venta: 'Venta', abono: 'Abono a cuenta', ingreso: 'Ingreso', egreso: 'Egreso', a_boveda: 'A la bóveda', propina_pagada: 'Propina pagada', domicilio_pagado: 'Pago a domiciliario', base_domiciliario: 'Base al domiciliario', retorno_domiciliario: 'Devolución del domiciliario' }
const VAULT_TYPES = { deposito: 'Depósito', retiro: 'Retiro', cierre_caja: 'Cierre de caja', base_caja: 'Base de caja', consignacion: 'Consignación al banco', ajuste: 'Ajuste', ingreso: 'Ingreso de dinero', gasto: 'Gasto', traslado: 'Traslado', retiro_socio: 'Retiro de socio', anulacion: 'Anulación' }

const registerDTO = (r) => ({ id: r.id, siteId: r.site_id, site: r.site?.name ?? null, name: r.name, active: r.active, floatAmount: Number(r.float_amount || 0) })

// Resumen de un turno: ventas por forma de pago, propinas, abonos, ingresos, egresos y efectivo esperado.
const sessionSummary = async (s) => {
  const [{ data: moves }, { data: orders }, { data: payouts }, { data: credit }, { data: couriers }] = await Promise.all([
    supabase.from('cash_movements').select('*, user:users(name, last_name)').eq('session_id', s.id).order('created_at'),
    supabase.from('orders').select('id, number, total, tip, discount_total, courtesy_total, table:dining_tables!orders_table_id_fkey(name), closed_at').eq('session_id', s.id).eq('status', 'cobrado').order('closed_at'),
    supabase.from('tip_payouts').select('id, amount, user_id, user:users!tip_payouts_user_id_fkey(name, last_name)').eq('session_id', s.id).order('id'),
    // Cobrado a cuenta por cobrar: no entra dinero a la caja, pero se vendió en el turno.
    supabase.from('order_payments').select('amount').eq('session_id', s.id).eq('method', 'cuenta_por_cobrar'),
    supabase.from('courier_payouts').select('id, amount, deliveries, fees, share, tips, user_id, user:users!courier_payouts_user_id_fkey(name, last_name)').eq('session_id', s.id).order('id').then((r) => (r.error ? { data: [] } : r))
  ])
  const m = moves || []
  const byMethod = {}
  for (const x of m.filter((y) => y.type === 'venta' || y.type === 'abono')) byMethod[x.method] = (byMethod[x.method] || 0) + Number(x.amount)
  const cxc = (credit || []).reduce((a, x) => a + Number(x.amount), 0)
  if (cxc) byMethod.cuenta_por_cobrar = (byMethod.cuenta_por_cobrar || 0) + cxc
  const sum = (t) => m.filter((x) => x.type === t).reduce((a, x) => a + Number(x.amount), 0)
  const expected = m.filter((x) => x.method === 'efectivo').reduce((a, x) => a + Number(x.amount), 0)
  const os = orders || []
  return {
    sales: sum('venta'), receivablePayments: sum('abono'), income: sum('ingreso'), expenses: -sum('egreso'), toVault: -sum('a_boveda'),
    tips: os.reduce((a, o) => a + Number(o.tip), 0), discounts: os.reduce((a, o) => a + Number(o.discount_total), 0),
    courtesies: os.reduce((a, o) => a + Number(o.courtesy_total), 0), orders: os.length,
    byMethod: Object.entries(byMethod).map(([method, amount]) => ({ method, label: PAY_METHODS[method], amount })),
    tipsPaid: -sum('propina_pagada'), couriersPaid: -sum('domicilio_pagado'), courierFloats: sum('base_domiciliario') + sum('retorno_domiciliario'),
    expectedCash: s.status === 'cerrada' ? Number(s.expected_cash) : expected,
    movements: m.map((x) => ({ id: x.id, type: x.type, typeLabel: MOVE_TYPES[x.type], method: x.method, methodLabel: PAY_METHODS[x.method], amount: Number(x.amount), ref: x.ref, note: x.note, orderId: x.order_id, user: fullName(x.user), createdAt: x.created_at })),
    tipPayouts: (payouts || []).map((t) => ({ id: t.id, userId: t.user_id, name: fullName(t.user), amount: Number(t.amount) })),
    courierPayouts: (couriers || []).map((t) => ({ id: t.id, userId: t.user_id, name: fullName(t.user), amount: Number(t.amount), deliveries: t.deliveries, fees: Number(t.fees), share: Number(t.share), tips: Number(t.tips) })),
    orderList: os.map((o) => ({ id: o.id, number: o.number, table: o.table?.name ?? null, total: Number(o.total), tip: Number(o.tip), closedAt: o.closed_at }))
  }
}
const SESSION_COLUMNS = '*, register:cash_registers(name), site:sites(name), opener:users!cash_sessions_opened_by_fkey(name, last_name), closer:users!cash_sessions_closed_by_fkey(name, last_name)'
const sessionDTO = (s) => ({
  id: s.id, number: s.number, status: s.status, siteId: s.site_id, site: s.site?.name ?? null, registerId: s.register_id, register: s.register?.name ?? null,
  openingAmount: Number(s.opening_amount), expectedCash: s.expected_cash === null ? null : Number(s.expected_cash), countedCash: s.counted_cash === null ? null : Number(s.counted_cash),
  difference: s.difference === null ? null : Number(s.difference), toVault: Number(s.to_vault), tipsPaid: Number(s.tips_paid || 0), couriersPaid: Number(s.couriers_paid || 0), nextFloat: Number(s.next_float || 0), openedBy: fullName(s.opener), closedBy: fullName(s.closer),
  openedById: s.opened_by, openedAt: s.opened_at, closedAt: s.closed_at, note: s.note, closeNote: s.close_note,
  reopenCount: Number(s.reopen_count || 0), reopenedAt: s.reopened_at || null
})
const loadSession = async (id) => (await supabase.from('cash_sessions').select(SESSION_COLUMNS).eq('id', Number(id)).maybeSingle()).data

// ---------------------------------------------------------------- Cajas
router.get('/caja/cajas', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('cash_registers').select('*, site:sites(name)').order('site_id').order('name')
  const site = ADMIN.includes(req.user.role) ? req.siteId : req.user.site_id
  if (site) q = q.eq('site_id', site)
  const [{ data, error }, { data: open }, { data: vaults }] = await Promise.all([q, supabase.from('cash_sessions').select(SESSION_COLUMNS).eq('status', 'abierta'), supabase.from('vaults').select('site_id, balance').eq('kind', 'principal').not('site_id', 'is', null)])
  if (error) throw error
  // siteFund: lo que hay en el fondo de la sucursal para completar la base al abrir.
  res.send(data.map((r) => {
    const s = (open || []).find((x) => x.register_id === r.id)
    const v = (vaults || []).find((x) => x.site_id === r.site_id)
    return { ...registerDTO(r), siteFund: Number(v?.balance || 0), session: s ? sessionDTO(s) : null }
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
  const [summary, reopen] = await Promise.all([sessionSummary(s), reopenInfo(s)])
  res.send({ ...sessionDTO(s), summary, reopen })
}))
router.post('/caja/turnos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const b = req.body || {}
  if (!Number(b.registerId)) return fail(res, 'Elige la caja', 400)
  if (!isMoney(b.openingAmount) || !(Number(b.openingAmount) > 0)) return fail(res, 'Escribe la base con la que abre la caja', 400)
  const { data: reg } = await supabase.from('cash_registers').select('id, name, site_id, float_amount, site:sites(name)').eq('id', Number(b.registerId)).maybeSingle()
  if (!reg || !sameSite(req, reg.site_id)) return fail(res, 'Caja no encontrada', 404)
  // La base sale de lo que quedó en la caja y, si falta, del fondo de la sucursal (Finanzas → Fondos).
  const fromVault = money(b.openingAmount) > Number(reg.float_amount || 0)
  const { data: id, error } = await supabase.rpc('open_cash_session', { p: { org_id: req.user.org_id, register_id: reg.id, user_id: req.user.id, opening_amount: money(b.openingAmount), note: clean(b.note) } })
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
  if (type === 'egreso' && !ADMIN.includes(req.user.role)) return fail(res, 'Registra el egreso como gasto del turno (o pide recursos al administrador si supera el tope)', 403)
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
// Empleados para repartir las propinas del turno: los de la sucursal, con la sugerencia según
// las propinas de los pedidos que atendió cada uno.
router.get('/caja/turnos/:id/propinas', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  const month = new Date(Date.now() - 30 * 864e5).toISOString()
  const [{ data: staff }, { data: orders }, { data: sessOrders }, { data: monthRatings }] = await Promise.all([
    supabase.from('users').select('id, name, last_name, role, positions, site_id').eq('active', true).in('role', ['empleado', 'admin']).order('name'),
    supabase.from('orders').select('waiter_id, tip, type, courier_id').eq('session_id', s.id).eq('status', 'cobrado').gt('tip', 0),
    supabase.from('orders').select('id').eq('session_id', s.id),
    supabase.from('service_ratings').select('waiter_id, stars').gte('created_at', month)
  ])
  // Calificaciones del turno (de sus pedidos) y de los últimos 30 días, por empleado.
  const ids = (sessOrders || []).map((o) => o.id)
  const { data: shiftRatings } = ids.length ? await supabase.from('service_ratings').select('waiter_id, stars').in('order_id', ids) : { data: [] }
  const avgBy = (rows) => {
    const m = {}
    for (const r of rows || []) if (r.waiter_id) { m[r.waiter_id] = m[r.waiter_id] || { sum: 0, n: 0 }; m[r.waiter_id].sum += r.stars; m[r.waiter_id].n++ }
    return m
  }
  const shiftR = avgBy(shiftRatings); const monthR = avgBy(monthRatings)
  const rating = (m, id) => (m[id] ? { avg: Math.round((m[id].sum / m[id].n) * 10) / 10, count: m[id].n } : null)
  const byWaiter = {}
  // Las propinas de un domicilio con domiciliario son de él y se le pagan aparte (Domiciliarios).
  for (const o of (orders || []).filter((x) => !(x.type === 'domicilio' && x.courier_id))) if (o.waiter_id) byWaiter[o.waiter_id] = (byWaiter[o.waiter_id] || 0) + Number(o.tip)
  const total = Object.values(byWaiter).reduce((a, x) => a + x, 0)
  res.send({
    total,
    employees: (staff || []).filter((u) => !u.site_id || u.site_id === s.site_id || byWaiter[u.id]).map((u) => ({
      id: u.id, name: fullName(u), role: u.role, positions: u.positions || [], suggested: Math.round(byWaiter[u.id] || 0), served: Boolean(byWaiter[u.id]),
      rating: rating(shiftR, u.id), ratingMonth: rating(monthR, u.id)
    })).sort((a, b) => Number(b.served) - Number(a.served) || a.name.localeCompare(b.name))
  })
}))

// Cierre: efectivo contado, propinas pagadas a cada empleado, base que queda para el próximo turno
// y el resto pasa a la bóveda. Más una observación.
router.post('/caja/turnos/:id/cerrar', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  const b = req.body || {}
  if (!isMoney(b.countedCash)) return fail(res, 'Escribe el efectivo contado', 400)
  if (b.nextFloat !== undefined && b.nextFloat !== '' && !isMoney(b.nextFloat)) return fail(res, 'La base para el próximo turno no es válida', 400)
  const tips = (Array.isArray(b.tips) ? b.tips : []).filter((t) => Number(t?.amount) > 0)
  if (tips.some((t) => !Number(t.userId) || !isMoney(t.amount))) return fail(res, 'Revisa los valores de las propinas', 400)
  if (new Set(tips.map((t) => Number(t.userId))).size !== tips.length) return fail(res, 'Un empleado aparece dos veces en las propinas', 400)
  const couriers = (Array.isArray(b.couriers) ? b.couriers : []).filter((t) => Number(t?.amount) > 0)
  if (couriers.some((t) => !Number(t.userId) || !isMoney(t.amount))) return fail(res, 'Revisa los valores de los domiciliarios', 400)
  // Lo que el sistema calculó para cada domiciliario (domicilios y propinas) queda guardado con el pago.
  const settle = couriers.length ? await courierSettlement(s.id) : { rows: [] }
  // El domiciliario que tiene una base de este turno debe liquidarla antes del cierre (trae la base y lo cobrado).
  const { data: floats } = await supabase.from('courier_floats').select('id, user:users!courier_floats_user_id_fkey(name, last_name)').eq('session_id', s.id).eq('status', 'abierta').then((r) => (r.error ? { data: [] } : r))
  if ((floats || []).length) return fail(res, `Falta liquidar la base de ${floats.map((f) => fullName(f.user)).join(', ')}. Hazlo en Domicilios antes de cerrar.`, 409)
  const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('site_id', s.site_id).eq('status', 'abierto')
  const { data: open } = await supabase.from('cash_sessions').select('id').eq('site_id', s.site_id).eq('status', 'abierta')
  if (count && (open || []).length === 1 && !b.force) return fail(res, `Quedan ${count} pedido${count === 1 ? '' : 's'} abierto${count === 1 ? '' : 's'} en la sucursal. Cóbralos o confirma el cierre igualmente.`, 409)
  const before = await sessionSummary(s)
  const { data, error } = await supabase.rpc('close_cash_session', { p: {
    org_id: req.user.org_id, session_id: s.id, user_id: req.user.id, counted_cash: money(b.countedCash), next_float: money(b.nextFloat),
    tips: tips.map((t) => ({ user_id: Number(t.userId), amount: money(t.amount) })), note: clean(b.note),
    couriers: couriers.map((t) => { const c = settle.rows.find((r) => r.userId === Number(t.userId)) || {}; return { user_id: Number(t.userId), amount: money(t.amount), deliveries: c.deliveries || 0, fees: c.fees || 0, share: c.share || 0, tips: c.tips || 0 } })
  } })
  if (error) return dbError(res, error)
  const after = await loadSession(s.id)
  const summary = await sessionSummary(after)
  await audit(req, 'cerrar', 'turno_caja', s.id, { number: s.number, expected: Number(data.expected), counted: Number(data.counted), difference: Number(data.difference), tipsPaid: Number(data.tipsPaid), nextFloat: Number(data.nextFloat), toVault: Number(data.toVault) })
  notify('caja', () => cashCloseMessage({
    number: s.number, register: s.register?.name, site: s.site?.name, siteId: s.site_id, sales: before.sales, tips: before.tips, orders: before.orders,
    byMethod: Object.fromEntries(before.byMethod.map((x) => [x.label, x.amount])), expected: Number(data.expected), counted: Number(data.counted),
    difference: Number(data.difference), toVault: Number(data.toVault), nextFloat: Number(data.nextFloat), tipsPaid: summary.tipPayouts, couriersPaid: summary.courierPayouts, note: clean(b.note), user: req.user
  }))
  res.send({ ...sessionDTO(after), summary })
}))

// ---------------------------------------------------------------- Gastos del turno y solicitudes de recursos
// Gastos menores que salen del efectivo de la caja (hielo, limones, un domicilio). Quedan como gasto en
// Finanzas. Cada gasto tiene un tope; para compras mayores el cajero pide recursos al administrador.
const SHIFT_CATEGORIES = { insumos: 'Insumos (hielo, limones, desechables)', mantenimiento: 'Mantenimiento y reparaciones', transporte: 'Transporte y domicilios', servicios: 'Servicios', otros: 'Otros gastos' }
const REQUEST_STATUS = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada' }
const expenseLimit = async () => Number((await supabase.from('app_settings').select('cash_expense_limit').maybeSingle()).data?.cash_expense_limit ?? 100000)
const requestDTO = (r) => ({
  id: r.id, number: r.number, siteId: r.site_id, site: r.site?.name ?? null, sessionId: r.session_id, session: r.session?.number ?? null, register: r.session?.register?.name ?? null,
  sessionOpen: r.session?.status === 'abierta', amount: Number(r.amount), approvedAmount: r.approved_amount === null ? null : Number(r.approved_amount), reason: r.reason,
  status: r.status, statusLabel: REQUEST_STATUS[r.status], fromGeneral: r.from_general, resolution: r.resolution,
  requestedBy: fullName(r.requester), resolvedBy: fullName(r.resolver), resolvedAt: r.resolved_at, createdAt: r.created_at
})
const REQ_COLUMNS = '*, site:sites(name), session:cash_sessions(number, status, register:cash_registers(name)), requester:users!cash_requests_requested_by_fkey(name, last_name), resolver:users!cash_requests_resolved_by_fkey(name, last_name)'

router.get('/caja/turnos/:id/gastos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  const [limit, { data: exp }, { data: reqs }] = await Promise.all([
    expenseLimit(),
    supabase.from('expenses').select('id, number, category, description, supplier, amount, status, created_at').eq('session_id', s.id).order('id', { ascending: false }),
    supabase.from('cash_requests').select(REQ_COLUMNS).eq('session_id', s.id).order('id', { ascending: false })
  ])
  res.send({
    limit, categories: SHIFT_CATEGORIES,
    expenses: (exp || []).map((e) => ({ id: e.id, number: e.number, category: e.category, categoryLabel: SHIFT_CATEGORIES[e.category] || e.category, description: e.description, supplier: e.supplier, amount: Number(e.amount), status: e.status, createdAt: e.created_at })),
    requests: (reqs || []).map(requestDTO)
  })
}))
router.post('/caja/turnos/:id/gastos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  if (s.status !== 'abierta') return fail(res, 'El turno ya está cerrado', 409)
  const b = req.body || {}
  if (!SHIFT_CATEGORIES[b.category]) return fail(res, 'Elige el tipo de gasto', 400)
  const description = clean(b.description)
  if (!description || description.length < 3) return fail(res, 'Escribe qué se compró o pagó', 400)
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  const amount = money(b.amount)
  const limit = await expenseLimit()
  if (!ADMIN.includes(req.user.role) && limit > 0 && amount > limit) {
    return fail(res, `El gasto supera el tope de $${Math.round(limit).toLocaleString('es-CO')} por gasto. Pide los recursos al administrador.`, 403)
  }
  const sup = await resolveSupplier(b)
  if (sup.error) return fail(res, sup.error, 400)
  const { data: id, error } = await supabase.rpc('finance_expense', { p: {
    org_id: req.user.org_id, user_id: req.user.id, category: b.category, description: description.slice(0, 200), supplier: sup.name, invoice_ref: clean(b.invoiceRef),
    amount, source: 'caja', session_id: s.id
  } })
  if (error) return dbError(res, error)
  if (sup.id) await supabase.from('expenses').update({ supplier_id: sup.id }).eq('id', id)
  const { data: e } = await supabase.from('expenses').select('number').eq('id', id).single()
  await audit(req, 'gasto', 'turno_caja', s.id, { number: e.number, session: s.number, amount, description })
  res.status(201).send({ id, number: e.number })
}))
router.post('/caja/turnos/:id/solicitudes', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  if (s.status !== 'abierta') return fail(res, 'El turno ya está cerrado', 409)
  const b = req.body || {}
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe cuánto necesitas', 400)
  const reason = clean(b.reason)
  if (!reason || reason.length < 3) return fail(res, 'Explica para qué es el dinero', 400)
  const { count } = await supabase.from('cash_requests').select('id', { count: 'exact', head: true }).eq('session_id', s.id).eq('status', 'pendiente')
  if (count >= 3) return fail(res, 'Ya hay 3 solicitudes pendientes en este turno. Espera la respuesta del administrador.', 409)
  const { data: number, error: e1 } = await supabase.rpc('next_consecutive', { p_org: req.user.org_id, p_kind: 'solicitud_caja', p_site: 0, p_prefix: 'SR-' })
  if (e1) throw e1
  const { data, error } = await supabase.from('cash_requests').insert({ site_id: s.site_id, session_id: s.id, number, amount: money(b.amount), reason: reason.slice(0, 200), requested_by: req.user.id }).select(REQ_COLUMNS).single()
  if (error) throw error
  await audit(req, 'solicitar', 'recursos_caja', data.id, { number, session: s.number, amount: money(b.amount), reason })
  notify('caja', () => cashRequestMessage({ number, status: 'pendiente', amount: money(b.amount), reason, session: s.number, register: s.register?.name, site: s.site?.name, siteId: s.site_id, user: req.user }))
  res.status(201).send(requestDTO(data))
}))
router.get('/caja/solicitudes', auth(ADMIN), h(async (req, res) => {
  let q = supabase.from('cash_requests').select(REQ_COLUMNS).order('created_at', { ascending: false }).limit(100)
  if (req.siteId) q = q.eq('site_id', req.siteId)
  if (REQUEST_STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
  const [{ data, error }, { data: vaults }] = await Promise.all([q, supabase.from('vaults').select('site_id, balance').eq('kind', 'principal')])
  if (error) throw error
  const fund = (sid) => Number((vaults || []).find((v) => (v.site_id ?? null) === sid)?.balance || 0)
  res.send({ rows: data.map((r) => ({ ...requestDTO(r), siteFund: fund(r.site_id), generalFund: fund(null) })), pending: data.filter((r) => r.status === 'pendiente').length })
}))
router.post('/caja/solicitudes/:id/aprobar', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (b.amount !== undefined && b.amount !== '' && !(Number(b.amount) > 0)) return fail(res, 'El valor debe ser mayor que cero', 400)
  const { data, error } = await supabase.rpc('approve_cash_request', { p: { org_id: req.user.org_id, user_id: req.user.id, id: Number(req.params.id), amount: b.amount ? money(b.amount) : null, from_general: Boolean(b.fromGeneral), note: clean(b.note) } })
  if (error) return dbError(res, error)
  const { data: r } = await supabase.from('cash_requests').select(REQ_COLUMNS).eq('id', Number(req.params.id)).single()
  await audit(req, 'aprobar', 'recursos_caja', r.id, { number: r.number, amount: Number(data.amount), fromGeneral: Boolean(b.fromGeneral) })
  notify('caja', () => cashRequestMessage({ number: r.number, status: 'aprobada', amount: Number(data.amount), reason: r.reason, session: data.session, register: r.session?.register?.name, site: r.site?.name, siteId: r.site_id, user: req.user }))
  res.send(requestDTO(r))
}))
router.post('/caja/solicitudes/:id/rechazar', auth(ADMIN), h(async (req, res) => {
  const { data: r } = await supabase.from('cash_requests').select(REQ_COLUMNS).eq('id', Number(req.params.id)).maybeSingle()
  if (!r) return fail(res, 'Solicitud no encontrada', 404)
  if (r.status !== 'pendiente') return fail(res, `La solicitud ya fue ${r.status}`, 409)
  const note = clean(req.body?.note)
  if (!note) return fail(res, 'Escribe el motivo', 400)
  await supabase.from('cash_requests').update({ status: 'rechazada', resolution: note.slice(0, 200), resolved_by: req.user.id, resolved_at: new Date().toISOString() }).eq('id', r.id)
  await audit(req, 'rechazar', 'recursos_caja', r.id, { number: r.number, note })
  notify('caja', () => cashRequestMessage({ number: r.number, status: 'rechazada', amount: Number(r.amount), reason: `${r.reason} · ${note}`, session: r.session?.number, register: r.session?.register?.name, site: r.site?.name, siteId: r.site_id, user: req.user }))
  res.send({ ok: true })
}))

// ---------------------------------------------------------------- Reabrir un turno cerrado (TD-006)
// Si hubo un error en el cierre (o un cobro mal registrado), se pide reabrir el turno con el motivo.
// Solo el administrador lo aprueba, dentro de las horas configuradas y antes de abrir un turno nuevo en esa caja.
const REOPEN_COLUMNS = '*, session:cash_sessions(number, status, register:cash_registers(name)), site:sites(name), requester:users!cash_reopen_requests_requested_by_fkey(name, last_name), resolver:users!cash_reopen_requests_resolved_by_fkey(name, last_name)'
const reopenDTO = (r) => ({
  id: r.id, sessionId: r.session_id, session: r.session?.number ?? null, register: r.session?.register?.name ?? null, siteId: r.site_id, site: r.site?.name ?? null,
  reason: r.reason, status: r.status, statusLabel: REQUEST_STATUS[r.status], resolution: r.resolution, snapshot: r.snapshot || null,
  requestedBy: fullName(r.requester), resolvedBy: fullName(r.resolver), resolvedAt: r.resolved_at, createdAt: r.created_at
})
const reopenHours = async () => Number((await supabase.from('app_settings').select('cash_reopen_hours').maybeSingle()).data?.cash_reopen_hours ?? 12)
// ¿Se puede reabrir? Devuelve hasta cuándo y por qué no.
const reopenInfo = async (s) => {
  if (s.status !== 'cerrada') return { allowed: false }
  const hours = await reopenHours()
  const until = new Date(new Date(s.closed_at).getTime() + hours * 3600e3).toISOString()
  const [{ data: newer }, { data: pend }] = await Promise.all([
    supabase.from('cash_sessions').select('id, number').eq('register_id', s.register_id).neq('id', s.id).or(`status.eq.abierta,opened_at.gt."${s.closed_at}"`).limit(1),
    supabase.from('cash_reopen_requests').select(REOPEN_COLUMNS).eq('session_id', s.id).eq('status', 'pendiente').maybeSingle()
  ])
  const why = hours <= 0 ? 'La reapertura de turnos está desactivada en Configuración.'
    : (newer || []).length ? `Ya se abrió el turno ${newer[0].number} en esta caja.`
      : Date.now() > new Date(until).getTime() ? `Pasaron más de ${hours} horas desde el cierre.` : null
  return { allowed: !why, why, hours, until, pending: pend ? reopenDTO(pend) : null }
}
const approveReopen = async (req, id, note) => {
  const { data, error } = await supabase.rpc('reopen_cash_session', { p: { org_id: req.user.org_id, user_id: req.user.id, request_id: id, note: note || null } })
  if (error) return { error }
  const { data: r } = await supabase.from('cash_reopen_requests').select(REOPEN_COLUMNS).eq('id', id).single()
  await audit(req, 'reabrir', 'turno_caja', r.session_id, { number: r.session?.number, reason: r.reason, closed: data.snapshot })
  notify('caja', () => cashReopenMessage({ status: 'aprobada', session: r.session?.number, register: r.session?.register?.name, reason: r.reason, note, site: r.site?.name, siteId: r.site_id, user: req.user }))
  return { row: r }
}
// El cajero (o el administrador) pide reabrir con el motivo. Si lo pide el administrador, se reabre de una vez.
router.post('/caja/turnos/:id/reabrir', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const s = await loadSession(req.params.id)
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  const reason = clean(req.body?.reason)
  if (!reason || reason.length < 5) return fail(res, 'Explica el motivo para reabrir el turno', 400)
  const info = await reopenInfo(s)
  if (!info.allowed) return fail(res, info.why || 'El turno no está cerrado', 409)
  if (info.pending) return fail(res, 'Ya hay una solicitud pendiente para reabrir este turno', 409)
  const { data: r, error } = await supabase.from('cash_reopen_requests').insert({ site_id: s.site_id, session_id: s.id, reason: reason.slice(0, 300), requested_by: req.user.id }).select('id').single()
  if (error) return dbError(res, error)
  if (ADMIN.includes(req.user.role)) {
    const done = await approveReopen(req, r.id, null)
    if (done.error) { await supabase.from('cash_reopen_requests').delete().eq('id', r.id); return dbError(res, done.error) }
    const after = await loadSession(s.id)
    return res.status(201).send({ reopened: true, request: reopenDTO(done.row), session: sessionDTO(after) })
  }
  await audit(req, 'solicitar', 'reabrir_turno', r.id, { session: s.number, reason })
  notify('caja', () => cashReopenMessage({ status: 'pendiente', session: s.number, register: s.register?.name, reason, site: s.site?.name, siteId: s.site_id, user: req.user }))
  const { data: row } = await supabase.from('cash_reopen_requests').select(REOPEN_COLUMNS).eq('id', r.id).single()
  res.status(201).send({ reopened: false, request: reopenDTO(row) })
}))
router.get('/caja/reaperturas', auth(ADMIN), h(async (req, res) => {
  let q = supabase.from('cash_reopen_requests').select(REOPEN_COLUMNS).order('created_at', { ascending: false }).limit(100)
  if (req.siteId) q = q.eq('site_id', req.siteId)
  if (REQUEST_STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
  const [{ data, error }, hours] = await Promise.all([q, reopenHours()])
  if (error) throw error
  res.send({ hours, rows: data.map(reopenDTO), pending: data.filter((r) => r.status === 'pendiente').length })
}))
router.post('/caja/reaperturas/:id(\\d+)/aprobar', auth(ADMIN), h(async (req, res) => {
  const done = await approveReopen(req, Number(req.params.id), clean(req.body?.note))
  if (done.error) return dbError(res, done.error)
  res.send(reopenDTO(done.row))
}))
router.post('/caja/reaperturas/:id(\\d+)/rechazar', auth(ADMIN), h(async (req, res) => {
  const { data: r } = await supabase.from('cash_reopen_requests').select(REOPEN_COLUMNS).eq('id', Number(req.params.id)).maybeSingle()
  if (!r) return fail(res, 'Solicitud no encontrada', 404)
  if (r.status !== 'pendiente') return fail(res, `La solicitud ya fue ${r.status}`, 409)
  const note = clean(req.body?.note)
  if (!note) return fail(res, 'Escribe el motivo', 400)
  await supabase.from('cash_reopen_requests').update({ status: 'rechazada', resolution: note.slice(0, 200), resolved_by: req.user.id, resolved_at: new Date().toISOString() }).eq('id', r.id)
  await audit(req, 'rechazar', 'reabrir_turno', r.id, { session: r.session?.number, note })
  notify('caja', () => cashReopenMessage({ status: 'rechazada', session: r.session?.number, register: r.session?.register?.name, reason: r.reason, note, site: r.site?.name, siteId: r.site_id, user: req.user }))
  res.send({ ok: true })
}))

// ---------------------------------------------------------------- Bóveda
router.get('/caja/boveda', auth(ADMIN), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const { data: vid, error } = await supabase.rpc('vault_of', { p_org: req.user.org_id, p_site: site })
  if (error) throw error
  const [{ data: v }, { data: moves }, { data: all }] = await Promise.all([
    supabase.from('vaults').select('*, site:sites(name)').eq('id', vid).maybeSingle(),
    supabase.from('vault_movements').select('*, user:users(name, last_name)').eq('vault_id', vid).order('created_at', { ascending: false }).limit(80),
    supabase.from('vaults').select('balance, kind, name, site:sites(name)')
  ])
  res.send({
    id: v.id, siteId: v.site_id, site: v.site?.name, balance: Number(v.balance),
    total: (all || []).reduce((a, x) => a + Number(x.balance), 0),
    bySite: (all || []).map((x) => ({ site: x.kind === 'subcuenta' ? `${x.site?.name || 'General'} · ${x.name}` : x.site?.name, balance: Number(x.balance) })),
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
