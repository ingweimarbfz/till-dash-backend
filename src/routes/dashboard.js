// =====================================================================
// Dashboard por rol: usuarios, sucursales, bodegas, actividad, productos y stock bajo (etapa 2);
// ventas, pedidos, propinas, mesas, caja, llamados y cuentas por cobrar (etapa 3).
// El empleado ve lo de sus cargos: el mesero sus pedidos y propinas, el cajero su turno, la cocina sus comandas.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, todayBogota } = require('../http')
const { auth } = require('../auth')
const { dayStart } = require('./logbook')
const { currentAlerts } = require('../stock')
const { expiryBoard } = require('../lots')
const { tableStats } = require('./reports')

const plan = require('../plan')
const router = express.Router()

// Ranking del personal por las calificaciones del cliente (últimos 30 días).
// Orden: promedio ponderado (bayesiano) para que 1 sola calificación de 5 no gane a 20 de 4,8.
const staffRanking = async (site, since) => {
  const { data } = await site(supabase.from('service_ratings').select('waiter_id, stars, waiter:users!service_ratings_waiter_id_fkey(name, last_name, avatar_url)').gte('created_at', since).not('waiter_id', 'is', null))
  const rows = data || []
  if (!rows.length) return { count: 0, avg: null, rows: [] }
  const global = rows.reduce((a, r) => a + r.stars, 0) / rows.length
  const m = {}
  for (const r of rows) {
    m[r.waiter_id] = m[r.waiter_id] || { id: r.waiter_id, name: `${r.waiter?.name || ''} ${r.waiter?.last_name || ''}`.trim(), avatarUrl: r.waiter?.avatar_url || null, sum: 0, count: 0, five: 0 }
    m[r.waiter_id].sum += r.stars; m[r.waiter_id].count++; if (r.stars === 5) m[r.waiter_id].five++
  }
  const K = 3
  return {
    count: rows.length, avg: Math.round(global * 10) / 10,
    rows: Object.values(m).map((x) => ({ id: x.id, name: x.name, avatarUrl: x.avatarUrl, count: x.count, five: x.five, avg: Math.round((x.sum / x.count) * 10) / 10, score: (x.sum + K * global) / (x.count + K) }))
      .sort((a, b) => b.score - a.score || b.count - a.count).slice(0, 8)
  }
}

// Ventas del día (pedidos cobrados desde la medianoche de Colombia) y su reparto por hora.
const salesOf = async (from, filter) => {
  const { data } = await filter(supabase.from('orders').select('total, tip, discount_total, courtesy_total, closed_at, waiter_id').eq('status', 'cobrado').gte('closed_at', from))
  const rows = data || []
  const byHour = Array.from({ length: 24 }, (_, hh) => ({ hour: hh, total: 0 }))
  for (const o of rows) {
    const hh = Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/Bogota' }).format(new Date(o.closed_at))) % 24
    byHour[hh].total += Number(o.total) - Number(o.tip)
  }
  const sum = (k) => rows.reduce((a, o) => a + Number(o[k]), 0)
  const sales = sum('total') - sum('tip')
  return { sales, orders: rows.length, tips: sum('tip'), discounts: sum('discount_total'), courtesies: sum('courtesy_total'), avgTicket: rows.length ? Math.round(sales / rows.length) : 0, byHour, rows }
}

// PostgREST devuelve máximo 1000 filas por consulta: se pide por páginas.
const pages = async (build) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}

// Duración de los turnos de caja (desde que se abre hasta que se cierra), últimos 30 días.
const shiftStats = async (site, since) => {
  const rows = await pages(() => site(supabase.from('cash_sessions').select('id, number, status, opened_at, closed_at, register:cash_registers(name)').gte('opened_at', since)).order('opened_at', { ascending: false }))
  const closed = rows.filter((r) => r.closed_at).map((r) => ({ ...r, minutes: Math.max(0, Math.round((new Date(r.closed_at) - new Date(r.opened_at)) / 60000)) }))
  const mins = closed.map((r) => r.minutes)
  return {
    days: 30, closed: closed.length,
    avgMinutes: mins.length ? Math.round(mins.reduce((a, x) => a + x, 0) / mins.length) : 0,
    maxMinutes: mins.length ? Math.max(...mins) : 0, minMinutes: mins.length ? Math.min(...mins) : 0,
    recent: closed.slice(0, 6).map((r) => ({ id: r.id, number: r.number, register: r.register?.name ?? null, openedAt: r.opened_at, closedAt: r.closed_at, minutes: r.minutes }))
  }
}

// Productos más y menos vendidos (últimos 30 días). Los menos vendidos incluyen los que no se vendieron
// nada y están en la carta: candidatos para una promoción o publicidad.
const productMix = async (site, since) => {
  const orders = await pages(() => site(supabase.from('orders').select('id').eq('status', 'cobrado').gte('closed_at', since)))
  const ids = orders.map((o) => o.id)
  const items = []
  for (let i = 0; i < ids.length; i += 300) items.push(...await pages(() => supabase.from('order_items').select('order_id, product_id, quantity, unit_price, courtesy, status').in('order_id', ids.slice(i, i + 300))))
  const { data: prods } = await supabase.from('products').select('id, name, price, photo_url, show_in_menu, created_at, category:product_categories(name, emoji)').eq('active', true)
  const m = {}
  for (const it of items.filter((x) => x.status !== 'anulado' && x.product_id)) {
    const k = it.product_id
    m[k] = m[k] || { qty: 0, revenue: 0, orders: new Set() }
    m[k].qty += Number(it.quantity); if (!it.courtesy) m[k].revenue += Number(it.quantity) * Number(it.unit_price); m[k].orders.add(it.order_id)
  }
  const rows = (prods || []).map((p) => ({
    id: p.id, name: p.name, price: Number(p.price), photoUrl: p.photo_url, inMenu: p.show_in_menu, category: p.category?.name || 'Sin categoría', emoji: p.category?.emoji || '',
    qty: Math.round((m[p.id]?.qty || 0) * 100) / 100, revenue: Math.round(m[p.id]?.revenue || 0), orders: m[p.id]?.orders.size || 0,
    isNew: Date.now() - new Date(p.created_at).getTime() < 7 * 864e5
  }))
  const totalQty = rows.reduce((a, r) => a + r.qty, 0)
  const withShare = (r) => ({ ...r, share: totalQty ? Math.round((r.qty / totalQty) * 1000) / 10 : 0 })
  return {
    days: 30, orders: ids.length,
    top: [...rows].filter((r) => r.qty > 0).sort((a, b) => b.qty - a.qty || b.revenue - a.revenue).slice(0, 6).map(withShare),
    bottom: [...rows].filter((r) => r.inMenu && !r.isNew).sort((a, b) => a.qty - b.qty || a.revenue - b.revenue).slice(0, 6).map(withShare),
    unsold: rows.filter((r) => r.inMenu && !r.isNew && r.qty === 0).length
  }
}

// Tiempos de preparación (últimos 30 días): de lo que pasa por cocina, bar o barista, cuánto tarda
// desde que se pide hasta que queda listo. Si la estación lo marcó "en preparación", también se separa
// la espera en cola del tiempo de preparación. Más de 6 horas se descarta (lo marcaron tarde u olvidaron).
const PREP_MAX_MIN = 360
const prepTimes = async (since, siteId) => {
  const rows = await pages(() => {
    let q = supabase.from('order_items').select('product_id, name, area, quantity, created_at, started_at, ready_at, order:orders!inner(site_id)')
      .neq('area', 'ninguna').neq('status', 'anulado').not('ready_at', 'is', null).gte('created_at', since).order('id')
    if (siteId) q = q.eq('order.site_id', siteId)
    return q
  })
  const mins = (a, b) => (new Date(b) - new Date(a)) / 60000
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10 : null)
  const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b); const m = v.length >> 1; return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10 }
  const items = rows.map((r) => ({ ...r, total: mins(r.created_at, r.ready_at), prep: r.started_at ? mins(r.started_at, r.ready_at) : null, wait: r.started_at ? mins(r.created_at, r.started_at) : null }))
    .filter((r) => r.total >= 0 && r.total <= PREP_MAX_MIN)
  const group = (key) => {
    const g = {}
    for (const r of items) { const k = key(r); (g[k] = g[k] || []).push(r) }
    return g
  }
  const summary = (list) => {
    const prep = list.map((r) => r.prep).filter((x) => x !== null && x >= 0)
    const wait = list.map((r) => r.wait).filter((x) => x !== null && x >= 0)
    return { count: list.length, avgMinutes: avg(list.map((r) => r.total)), medianMinutes: median(list.map((r) => r.total)), maxMinutes: list.length ? Math.round(Math.max(...list.map((r) => r.total)) * 10) / 10 : null, avgPrepMinutes: avg(prep), avgWaitMinutes: avg(wait) }
  }
  const products = Object.values(group((r) => r.product_id || r.name)).map((list) => ({ id: list[0].product_id, name: list[0].name, area: list[0].area, ...summary(list) }))
  // Con pocos datos se acepta una sola medición; con más, se piden al menos 3 para no castigar un caso aislado.
  const minCount = products.filter((p) => p.count >= 3).length >= 6 ? 3 : 1
  const ranked = products.filter((p) => p.count >= minCount)
  const byArea = Object.entries(group((r) => r.area)).map(([area, list]) => ({ area, ...summary(list) })).sort((a, b) => b.avgMinutes - a.avgMinutes)
  return {
    days: 30, minCount, ...summary(items), areas: byArea, products: products.length,
    slowest: [...ranked].sort((a, b) => b.avgMinutes - a.avgMinutes).slice(0, 6),
    fastest: [...ranked].sort((a, b) => a.avgMinutes - b.avgMinutes).slice(0, 6)
  }
}

const count = async (table, f = (q) => q) => (await f(supabase.from(table).select('id', { count: 'exact', head: true }))).count || 0
// Consulta que no tumba el dashboard si una tabla nueva aún no existe (migración sin correr).
const safe = (p, fallback) => Promise.resolve(p).then((r) => (r?.error ? { data: fallback, count: 0 } : r)).catch(() => ({ data: fallback, count: 0 }))
const minutesSince = (d) => Math.max(0, Math.round((Date.now() - new Date(d)) / 60000))

router.get('/dashboard', auth(), h(async (req, res) => {
  const { role } = req.user
  const today = todayBogota()
  if (role === 'superadmin' || role === 'admin') {
    const site = (q) => (req.siteId ? q.eq('site_id', req.siteId) : q)
    let whs = null
    if (req.siteId) whs = ((await supabase.from('warehouses').select('id').eq('site_id', req.siteId)).data || []).map((w) => w.id)
    const from = dayStart(today)
    const month = new Date(Date.now() - 30 * 864e5).toISOString()
    const [users, employees, sites, warehouses, activityToday, recent, products, alerts, sales, openOrders, tables, occupied, calls, sessions, cxc, used] = await Promise.all([
      count('users', (q) => site(q.eq('active', true))),
      count('users', (q) => site(q.eq('active', true).eq('role', 'empleado'))),
      count('sites', (q) => q.eq('active', true)),
      count('warehouses', (q) => q.eq('active', true)),
      count('audit_log', (q) => site(q.gte('created_at', dayStart(today)))),
      site(supabase.from('audit_log').select('id, action, entity, created_at, user:users(name, last_name)')
        .order('created_at', { ascending: false }).limit(8)),
      count('products', (q) => q.eq('active', true)),
      currentAlerts(whs),
      salesOf(from, site),
      count('orders', (q) => site(q.eq('status', 'abierto'))),
      count('dining_tables', (q) => site(q.eq('active', true))),
      count('orders', (q) => site(q.eq('status', 'abierto').not('table_id', 'is', null))),
      site(supabase.from('table_calls').select('id, kind, created_at, table:dining_tables(name)').eq('status', 'pendiente').order('created_at')),
      site(supabase.from('cash_sessions').select('id, number, opening_amount, opened_at, register:cash_registers(name), site:sites(name)').eq('status', 'abierta')),
      site(supabase.from('receivables').select('amount, paid').eq('status', 'pendiente')),
      site(supabase.from('orders').select('id, table_id, guests, total, tip, opened_at, closed_at, table:dining_tables!orders_table_id_fkey(name, seats, area:dining_areas(name))')
        .eq('status', 'cobrado').not('table_id', 'is', null).gte('closed_at', month)).order('closed_at', { ascending: false }).limit(3000)
    ])
    const usage = tableStats(used.data || [])
    // Domicilios abiertos (en una distribuidora es el tablero principal).
    const { data: dl } = await site(supabase.from('orders').select('delivery_status').eq('type', 'domicilio').eq('status', 'abierto'))
    const st = await plan.ensure(req.user.org_id)
    const monthStart = `${today.slice(0, 7)}-01`
    const [vaults, expMonth, requests, incidents] = await Promise.all([
      safe(supabase.from('vaults').select('site_id, balance'), []),
      safe(site(supabase.from('expenses').select('amount').eq('status', 'activo').gte('paid_on', monthStart)), []),
      safe(site(supabase.from('cash_requests').select('id, number, amount, reason, created_at, session:cash_sessions(number, register:cash_registers(name))').eq('status', 'pendiente').order('created_at')), []),
      count('incidents', (q) => site(q.eq('status', 'abierto')))
    ])
    // TD-016: lotes vencidos y por vencer (si la migración aún no corre, queda en null).
    const expiry = await expiryBoard({ warehouseIds: whs }).catch(() => null)
    const funds = (vaults.data || []).filter((v) => !req.siteId || v.site_id === req.siteId || v.site_id === null)
    return res.send({
      money: {
        funds: funds.reduce((a, v) => a + Number(v.balance), 0), expensesMonth: (expMonth.data || []).reduce((a, e) => a + Number(e.amount), 0), openIncidents: incidents,
        requests: (requests.data || []).map((r) => ({ id: r.id, number: r.number, amount: Number(r.amount), reason: r.reason, session: r.session?.number, register: r.session?.register?.name, createdAt: r.created_at }))
      },
      role,
      kpis: {
        users, employees, sites, warehouses, activityToday, products, lowStock: alerts.filter((a) => !a.out).length, outOfStock: alerts.filter((a) => a.out).length,
        salesToday: sales.sales, ordersToday: sales.orders, tipsToday: sales.tips, avgTicket: sales.avgTicket, discountsToday: sales.discounts, courtesiesToday: sales.courtesies,
        openOrders, tables, occupiedTables: occupied, pendingCalls: (calls.data || []).length, openSessions: (sessions.data || []).length,
        receivables: (cxc.data || []).reduce((a, r) => a + Number(r.amount) - Number(r.paid), 0),
        deliveriesPending: (dl || []).filter((o) => (o.delivery_status || 'por_despachar') === 'por_despachar').length,
        deliveriesOnTheWay: (dl || []).filter((o) => o.delivery_status === 'en_camino').length
      },
      mode: plan.modeOf(st),
      staffRanking: await staffRanking(site, month),
      shifts: await safe(shiftStats(site, month).then((data) => ({ data })), null).then((r) => r.data),
      productMix: await safe(productMix(site, month).then((data) => ({ data })), null).then((r) => r.data),
      prepTimes: await safe(prepTimes(month, req.siteId).then((data) => ({ data })), null).then((r) => r.data),
      tableUsage: !plan.has(st, 'mesas') ? null : { days: 30, turns: usage.turns, avgMinutes: usage.avgMinutes, medianMinutes: usage.medianMinutes, perHour: usage.perHour, best: usage.rows.slice(0, 5), areas: usage.areas },
      salesByHour: sales.byHour.filter((x) => x.hour >= 6 || x.total > 0),
      calls: (calls.data || []).map((c) => ({ id: c.id, kind: c.kind, table: c.table?.name, createdAt: c.created_at })),
      sessions: (sessions.data || []).map((x) => ({ id: x.id, number: x.number, register: x.register?.name, site: x.site?.name, openingAmount: Number(x.opening_amount), openedAt: x.opened_at, minutes: minutesSince(x.opened_at) })),
      alerts: alerts.slice(0, 8),
      expiry: expiry ? { windowDays: expiry.windowDays, summary: expiry.summary, rows: expiry.rows.slice(0, 8) } : null,
      recent: (recent.data || []).map((a) => ({ id: a.id, action: a.action, entity: a.entity, createdAt: a.created_at, user: a.user ? `${a.user.name} ${a.user.last_name || ''}`.trim() : null }))
    })
  }
  if (role === 'empleado') {
    const from = dayStart(today)
    const pos = req.user.positions || []
    const siteId = req.user.site_id
    const mySite = (q) => q.eq('site_id', siteId || 0)
    const [myToday, mine, myOpen, session, kitchen, calls] = await Promise.all([
      count('audit_log', (q) => q.eq('user_id', req.user.id).gte('created_at', from)),
      salesOf(from, (q) => q.eq('waiter_id', req.user.id)),
      count('orders', (q) => q.eq('waiter_id', req.user.id).eq('status', 'abierto')),
      pos.includes('cajero') ? mySite(supabase.from('cash_sessions').select('id, number, opening_amount, opened_at, register:cash_registers(name)').eq('status', 'abierta')).order('opened_at').limit(1).maybeSingle() : { data: null },
      pos.some((p) => ['cocina', 'bartender', 'barista'].includes(p))
        ? supabase.from('order_items').select('id, status, area, order:orders!inner(site_id, status)').in('status', ['pendiente', 'preparando']).eq('order.site_id', siteId || 0).eq('order.status', 'abierto')
        : { data: null },
      mySite(supabase.from('table_calls').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'))
    ])
    const AREA = { cocina: 'cocina', bartender: 'bar', barista: 'barista' }
    const areas = pos.map((p) => AREA[p]).filter(Boolean)
    const k = (kitchen.data || []).filter((i) => areas.includes(i.area))
    const sells = pos.some((p) => ['mesero', 'cajero', 'host', 'bartender', 'barista'].includes(p))
    // Mesero: sus mesas abiertas con lo que está listo para llevar.
    const tablesQ = sells ? await supabase.from('orders').select('id, number, alias, guests, total, opened_at, bill_requested_at, type, table:dining_tables!orders_table_id_fkey(name), items:order_items(status)')
      .eq('waiter_id', req.user.id).eq('status', 'abierto').order('opened_at') : { data: [] }
    const myTables = (tablesQ.data || []).map((o) => ({
      id: o.id, number: o.number, name: o.table?.name || (o.type === 'domicilio' ? 'Domicilio' : 'Para llevar'), alias: o.alias, guests: o.guests, total: Number(o.total),
      minutes: minutesSince(o.opened_at), billRequested: Boolean(o.bill_requested_at), ready: (o.items || []).filter((i) => i.status === 'listo').length,
      cooking: (o.items || []).filter((i) => ['pendiente', 'preparando'].includes(i.status)).length
    }))
    // Cajero: cifras del turno abierto, gastos y solicitudes.
    let shift = null
    if (session.data) {
      const sid = session.data.id
      const [cash, sold, exp, reqs] = await Promise.all([
        supabase.rpc('session_cash', { p_session: sid }),
        supabase.from('orders').select('total, tip').eq('session_id', sid).eq('status', 'cobrado'),
        safe(supabase.from('expenses').select('amount').eq('session_id', sid).eq('status', 'activo'), []),
        safe(supabase.from('cash_requests').select('number, amount, status').eq('session_id', sid).order('id', { ascending: false }), [])
      ])
      const so = sold.data || []
      shift = {
        expectedCash: Number(cash.data || 0), sales: so.reduce((a, o) => a + Number(o.total) - Number(o.tip), 0), orders: so.length, tips: so.reduce((a, o) => a + Number(o.tip), 0),
        expenses: (exp.data || []).reduce((a, e) => a + Number(e.amount), 0), requests: (reqs.data || []).map((r) => ({ number: r.number, amount: Number(r.amount), status: r.status }))
      }
    }
    // Cocina y bar: cuánto lleva esperando la comanda más antigua.
    let oldest = null
    if (k.length) {
      const { data: od } = await supabase.from('order_items').select('created_at').in('id', k.filter((i) => i.status === 'pendiente').map((i) => i.id)).order('created_at').limit(1)
      oldest = od?.[0] ? minutesSince(od[0].created_at) : null
    }
    return res.send({
      myTables, shift, kitchenOldest: oldest,
      role, positions: pos, site: req.user.site?.name || null,
      kpis: {
        myActivityToday: myToday, mySalesToday: mine.sales, myOrdersToday: mine.orders, myTipsToday: mine.tips, myOpenOrders: myOpen, pendingCalls: calls.count || 0,
        kitchenPending: k.filter((i) => i.status === 'pendiente').length, kitchenPreparing: k.filter((i) => i.status === 'preparando').length
      },
      session: session.data ? { id: session.data.id, number: session.data.number, register: session.data.register?.name, openingAmount: Number(session.data.opening_amount), openedAt: session.data.opened_at } : null
    })
  }
  res.send({ role })
}))

module.exports = router
