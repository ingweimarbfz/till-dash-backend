// =====================================================================
// Propinas (TD-020): saldo por pagar y pago cuando se requiera
// · Las propinas ya no se reparten en el cierre del turno: se acumulan y se pagan aquí.
// · GET  /propinas        → por pagar en la sucursal, por empleado (generó, recibió, le falta), historial,
//                           turnos abiertos (para pagar desde la caja) y saldo del fondo.
// · POST /propinas/pagos  → paga a uno o varios empleados desde la caja abierta, el fondo de la sucursal
//                           (solo administrador) o por transferencia/Nequi/Daviplata.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, todayBogota } = require('../http')
const { auth, ADMIN, STAFF, canManagePay } = require('../auth')
const { audit } = require('../audit')
const { guard, workSite, dbError, fullName } = require('../ops')
const { tipBalance, cleanPayments, payoutDTO, TIP_SOURCES, payrollDue, cleanEarnings, cleanPayroll, earningDTO, cleanShift } = require('../tips')

const router = express.Router()

// Pagos asignados (turnos, domicilios pendientes y nómina): superadmin o admin con el permiso (TD-021).
const payGuard = (req, res, next) => (canManagePay(req.user) ? next() : fail(res, 'Solo el super administrador o un administrador con el permiso de pagos puede ver los pagos al personal', 403))

// Cajas abiertas de la sucursal con su efectivo (para pagar desde la caja).
const withCash = (sessions) => Promise.all((sessions || []).map(async (s) => {
  const { data: cash } = await supabase.rpc('session_cash', { p_session: s.id })
  return { id: s.id, number: s.number, register: s.register?.name ?? null, cash: Math.round(Number(cash) || 0) }
}))
const fundOf = async (req, site) => {
  if (!ADMIN.includes(req.user.role)) return null
  const { data: vid } = await supabase.rpc('vault_of', { p_org: req.user.org_id, p_site: site })
  if (!vid) return null
  const { data } = await supabase.from('vaults').select('balance').eq('id', vid).maybeSingle()
  return data ? Math.round(Number(data.balance) || 0) : null
}

const all = async (build) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}
const PAYOUT_COLUMNS = 'id, number, user_id, amount, source, method, note, created_at, user:users!tip_payouts_user_id_fkey(name, last_name), payer:users!tip_payouts_paid_by_fkey(name, last_name), session:cash_sessions!tip_payouts_session_id_fkey(number)'
const TRANSFER_METHODS = { transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata' }

router.get('/propinas', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const admin = ADMIN.includes(req.user.role)
  const month = new Date(Date.now() - 30 * 864e5).toISOString()
  const [orders, payouts, courierTips, { data: staff }, { data: sessions }, fund, { data: ratings }] = await Promise.all([
    all(() => supabase.from('orders').select('id, waiter_id, tip, type, courier_id, waiter:users!orders_waiter_id_fkey(name, last_name), courier:users!orders_courier_id_fkey(name, last_name)').eq('site_id', site).eq('status', 'cobrado').gt('tip', 0).order('id')),
    all(() => supabase.from('tip_payouts').select(PAYOUT_COLUMNS).eq('site_id', site).order('created_at', { ascending: false })),
    // Propinas que se pagaron a los domiciliarios en cierres anteriores (junto con su parte del domicilio).
    all(() => supabase.from('courier_payouts').select('id, user_id, tips, created_at, user:users!courier_payouts_user_id_fkey(name, last_name), session:cash_sessions!inner(site_id)').eq('session.site_id', site).gt('tips', 0).order('id')).catch(() => []),
    supabase.from('users').select('id, name, last_name, role, positions, site_id').eq('active', true).in('role', ['empleado', 'admin']).order('name'),
    supabase.from('cash_sessions').select('id, number, register:cash_registers(name)').eq('site_id', site).eq('status', 'abierta').order('opened_at'),
    fundOf(req, site),
    // Calificaciones de los últimos 30 días: para dar más al mejor calificado al repartir en partes iguales.
    supabase.from('service_ratings').select('waiter_id, stars').gte('created_at', month).then((r) => (r.error ? { data: [] } : r))
  ])
  const team = (staff || []).filter((u) => !u.site_id || u.site_id === site)
  const stars = {}
  for (const r of ratings || []) if (r.waiter_id) { stars[r.waiter_id] = stars[r.waiter_id] || { sum: 0, n: 0 }; stars[r.waiter_id].sum += r.stars; stars[r.waiter_id].n++ }
  const balance = tipBalance(orders, [...payouts, ...courierTips.map((c) => ({ user_id: c.user_id, user: c.user, amount: c.tips, created_at: c.created_at }))], team)
  const open = await withCash(sessions)
  res.send({
    siteId: site, ...balance,
    people: balance.people.map((x) => ({ ...x, rating: stars[x.userId] ? { avg: Math.round((stars[x.userId].sum / stars[x.userId].n) * 10) / 10, count: stars[x.userId].n } : null })),
    sessions: open, fund, canUseFund: admin,
    sources: TIP_SOURCES, transferMethods: TRANSFER_METHODS,
    payouts: payouts.slice(0, 200).map(payoutDTO)
  })
}))

router.post('/propinas/pagos', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const b = req.body || {}
  const site = await workSite(req, b.siteId)
  const source = ['caja', 'fondo', 'transferencia'].includes(b.source) ? b.source : null
  if (!source) return fail(res, 'Elige de dónde sale el dinero', 400)
  if (source === 'fondo' && !ADMIN.includes(req.user.role)) return fail(res, 'Solo el administrador puede pagar propinas desde el fondo', 403)
  if (source === 'caja' && !Number(b.sessionId)) return fail(res, 'Elige la caja abierta de donde sale el efectivo', 400)
  if (source === 'transferencia' && !TRANSFER_METHODS[b.method]) return fail(res, 'Elige el medio de la transferencia', 400)
  const r = cleanPayments(b.payments)
  if (r.error) return fail(res, r.error, 400)
  const { data, error } = await supabase.rpc('pay_tips', { p: {
    org_id: req.user.org_id, user_id: req.user.id, site_id: site, source, session_id: Number(b.sessionId) || null,
    method: source === 'transferencia' ? b.method : 'efectivo', note: clean(b.note), payments: r.payments
  } })
  if (error) return dbError(res, error)
  await audit(req, 'pagar', 'propinas', null, { number: data.number, total: Number(data.total), source, people: r.payments.length, note: clean(b.note) })
  const { data: rows } = await supabase.from('tip_payouts').select(PAYOUT_COLUMNS).eq('number', data.number).eq('site_id', site).order('id')
  res.status(201).send({ number: data.number, total: Number(data.total), source, payouts: (rows || []).map(payoutDTO), paidBy: fullName(req.user) })
}))

// ---------------------------------------------------------------- Pagos al personal (turnos, domicilios y nómina)
// · Pendientes: turnos y domicilios que en el cierre no se pagaron (staff_earnings pendiente).
// · Nómina: empleados con pago por nómina, con el periodo sugerido (quincena o mes) y lo ya pagado.
const EARNING_COLUMNS = '*, user:users!staff_earnings_user_id_fkey(name, last_name), payer:users!staff_earnings_paid_by_fkey(name, last_name), session:cash_sessions!staff_earnings_session_id_fkey(number)'

router.get('/personal/pagos', auth(ADMIN), payGuard, h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const admin = ADMIN.includes(req.user.role)
  const [{ data: pending, error }, { data: paid }, { data: payrollUsers }, { data: sessions }, fund, { data: crew }] = await Promise.all([
    supabase.from('staff_earnings').select(EARNING_COLUMNS).eq('site_id', site).eq('status', 'pendiente').order('created_at'),
    supabase.from('staff_earnings').select(EARNING_COLUMNS).eq('site_id', site).eq('status', 'pagado').order('paid_at', { ascending: false }).limit(200),
    admin ? supabase.from('users').select('id, name, last_name, positions, site_id, salary, pay_period').eq('active', true).eq('pay_mode', 'nomina').order('name') : { data: [] },
    supabase.from('cash_sessions').select('id, number, register:cash_registers(name)').eq('site_id', site).eq('status', 'abierta').order('opened_at'),
    fundOf(req, site),
    // Para registrar a mano un turno que no se pagó en el cierre.
    supabase.from('users').select('id, name, last_name, site_id, pay_mode, hour_rate, overtime_rate').eq('active', true).in('role', ['empleado', 'admin']).order('name')
  ])
  if (error) throw error
  const team = (payrollUsers || []).filter((u) => !u.site_id || u.site_id === site)
  const { data: periods } = team.length
    ? await supabase.from('staff_earnings').select('user_id, period_from, period_to, amount, paid_at').eq('kind', 'nomina').in('user_id', team.map((u) => u.id)).order('period_from', { ascending: false })
    : { data: [] }
  const today = todayBogota()
  res.send({
    siteId: site, canUseFund: admin, fund, sessions: await withCash(sessions),
    transferMethods: TRANSFER_METHODS, sources: TIP_SOURCES,
    pending: (pending || []).map(earningDTO),
    pendingTotal: (pending || []).reduce((a, e) => a + Number(e.amount), 0),
    payroll: team.map((u) => {
      const mine = (periods || []).filter((x) => x.user_id === u.id)
      const due = payrollDue(today, u.pay_period, mine.map((x) => x.period_from))
      return {
        userId: u.id, name: fullName(u), positions: u.positions || [], salary: Number(u.salary), period: u.pay_period,
        due, last: mine[0] ? { from: mine[0].period_from, to: mine[0].period_to, amount: Number(mine[0].amount), paidAt: mine[0].paid_at } : null
      }
    }),
    history: (paid || []).map(earningDTO),
    crew: (crew || []).filter((u) => !u.site_id || u.site_id === site).map((u) => ({ id: u.id, name: fullName(u), payMode: u.pay_mode || 'ninguno', hourRate: Number(u.hour_rate || 0), overtimeRate: Number(u.overtime_rate || 0) }))
  })
}))

router.post('/personal/pagos', auth(ADMIN), payGuard, h(async (req, res) => {
  const b = req.body || {}
  const site = await workSite(req, b.siteId)
  const source = ['caja', 'fondo', 'transferencia'].includes(b.source) ? b.source : null
  if (!source) return fail(res, 'Elige de dónde sale el dinero', 400)
  if (source === 'fondo' && !ADMIN.includes(req.user.role)) return fail(res, 'Solo el administrador puede pagar desde el fondo', 403)
  if (source === 'caja' && !Number(b.sessionId)) return fail(res, 'Elige la caja abierta de donde sale el efectivo', 400)
  if (source === 'transferencia' && !TRANSFER_METHODS[b.method]) return fail(res, 'Elige el medio de la transferencia', 400)
  const earnings = cleanEarnings(b.earnings)
  const pr = cleanPayroll(b.payroll)
  if (pr.error) return fail(res, pr.error, 400)
  if (pr.payroll.length && !ADMIN.includes(req.user.role)) return fail(res, 'Solo el administrador paga la nómina', 403)
  if (!earnings.length && !pr.payroll.length) return fail(res, 'Elige qué se va a pagar', 400)
  const { data, error } = await supabase.rpc('pay_staff', { p: {
    org_id: req.user.org_id, user_id: req.user.id, site_id: site, source, session_id: Number(b.sessionId) || null,
    method: source === 'transferencia' ? b.method : 'efectivo', note: clean(b.note), earnings, payroll: pr.payroll
  } })
  if (error) return dbError(res, error)
  await audit(req, 'pagar', 'personal', null, { number: data.number, total: Number(data.total), source, earnings: earnings.length, payroll: pr.payroll.length })
  res.status(201).send({ number: data.number, total: Number(data.total), source })
}))

// Registrar un turno que no se pagó en el cierre (por ejemplo, porque cerró la caja alguien sin el permiso).
// Queda pendiente y se paga desde la lista de pendientes. b: {siteId, userId, date, hours, extraHours, fixed, amount, note}
router.post('/personal/turnos', auth(ADMIN), payGuard, h(async (req, res) => {
  const b = req.body || {}
  const site = await workSite(req, b.siteId)
  const t = cleanShift(b)
  if (t.error) return fail(res, t.error, 400)
  const { data: emp } = await supabase.from('users').select('id, name, last_name, site_id, active, role, extra_roles, hour_rate, overtime_rate').eq('id', t.userId).eq('org_id', req.user.org_id).maybeSingle()
  if (!emp || !emp.active) return fail(res, 'Empleado no encontrado', 404)
  if (emp.site_id && emp.site_id !== site) return fail(res, 'El empleado es de otra sucursal', 400)
  const rate = t.fixed ? null : Number(emp.hour_rate) || null
  const extraRate = t.fixed || !t.extraHours ? null : Number(emp.overtime_rate) || rate
  const amount = t.fixed ? t.amount : Math.round((t.hours || 0) * (rate || 0) + (t.extraHours || 0) * (extraRate || 0))
  if (!(amount > 0)) return fail(res, t.fixed ? 'Escribe el valor del turno' : 'El empleado no tiene valor de la hora: usa valor fijo o configúralo en Usuarios', 400)
  const { data, error } = await supabase.from('staff_earnings').insert({
    org_id: req.user.org_id, site_id: site, user_id: emp.id, kind: 'turno', hours: t.hours, rate, extra_hours: t.fixed ? null : t.extraHours, extra_rate: extraRate,
    fixed: t.fixed, amount, note: `Turno del ${t.date}${t.note ? ` · ${t.note}` : ''}`, created_by: req.user.id
  }).select(EARNING_COLUMNS).single()
  if (error) return dbError(res, error)
  await audit(req, 'crear', 'pago_personal', data.id, { userId: emp.id, amount, hours: t.hours, extraHours: t.extraHours, fixed: t.fixed })
  res.status(201).send(earningDTO(data))
}))

module.exports = router
