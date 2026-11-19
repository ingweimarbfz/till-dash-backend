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
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { guard, workSite, dbError, fullName } = require('../ops')
const { tipBalance, cleanPayments, payoutDTO, TIP_SOURCES } = require('../tips')

const router = express.Router()

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
  const [orders, payouts, courierTips, { data: staff }, { data: sessions }, fund] = await Promise.all([
    all(() => supabase.from('orders').select('id, waiter_id, tip, type, courier_id, waiter:users!orders_waiter_id_fkey(name, last_name), courier:users!orders_courier_id_fkey(name, last_name)').eq('site_id', site).eq('status', 'cobrado').gt('tip', 0).order('id')),
    all(() => supabase.from('tip_payouts').select(PAYOUT_COLUMNS).eq('site_id', site).order('created_at', { ascending: false })),
    // Propinas que se pagaron a los domiciliarios en cierres anteriores (junto con su parte del domicilio).
    all(() => supabase.from('courier_payouts').select('id, user_id, tips, created_at, user:users!courier_payouts_user_id_fkey(name, last_name), session:cash_sessions!inner(site_id)').eq('session.site_id', site).gt('tips', 0).order('id')).catch(() => []),
    supabase.from('users').select('id, name, last_name, role, positions, site_id').eq('active', true).in('role', ['empleado', 'admin']).order('name'),
    supabase.from('cash_sessions').select('id, number, register:cash_registers(name)').eq('site_id', site).eq('status', 'abierta').order('opened_at'),
    admin ? supabase.rpc('vault_of', { p_org: req.user.org_id, p_site: site }).then(async ({ data: vid }) => (vid ? (await supabase.from('vaults').select('balance').eq('id', vid).maybeSingle()).data : null)) : null
  ])
  const team = (staff || []).filter((u) => !u.site_id || u.site_id === site)
  const balance = tipBalance(orders, [...payouts, ...courierTips.map((c) => ({ user_id: c.user_id, user: c.user, amount: c.tips, created_at: c.created_at }))], team)
  const open = await Promise.all((sessions || []).map(async (s) => {
    const { data: cash } = await supabase.rpc('session_cash', { p_session: s.id })
    return { id: s.id, number: s.number, register: s.register?.name ?? null, cash: Math.round(Number(cash) || 0) }
  }))
  res.send({
    siteId: site, ...balance,
    sessions: open, fund: fund ? Math.round(Number(fund.balance) || 0) : null, canUseFund: admin,
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

module.exports = router
