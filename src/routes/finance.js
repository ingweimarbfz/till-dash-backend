// =====================================================================
// Finanzas (TD-004). Solo administradores.
// · Fondos: el general del negocio y el de cada sucursal. Ingresar dinero, trasladar entre fondos.
//   La caja de una sucursal abre con la base que dejó el turno anterior más su fondo.
// · Gastos por categoría, pagados desde un fondo, la caja abierta, un socio o el banco.
// · Socios: participación, aportes, retiros y pago de utilidades.
// · Resumen: estado de resultados del rango (ventas, costo, gastos, pérdidas, otros ingresos, utilidad)
//   y lo que le corresponde a cada socio.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, EMAIL_RE } = require('../http')
const { auth, ADMIN } = require('../auth')
const { audit } = require('../audit')
const { dbError, money, isMoney, fullName } = require('../ops')
const { buildReport, rangeOf } = require('./reports')

const router = express.Router()

const ENTRY_KINDS = { aporte_socio: 'Aporte de socio', capital: 'Capital del negocio', prestamo: 'Préstamo', otro_ingreso: 'Otro ingreso' }
const EXPENSE_CATEGORIES = {
  nomina: 'Nómina y prestaciones', arriendo: 'Arriendo', servicios: 'Servicios públicos e internet', compras: 'Compras de inventario',
  mantenimiento: 'Mantenimiento y reparaciones', impuestos: 'Impuestos y licencias', marketing: 'Publicidad y marketing',
  transporte: 'Transporte y domicilios', bancarios: 'Gastos bancarios y comisiones', otros: 'Otros gastos'
}
const SOURCES = { fondo: 'Fondo', caja: 'Caja abierta', socio: 'Lo pagó un socio', banco: 'Banco / transferencia' }
const METHODS = { efectivo: 'Efectivo', transferencia: 'Transferencia', tarjeta: 'Tarjeta', nequi: 'Nequi', daviplata: 'Daviplata', otro: 'Otro' }
const WITHDRAWAL_KINDS = { utilidad: 'Pago de utilidades', retiro: 'Retiro de capital' }
const VAULT_LABELS = {
  deposito: 'Depósito', retiro: 'Retiro', cierre_caja: 'Cierre de caja', base_caja: 'Base de caja', consignacion: 'Consignación al banco', ajuste: 'Ajuste',
  ingreso: 'Ingreso de dinero', gasto: 'Gasto', traslado: 'Traslado', retiro_socio: 'Retiro de socio', anulacion: 'Anulación'
}
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
const round = (v) => Math.round(Number(v) || 0)
// '' o 'general' → fondo general (null). Otro valor: id de la sucursal.
const fundSite = (v) => (v === undefined || v === null || v === '' || v === 'general' ? null : Number(v) || null)
const siteName = (sites, id) => (id ? sites.find((s) => s.id === id)?.name || 'Sucursal' : 'Fondo general')
const getSites = async () => (await supabase.from('sites').select('id, name, is_main').order('is_main', { ascending: false }).order('name')).data || []
const run = async (res, fn, p) => {
  const { data, error } = await supabase.rpc(fn, { p })
  if (error) { dbError(res, error); return { failed: true } }
  return { data }
}
const inRange = (q, col, r) => q.gte(col, r.from).lte(col, r.to)

// ---------------------------------------------------------------- Fondos
router.get('/finanzas/fondos', auth(ADMIN), h(async (req, res) => {
  const sites = await getSites()
  // Crea los fondos que falten (general y uno por sucursal).
  await Promise.all([null, ...sites.map((s) => s.id)].map((id) => supabase.rpc('vault_of', { p_org: req.user.org_id, p_site: id })))
  const [{ data: vaults }, { data: regs }] = await Promise.all([
    supabase.from('vaults').select('id, site_id, balance'),
    supabase.from('cash_registers').select('site_id, float_amount, active')
  ])
  const funds = [null, ...sites.map((s) => s.id)].map((sid) => {
    const v = (vaults || []).find((x) => (x.site_id ?? null) === sid)
    const inRegisters = sid ? (regs || []).filter((r) => r.site_id === sid && r.active).reduce((a, r) => a + Number(r.float_amount || 0), 0) : 0
    return { key: sid ? String(sid) : 'general', siteId: sid, name: siteName(sites, sid), vaultId: v?.id, balance: Number(v?.balance || 0), inRegisters }
  })
  const key = req.query.fondo || 'general'
  const fund = funds.find((f) => f.key === key) || funds[0]
  const { data: moves, error } = await supabase.from('vault_movements').select('*, user:users(name, last_name)').eq('vault_id', fund.vaultId).order('created_at', { ascending: false }).limit(100)
  if (error) throw error
  res.send({
    funds, fund, total: funds.reduce((a, f) => a + f.balance, 0),
    movements: (moves || []).map((m) => ({ id: m.id, type: m.type, typeLabel: VAULT_LABELS[m.type] || m.type, amount: Number(m.amount), balanceAfter: Number(m.balance_after), ref: m.ref, note: m.note, user: fullName(m.user), createdAt: m.created_at })),
    entryKinds: ENTRY_KINDS, methods: METHODS
  })
}))

// ---------------------------------------------------------------- Ingresos de dinero
const entryDTO = (sites) => (e) => ({
  id: e.id, number: e.number, siteId: e.site_id, fund: siteName(sites, e.site_id), kind: e.kind, kindLabel: ENTRY_KINDS[e.kind], partnerId: e.partner_id, partner: e.partner?.name ?? null,
  amount: Number(e.amount), method: e.method, methodLabel: METHODS[e.method], receivedOn: e.received_on, description: e.description, status: e.status, voidReason: e.void_reason,
  createdBy: fullName(e.creator), createdAt: e.created_at
})
router.get('/finanzas/ingresos', auth(ADMIN), h(async (req, res) => {
  const r = rangeOf(req.query)
  let q = inRange(supabase.from('money_entries').select('*, partner:partners(name), creator:users!money_entries_created_by_fkey(name, last_name)'), 'received_on', r).order('received_on', { ascending: false }).order('id', { ascending: false })
  if (req.query.fondo) q = fundSite(req.query.fondo) ? q.eq('site_id', fundSite(req.query.fondo)) : q.is('site_id', null)
  const [{ data, error }, sites] = await Promise.all([q, getSites()])
  if (error) throw error
  res.send({ range: r, rows: data.map(entryDTO(sites)), kinds: ENTRY_KINDS })
}))
router.post('/finanzas/ingresos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!ENTRY_KINDS[b.kind]) return fail(res, 'Elige de dónde viene el dinero', 400)
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  if (b.kind === 'aporte_socio' && !Number(b.partnerId)) return fail(res, 'Elige el socio que hace el aporte', 400)
  if (b.method && !METHODS[b.method]) return fail(res, 'Forma de pago no válida', 400)
  if (b.receivedOn && !isDay(b.receivedOn)) return fail(res, 'Fecha no válida', 400)
  const site = fundSite(b.siteId)
  const { failed, data: id } = await run(res, 'finance_entry', { org_id: req.user.org_id, user_id: req.user.id, site_id: site, kind: b.kind, partner_id: b.kind === 'aporte_socio' ? Number(b.partnerId) : null, amount: money(b.amount), method: b.method || 'efectivo', received_on: b.receivedOn || null, description: clean(b.description) })
  if (failed) return
  const { data } = await supabase.from('money_entries').select('number, amount').eq('id', id).single()
  await audit(req, 'crear', 'ingreso_dinero', id, { number: data.number, amount: Number(data.amount), fund: site || 'general', kind: b.kind })
  res.status(201).send({ id, number: data.number })
}))

// ---------------------------------------------------------------- Traslados
router.post('/finanzas/traslados', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  const from = fundSite(b.fromSiteId); const to = fundSite(b.toSiteId)
  if (from === to) return fail(res, 'Elige un fondo de origen y uno de destino distintos', 400)
  const { failed, data: id } = await run(res, 'fund_transfer', { org_id: req.user.org_id, user_id: req.user.id, from_site_id: from, to_site_id: to, amount: money(b.amount), note: clean(b.note) })
  if (failed) return
  await audit(req, 'trasladar', 'fondo', id, { from: from || 'general', to: to || 'general', amount: money(b.amount) })
  res.status(201).send({ id })
}))

// ---------------------------------------------------------------- Gastos
const expenseDTO = (sites) => (e) => ({
  id: e.id, number: e.number, siteId: e.site_id, site: siteName(sites, e.site_id), category: e.category, categoryLabel: EXPENSE_CATEGORIES[e.category],
  description: e.description, supplier: e.supplier, invoiceRef: e.invoice_ref, amount: Number(e.amount), paidOn: e.paid_on,
  source: e.source, sourceLabel: SOURCES[e.source], session: e.session?.number ?? null, partnerId: e.partner_id, partner: e.partner?.name ?? null,
  status: e.status, voidReason: e.void_reason, createdBy: fullName(e.creator), createdAt: e.created_at
})
router.get('/finanzas/gastos', auth(ADMIN), h(async (req, res) => {
  const r = rangeOf(req.query)
  let q = inRange(supabase.from('expenses').select('*, partner:partners(name), session:cash_sessions(number), creator:users!expenses_created_by_fkey(name, last_name)'), 'paid_on', r).order('paid_on', { ascending: false }).order('id', { ascending: false })
  if (req.siteId) q = q.eq('site_id', req.siteId)
  if (EXPENSE_CATEGORIES[req.query.categoria]) q = q.eq('category', req.query.categoria)
  const f = clean(req.query.q)
  if (f) { const v = f.replace(/[%,()]/g, ''); q = q.or(`number.ilike.%${v}%,description.ilike.%${v}%,supplier.ilike.%${v}%`) }
  const [{ data, error }, sites] = await Promise.all([q, getSites()])
  if (error) throw error
  const rows = data.map(expenseDTO(sites))
  const active = rows.filter((x) => x.status === 'activo')
  const byCategory = Object.entries(EXPENSE_CATEGORIES).map(([key, label]) => ({ key, label, total: active.filter((x) => x.category === key).reduce((a, x) => a + x.amount, 0) })).filter((c) => c.total > 0).sort((a, b) => b.total - a.total)
  res.send({ range: r, rows, total: active.reduce((a, x) => a + x.amount, 0), byCategory, categories: EXPENSE_CATEGORIES, sources: SOURCES })
}))
router.post('/finanzas/gastos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!EXPENSE_CATEGORIES[b.category]) return fail(res, 'Elige la categoría del gasto', 400)
  const description = clean(b.description)
  if (!description || description.length < 3) return fail(res, 'Describe el gasto', 400)
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  if (!SOURCES[b.source]) return fail(res, 'Elige con qué se pagó', 400)
  if (b.source === 'caja' && !Number(b.sessionId)) return fail(res, 'Elige el turno de caja del que sale el dinero', 400)
  if (b.source === 'socio' && !Number(b.partnerId)) return fail(res, 'Elige el socio que lo pagó', 400)
  if (b.paidOn && !isDay(b.paidOn)) return fail(res, 'Fecha no válida', 400)
  const { failed, data: id } = await run(res, 'finance_expense', {
    org_id: req.user.org_id, user_id: req.user.id, site_id: fundSite(b.siteId), category: b.category, description: description.slice(0, 200),
    supplier: clean(b.supplier), invoice_ref: clean(b.invoiceRef), amount: money(b.amount), paid_on: b.paidOn || null, source: b.source,
    session_id: b.source === 'caja' ? Number(b.sessionId) : null, partner_id: b.source === 'socio' ? Number(b.partnerId) : null
  })
  if (failed) return
  const { data } = await supabase.from('expenses').select('number, amount').eq('id', id).single()
  await audit(req, 'crear', 'gasto', id, { number: data.number, amount: Number(data.amount), category: b.category, source: b.source })
  res.status(201).send({ id, number: data.number })
}))

// ---------------------------------------------------------------- Socios
const partnerDTO = (p) => ({ id: p.id, name: p.name, document: p.document, phone: p.phone, email: p.email, sharePct: Number(p.share_pct), active: p.active, note: p.note })
const partnerFields = (b) => {
  const name = clean(b.name)
  if (!name || name.length < 2) return { error: 'Escribe el nombre del socio' }
  const pct = Number(b.sharePct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: 'La participación va de 0 a 100 %' }
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) return { error: 'El correo no es válido' }
  return { row: { name: name.slice(0, 120), document: clean(b.document), phone: clean(b.phone), email: clean(b.email), share_pct: Math.round(pct * 100) / 100, note: clean(b.note), active: b.active === undefined ? true : Boolean(b.active) } }
}
const shareCheck = async (pct, active, exceptId) => {
  if (!active) return null
  let q = supabase.from('partners').select('id, share_pct').eq('active', true)
  if (exceptId) q = q.neq('id', exceptId)
  const { data } = await q
  const sum = (data || []).reduce((a, p) => a + Number(p.share_pct), 0) + pct
  return sum > 100.001 ? `Las participaciones sumarían ${Math.round(sum * 100) / 100} %. No pueden pasar de 100 %.` : null
}
const partnerTotals = async () => {
  const [{ data: ent }, { data: exp }, { data: wd }] = await Promise.all([
    supabase.from('money_entries').select('partner_id, amount').eq('kind', 'aporte_socio').eq('status', 'activo'),
    supabase.from('expenses').select('partner_id, amount').eq('source', 'socio').eq('status', 'activo'),
    supabase.from('partner_withdrawals').select('partner_id, kind, amount').eq('status', 'activo')
  ])
  const t = {}
  const g = (id) => (t[id] = t[id] || { contributed: 0, withdrawn: 0, profitsPaid: 0 })
  for (const e of [...(ent || []), ...(exp || [])]) if (e.partner_id) g(e.partner_id).contributed += Number(e.amount)
  for (const w of wd || []) g(w.partner_id)[w.kind === 'utilidad' ? 'profitsPaid' : 'withdrawn'] += Number(w.amount)
  return t
}
router.get('/finanzas/socios', auth(ADMIN), h(async (req, res) => {
  const [{ data, error }, totals, { data: wd }, sites] = await Promise.all([
    supabase.from('partners').select('*').order('active', { ascending: false }).order('share_pct', { ascending: false }),
    partnerTotals(),
    supabase.from('partner_withdrawals').select('*, partner:partners(name), creator:users!partner_withdrawals_created_by_fkey(name, last_name)').order('paid_on', { ascending: false }).order('id', { ascending: false }).limit(100),
    getSites()
  ])
  if (error) throw error
  const rows = data.map((p) => { const t = totals[p.id] || { contributed: 0, withdrawn: 0, profitsPaid: 0 }; return { ...partnerDTO(p), ...t, capital: t.contributed - t.withdrawn } })
  res.send({
    rows, shareTotal: rows.filter((p) => p.active).reduce((a, p) => a + p.sharePct, 0),
    withdrawals: (wd || []).map((w) => ({ id: w.id, number: w.number, partnerId: w.partner_id, partner: w.partner?.name, kind: w.kind, kindLabel: WITHDRAWAL_KINDS[w.kind], amount: Number(w.amount), method: w.method, methodLabel: METHODS[w.method], fund: siteName(sites, w.site_id), paidOn: w.paid_on, note: w.note, status: w.status, voidReason: w.void_reason, createdBy: fullName(w.creator) })),
    withdrawalKinds: WITHDRAWAL_KINDS
  })
}))
router.post('/finanzas/socios', auth(ADMIN), h(async (req, res) => {
  const { row, error } = partnerFields(req.body || {})
  if (error) return fail(res, error, 400)
  const over = await shareCheck(row.share_pct, row.active)
  if (over) return fail(res, over, 400)
  const { data, error: e } = await supabase.from('partners').insert(row).select('*').single()
  if (e) throw e
  await audit(req, 'crear', 'socio', data.id, { name: data.name, sharePct: Number(data.share_pct) })
  res.status(201).send(partnerDTO(data))
}))
router.put('/finanzas/socios/:id', auth(ADMIN), h(async (req, res) => {
  const { data: cur } = await supabase.from('partners').select('id').eq('id', Number(req.params.id)).maybeSingle()
  if (!cur) return fail(res, 'Socio no encontrado', 404)
  const { row, error } = partnerFields(req.body || {})
  if (error) return fail(res, error, 400)
  const over = await shareCheck(row.share_pct, row.active, cur.id)
  if (over) return fail(res, over, 400)
  const { data, error: e } = await supabase.from('partners').update(row).eq('id', cur.id).select('*').single()
  if (e) throw e
  await audit(req, 'editar', 'socio', data.id, { name: data.name, sharePct: Number(data.share_pct), active: data.active })
  res.send(partnerDTO(data))
}))
router.post('/finanzas/socios/retiros', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!Number(b.partnerId)) return fail(res, 'Elige el socio', 400)
  if (!WITHDRAWAL_KINDS[b.kind]) return fail(res, 'Elige si es pago de utilidades o retiro de capital', 400)
  if (!(Number(b.amount) > 0)) return fail(res, 'Escribe un valor mayor que cero', 400)
  if (b.method && !METHODS[b.method]) return fail(res, 'Forma de pago no válida', 400)
  if (b.paidOn && !isDay(b.paidOn)) return fail(res, 'Fecha no válida', 400)
  const { data: p } = await supabase.from('partners').select('id, name').eq('id', Number(b.partnerId)).maybeSingle()
  if (!p) return fail(res, 'Socio no encontrado', 404)
  const { failed, data: id } = await run(res, 'partner_withdrawal', { org_id: req.user.org_id, user_id: req.user.id, site_id: fundSite(b.siteId), partner_id: p.id, kind: b.kind, amount: money(b.amount), method: b.method || 'efectivo', paid_on: b.paidOn || null, note: clean(b.note) })
  if (failed) return
  await audit(req, 'crear', 'retiro_socio', id, { partner: p.name, kind: b.kind, amount: money(b.amount) })
  res.status(201).send({ id })
}))

// ---------------------------------------------------------------- Anular
const VOIDABLE = { entry: 'ingreso_dinero', expense: 'gasto', withdrawal: 'retiro_socio' }
router.post('/finanzas/anular', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!VOIDABLE[b.kind] || !Number(b.id)) return fail(res, 'Documento no válido', 400)
  if (!clean(b.reason)) return fail(res, 'Escribe el motivo de la anulación', 400)
  const { failed } = await run(res, 'finance_void', { org_id: req.user.org_id, user_id: req.user.id, kind: b.kind, id: Number(b.id), reason: clean(b.reason) })
  if (failed) return
  await audit(req, 'anular', VOIDABLE[b.kind], Number(b.id), { reason: clean(b.reason) })
  res.send({ ok: true })
}))

// ---------------------------------------------------------------- Resumen: estado de resultados
const monthOf = (d) => d.slice(0, 7)
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`

const buildFinance = async (req) => {
  const report = await buildReport(req)
  const r = report.range || rangeOf(req.query)
  const site = req.siteId || null
  const bySite = (q) => (site ? q.eq('site_id', site) : q)
  const [{ data: exp, error: e1 }, { data: ent, error: e2 }, { data: wd, error: e3 }, { data: partners }] = await Promise.all([
    bySite(inRange(supabase.from('expenses').select('category, amount, paid_on, source, partner_id').eq('status', 'activo'), 'paid_on', r)),
    bySite(inRange(supabase.from('money_entries').select('kind, amount, received_on, partner_id').eq('status', 'activo'), 'received_on', r)),
    bySite(inRange(supabase.from('partner_withdrawals').select('partner_id, kind, amount, paid_on').eq('status', 'activo'), 'paid_on', r)),
    supabase.from('partners').select('*').eq('active', true).order('share_pct', { ascending: false })
  ])
  if (e1 || e2 || e3) throw e1 || e2 || e3
  return summarize({ report, range: r, expenses: exp || [], entries: ent || [], withdrawals: wd || [], partners: partners || [] })
}

// Cálculo puro (se prueba sin base de datos).
const summarize = ({ report, range, expenses, entries, withdrawals, partners }) => {
  const t = report.totals
  const sales = round(t.sales)
  const cost = round(t.cost)
  const gross = sales - cost
  const losses = round((report.incidents?.rows || []).filter((i) => !i.charged).reduce((a, i) => a + Number(i.cost), 0))
  const operating = expenses.filter((e) => e.category !== 'compras')
  const purchases = round(expenses.filter((e) => e.category === 'compras').reduce((a, e) => a + Number(e.amount), 0))
  const opex = round(operating.reduce((a, e) => a + Number(e.amount), 0))
  const otherIncome = round(entries.filter((e) => e.kind === 'otro_ingreso').reduce((a, e) => a + Number(e.amount), 0))
  const net = gross - opex - losses + otherIncome
  const expenseByCategory = Object.entries(EXPENSE_CATEGORIES).filter(([key]) => key !== 'compras').map(([key, label]) => ({ key, label, total: round(expenses.filter((e) => e.category === key).reduce((a, e) => a + Number(e.amount), 0)) }))
    .filter((c) => c.total > 0).sort((a, b) => b.total - a.total)
  const funding = Object.entries(ENTRY_KINDS).map(([key, label]) => ({ key, label, total: round(entries.filter((e) => e.kind === key).reduce((a, e) => a + Number(e.amount), 0)) })).filter((x) => x.total > 0)

  // Por mes: ventas y costo prorrateado según el margen del rango, gastos y utilidad.
  const costRatio = sales ? cost / sales : 0
  const months = {}
  const m = (k) => (months[k] = months[k] || { month: k, label: monthLabel(k), sales: 0, expenses: 0, otherIncome: 0 })
  for (const d of report.byDay || []) m(monthOf(d.date)).sales += Number(d.sales)
  for (const e of operating) m(monthOf(e.paid_on)).expenses += Number(e.amount)
  for (const e of entries) if (e.kind === 'otro_ingreso') m(monthOf(e.received_on)).otherIncome += Number(e.amount)
  const byMonth = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map((x) => ({
    ...x, sales: round(x.sales), expenses: round(x.expenses), otherIncome: round(x.otherIncome), profit: round(x.sales * (1 - costRatio) - x.expenses + x.otherIncome)
  }))

  const distributable = Math.max(0, net)
  const shareTotal = partners.reduce((a, p) => a + Number(p.share_pct), 0)
  const partnerRows = partners.map((p) => {
    const paid = round(withdrawals.filter((w) => w.partner_id === p.id && w.kind === 'utilidad').reduce((a, w) => a + Number(w.amount), 0))
    const share = round(distributable * Number(p.share_pct) / 100)
    const contributed = round([...entries.filter((e) => e.kind === 'aporte_socio'), ...expenses.filter((e) => e.source === 'socio')].filter((e) => e.partner_id === p.id).reduce((a, e) => a + Number(e.amount), 0))
    return { id: p.id, name: p.name, sharePct: Number(p.share_pct), share, paid, pending: Math.max(0, share - paid), contributed }
  })
  return {
    range,
    statement: {
      sales, cost, gross, grossPct: sales ? Math.round((gross / sales) * 1000) / 10 : null,
      opex, losses, otherIncome, net, netPct: sales ? Math.round((net / sales) * 1000) / 10 : null,
      tips: round(t.tips), discounts: round(t.discounts), courtesies: round(t.courtesies), purchases
    },
    expenseByCategory, funding, byMonth,
    partners: { rows: partnerRows, shareTotal, distributable, retained: round(distributable * Math.max(0, 100 - shareTotal) / 100) }
  }
}

router.get('/finanzas/resumen', auth(ADMIN), h(async (req, res) => {
  try { res.send(await buildFinance(req)) } catch (e) { if (e.status === 400) return fail(res, e.message, 400); throw e }
}))

module.exports = router
module.exports.summarize = summarize
module.exports.fundSite = fundSite
