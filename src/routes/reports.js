// =====================================================================
// Reportes (TD-004): ventas, productos, meseros, propinas (y su reparto), cortesías, anulaciones,
// descuentos e incidentes en un rango de fechas. Solo administradores.
// Las fechas son días de Colombia (desde 00:00 hasta 23:59 del último día).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, todayBogota } = require('../http')
const { auth, ADMIN } = require('../auth')
const { dayStart, nextDay } = require('./logbook')
const { PAY_METHODS, fullName } = require('../ops')

const router = express.Router()

const TZ = 'America/Bogota'
const TYPES = { mesa: 'Mesa', llevar: 'Para llevar', domicilio: 'Domicilio' }
const INCIDENTS = { rotura: 'Rotura', dano: 'Daño', faltante: 'Faltante', accidente: 'Accidente', queja: 'Queja de cliente', otro: 'Otro' }
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d))
const hourOf = (d) => Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: TZ }).format(new Date(d))) % 24
const weekdayOf = (d) => new Date(`${dayOf(d)}T12:00:00-05:00`).getUTCDay()
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
const round = (v) => Math.round(Number(v) || 0)

// PostgREST devuelve máximo 1000 filas por consulta: se pide por páginas.
const all = async (build) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}
const chunks = (arr, n = 300) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))
const inIds = async (ids, build) => (await Promise.all(chunks(ids).map((c) => all(() => build(c))))).flat()

// Rango pedido: por defecto los últimos 7 días. Máximo un año.
const rangeOf = (q) => {
  const to = isDay(q.hasta) ? q.hasta : todayBogota()
  const from = isDay(q.desde) ? q.desde : dayOf(new Date(new Date(`${to}T12:00:00-05:00`).getTime() - 6 * 864e5))
  return { from, to }
}

// Uso de las mesas: cuántas veces se ocupó, cuánto dura en promedio, cuánto vende por hora.
// Sirve para saber cuáles puestos rinden más (reservas, ubicación de grupos, rotación).
const tableStats = (orders) => {
  const net = (o) => Number(o.total) - Number(o.tip)
  const map = {}
  const durations = []
  for (const o of orders.filter((x) => x.table_id && x.opened_at && x.closed_at)) {
    const min = Math.max(1, (new Date(o.closed_at) - new Date(o.opened_at)) / 60000)
    if (min > 12 * 60) continue // pedidos olvidados abiertos toda la noche no cuentan para el promedio
    durations.push(min)
    const t = map[o.table_id] = map[o.table_id] || { tableId: o.table_id, name: o.table?.name || `Mesa ${o.table_id}`, area: o.table?.area?.name || 'Sin zona', seats: o.table?.seats || null, turns: 0, minutes: 0, sales: 0, guests: 0, guestTurns: 0 }
    t.turns += 1; t.minutes += min; t.sales += net(o)
    if (o.guests) { t.guests += Number(o.guests); t.guestTurns += 1 }
  }
  const rows = Object.values(map).map((t) => ({
    tableId: t.tableId, name: t.name, area: t.area, seats: t.seats, turns: t.turns,
    avgMinutes: Math.round(t.minutes / t.turns), hours: Math.round((t.minutes / 60) * 10) / 10, sales: round(t.sales),
    avgTicket: round(t.sales / t.turns), perHour: round(t.sales / (t.minutes / 60)), avgGuests: t.guestTurns ? Math.round((t.guests / t.guestTurns) * 10) / 10 : null
  })).sort((a, b) => b.perHour - a.perHour)
  const areas = {}
  for (const r of rows) {
    const a = areas[r.area] = areas[r.area] || { area: r.area, turns: 0, minutes: 0, sales: 0 }
    a.turns += r.turns; a.minutes += r.avgMinutes * r.turns; a.sales += r.sales
  }
  const sorted = [...durations].sort((a, b) => a - b)
  return {
    turns: durations.length,
    avgMinutes: durations.length ? Math.round(durations.reduce((a, x) => a + x, 0) / durations.length) : 0,
    medianMinutes: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0,
    perHour: rows.length ? round(rows.reduce((a, r) => a + r.sales, 0) / (rows.reduce((a, r) => a + r.hours, 0) || 1)) : 0,
    rows,
    areas: Object.values(areas).map((a) => ({ area: a.area, turns: a.turns, avgMinutes: Math.round(a.minutes / a.turns), sales: round(a.sales), perHour: round(a.sales / (a.minutes / 60)) })).sort((a, b) => b.perHour - a.perHour)
  }
}

const buildReport = async (req) => {
  const { from, to } = rangeOf(req.query)
  if (from > to) throw Object.assign(new Error('La fecha inicial es posterior a la final'), { status: 400 })
  if ((new Date(to) - new Date(from)) / 864e5 > 366) throw Object.assign(new Error('El rango máximo es de un año'), { status: 400 })
  const start = dayStart(from)
  const end = nextDay(to)
  const site = req.siteId || null
  const bySite = (q) => (site ? q.eq('site_id', site) : q)

  const [orders, voidedOrders, payouts, incidents, sites] = await Promise.all([
    all(() => bySite(supabase.from('orders').select('id, number, site_id, type, guests, waiter_id, gross, courtesy_total, subtotal, discount_name, discount_total, tip, total, closed_at, opened_at, table_id, table:dining_tables(name, seats, area:dining_areas(name))')
      .eq('status', 'cobrado').gte('closed_at', start).lt('closed_at', end)).order('closed_at')),
    all(() => bySite(supabase.from('orders').select('id, number, site_id, total, gross, void_reason, closed_at, updated_at, voider:users!orders_voided_by_fkey(name, last_name), table:dining_tables(name)')
      .eq('status', 'anulado').gte('updated_at', start).lt('updated_at', end)).order('updated_at')),
    all(() => supabase.from('tip_payouts').select('id, amount, user_id, created_at, user:users!tip_payouts_user_id_fkey(name, last_name), session:cash_sessions!inner(number, site_id)')
      .gte('created_at', start).lt('created_at', end).order('created_at')).then((r) => (site ? r.filter((t) => t.session?.site_id === site) : r)),
    all(() => bySite(supabase.from('incidents').select('id, number, type, title, cost, status, occurred_at, charge_to_responsible, responsible:users!incidents_responsible_id_fkey(name, last_name)')
      .gte('occurred_at', start).lt('occurred_at', end)).neq('status', 'descartado').order('occurred_at')),
    supabase.from('sites').select('id, name').then((r) => r.data || [])
  ])
  const ids = orders.map((o) => o.id)
  const [items, payments, voidedItems] = await Promise.all([
    inIds(ids, (c) => supabase.from('order_items').select('id, order_id, product_id, name, quantity, list_price, unit_price, courtesy, courtesy_reason, status, user_id, product:products(cost, category_id, category:product_categories(name, emoji)), courtesier:users!order_items_courtesy_by_fkey(name, last_name)').in('order_id', c)),
    inIds(ids, (c) => supabase.from('order_payments').select('order_id, method, amount').in('order_id', c)),
    all(() => supabase.from('order_items').select('id, order_id, name, quantity, unit_price, void_reason, created_at, user:users!order_items_user_id_fkey(name, last_name), order:orders!inner(number, site_id, status)')
      .eq('status', 'anulado').gte('created_at', start).lt('created_at', end).order('created_at')).then((r) => r.filter((i) => i.order.status !== 'anulado' && (!site || i.order.site_id === site)))
  ])
  const waiterIds = [...new Set([...orders.map((o) => o.waiter_id), ...payouts.map((t) => t.user_id)].filter(Boolean))]
  const people = waiterIds.length ? (await supabase.from('users').select('id, name, last_name, positions, active').in('id', waiterIds)).data || [] : []
  const nameOf = (id) => fullName(people.find((p) => p.id === id)) || 'Sin asignar'
  const siteName = (id) => sites.find((s) => s.id === id)?.name || '—'

  // ---------- Ventas
  const net = (o) => Number(o.total) - Number(o.tip) // lo vendido sin la propina
  const sales = orders.reduce((a, o) => a + net(o), 0)
  const days = []
  for (let d = from; d <= to; d = dayOf(new Date(`${d}T12:00:00-05:00`).getTime() + 864e5)) days.push({ date: d, sales: 0, orders: 0, tips: 0, guests: 0 })
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, sales: 0, orders: 0 }))
  const byWeekday = WEEKDAYS.map((label, day) => ({ day, label, sales: 0, orders: 0 }))
  const byType = {}
  const bySiteMap = {}
  for (const o of orders) {
    const d = days.find((x) => x.date === dayOf(o.closed_at))
    if (d) { d.sales += net(o); d.orders += 1; d.tips += Number(o.tip); d.guests += Number(o.guests || 0) }
    const hh = byHour[hourOf(o.closed_at)]; hh.sales += net(o); hh.orders += 1
    const wd = byWeekday[weekdayOf(o.closed_at)]; wd.sales += net(o); wd.orders += 1
    byType[o.type] = byType[o.type] || { type: o.type, label: TYPES[o.type], sales: 0, orders: 0 }
    byType[o.type].sales += net(o); byType[o.type].orders += 1
    bySiteMap[o.site_id] = bySiteMap[o.site_id] || { siteId: o.site_id, site: siteName(o.site_id), sales: 0, orders: 0, tips: 0 }
    bySiteMap[o.site_id].sales += net(o); bySiteMap[o.site_id].orders += 1; bySiteMap[o.site_id].tips += Number(o.tip)
  }
  const byMethodMap = {}
  for (const p of payments) byMethodMap[p.method] = (byMethodMap[p.method] || 0) + Number(p.amount)

  // ---------- Productos y categorías
  const products = {}
  const categories = {}
  let cost = 0
  const courtesies = []
  for (const i of items.filter((x) => x.status !== 'anulado')) {
    const k = i.product_id || `x-${i.name}`
    const qty = Number(i.quantity)
    const revenue = i.courtesy ? 0 : qty * Number(i.unit_price)
    const c = qty * Number(i.product?.cost || 0)
    cost += c
    products[k] = products[k] || { productId: i.product_id, name: i.name, category: i.product?.category?.name || 'Sin categoría', emoji: i.product?.category?.emoji || '', qty: 0, courtesyQty: 0, revenue: 0, cost: 0, orders: new Set() }
    const p = products[k]
    p.qty += qty; p.revenue += revenue; p.cost += c; p.orders.add(i.order_id)
    if (i.courtesy) {
      p.courtesyQty += qty
      const o = orders.find((x) => x.id === i.order_id)
      courtesies.push({ id: i.id, order: o?.number, orderId: i.order_id, name: i.name, quantity: qty, value: qty * Number(i.list_price), reason: i.courtesy_reason, by: fullName(i.courtesier), at: o?.closed_at })
    }
    const ck = p.category
    categories[ck] = categories[ck] || { name: ck, emoji: p.emoji, qty: 0, revenue: 0, cost: 0 }
    categories[ck].qty += qty; categories[ck].revenue += revenue; categories[ck].cost += c
  }
  const productRows = Object.values(products).map((p) => ({ ...p, orders: p.orders.size, revenue: round(p.revenue), cost: round(p.cost), margin: round(p.revenue - p.cost), marginPct: p.revenue ? Math.round(((p.revenue - p.cost) / p.revenue) * 1000) / 10 : null })).sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
  const categoryRows = Object.values(categories).map((c) => ({ ...c, revenue: round(c.revenue), cost: round(c.cost), margin: round(c.revenue - c.cost) })).sort((a, b) => b.revenue - a.revenue)

  // ---------- Meseros
  const waiters = {}
  const w = (id) => { waiters[id] = waiters[id] || { userId: id, name: nameOf(id), orders: 0, sales: 0, guests: 0, tipsGenerated: 0, tipsReceived: 0, courtesies: 0, voids: 0 }; return waiters[id] }
  for (const o of orders) { const x = w(o.waiter_id || 0); x.orders += 1; x.sales += net(o); x.guests += Number(o.guests || 0); x.tipsGenerated += Number(o.tip); x.courtesies += Number(o.courtesy_total) }
  for (const t of payouts) w(t.user_id).tipsReceived += Number(t.amount)
  for (const i of voidedItems) { const o = orders.find((x) => x.number === i.order.number); if (o) w(o.waiter_id || 0).voids += 1 }
  const waiterRows = Object.values(waiters).map((x) => ({ ...x, avgTicket: x.orders ? round(x.sales / x.orders) : 0, share: sales ? Math.round((x.sales / sales) * 1000) / 10 : 0 })).sort((a, b) => b.sales - a.sales)

  // ---------- Propinas y su reparto
  const tipsGenerated = orders.reduce((a, o) => a + Number(o.tip), 0)
  const tipsPaid = payouts.reduce((a, t) => a + Number(t.amount), 0)
  const payoutByUser = {}
  for (const t of payouts) {
    payoutByUser[t.user_id] = payoutByUser[t.user_id] || { userId: t.user_id, name: fullName(t.user), amount: 0, times: 0 }
    payoutByUser[t.user_id].amount += Number(t.amount); payoutByUser[t.user_id].times += 1
  }

  const discounts = {}
  for (const o of orders.filter((x) => Number(x.discount_total) > 0)) {
    const k = o.discount_name || 'Descuento'
    discounts[k] = discounts[k] || { name: k, orders: 0, amount: 0 }
    discounts[k].orders += 1; discounts[k].amount += Number(o.discount_total)
  }

  const incidentTypes = {}
  for (const i of incidents) {
    incidentTypes[i.type] = incidentTypes[i.type] || { type: i.type, label: INCIDENTS[i.type], count: 0, cost: 0 }
    incidentTypes[i.type].count += 1; incidentTypes[i.type].cost += Number(i.cost)
  }

  const discountTotal = orders.reduce((a, o) => a + Number(o.discount_total), 0)
  const courtesyTotal = orders.reduce((a, o) => a + Number(o.courtesy_total), 0)
  const guests = orders.reduce((a, o) => a + Number(o.guests || 0), 0)
  return {
    range: { from, to, days: days.length }, site: site ? siteName(site) : null,
    totals: {
      sales: round(sales), orders: orders.length, avgTicket: orders.length ? round(sales / orders.length) : 0, guests, perGuest: guests ? round(sales / guests) : 0,
      tips: round(tipsGenerated), tipsPaid: round(tipsPaid), discounts: round(discountTotal), courtesies: round(courtesyTotal), cost: round(cost), grossMargin: round(sales - cost),
      voidedOrders: voidedOrders.length, voidedValue: round(voidedOrders.reduce((a, o) => a + Number(o.gross), 0)), voidedItems: voidedItems.length,
      voidedItemsValue: round(voidedItems.reduce((a, i) => a + Number(i.quantity) * Number(i.unit_price), 0)),
      incidents: incidents.length, incidentsCost: round(incidents.reduce((a, i) => a + Number(i.cost), 0))
    },
    byDay: days.map((d) => ({ ...d, sales: round(d.sales), tips: round(d.tips) })),
    byHour: byHour.map((x) => ({ ...x, sales: round(x.sales) })),
    byWeekday: byWeekday.map((x) => ({ ...x, sales: round(x.sales) })),
    byType: Object.values(byType).map((x) => ({ ...x, sales: round(x.sales) })),
    bySite: Object.values(bySiteMap).map((x) => ({ ...x, sales: round(x.sales), tips: round(x.tips) })).sort((a, b) => b.sales - a.sales),
    byMethod: Object.entries(byMethodMap).map(([method, amount]) => ({ method, label: PAY_METHODS[method] || method, amount: round(amount) })).sort((a, b) => b.amount - a.amount),
    products: productRows, categories: categoryRows, waiters: waiterRows, tables: tableStats(orders),
    tips: {
      generated: round(tipsGenerated), paid: round(tipsPaid), pending: round(tipsGenerated - tipsPaid),
      byEmployee: Object.values(payoutByUser).map((x) => ({ ...x, amount: round(x.amount) })).sort((a, b) => b.amount - a.amount),
      payouts: payouts.map((t) => ({ id: t.id, name: fullName(t.user), amount: Number(t.amount), session: t.session?.number, at: t.created_at }))
    },
    discounts: Object.values(discounts).map((x) => ({ ...x, amount: round(x.amount) })).sort((a, b) => b.amount - a.amount),
    courtesies: courtesies.sort((a, b) => String(b.at).localeCompare(String(a.at))),
    voids: {
      orders: voidedOrders.map((o) => ({ id: o.id, number: o.number, table: o.table?.name ?? null, value: Number(o.gross), reason: o.void_reason, by: fullName(o.voider), at: o.updated_at })),
      items: voidedItems.map((i) => ({ id: i.id, order: i.order.number, orderId: i.order_id, name: i.name, quantity: Number(i.quantity), value: round(Number(i.quantity) * Number(i.unit_price)), reason: i.void_reason, by: fullName(i.user), at: i.created_at }))
    },
    incidents: { byType: Object.values(incidentTypes).sort((a, b) => b.cost - a.cost), rows: incidents.map((i) => ({ id: i.id, number: i.number, typeLabel: INCIDENTS[i.type], title: i.title, cost: Number(i.cost), status: i.status, responsible: fullName(i.responsible), charged: i.charge_to_responsible, at: i.occurred_at })) }
  }
}

router.get('/reportes', auth(ADMIN), h(async (req, res) => {
  try { res.send(await buildReport(req)) } catch (e) { if (e.status === 400) return fail(res, e.message, 400); throw e }
}))

module.exports = router
module.exports.buildReport = buildReport
module.exports.rangeOf = rangeOf
module.exports.tableStats = tableStats
