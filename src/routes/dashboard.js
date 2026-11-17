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
const { tableStats } = require('./reports')

const router = express.Router()

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
    const monthStart = `${today.slice(0, 7)}-01`
    const [vaults, expMonth, requests, incidents] = await Promise.all([
      safe(supabase.from('vaults').select('site_id, balance'), []),
      safe(site(supabase.from('expenses').select('amount').eq('status', 'activo').gte('paid_on', monthStart)), []),
      safe(site(supabase.from('cash_requests').select('id, number, amount, reason, created_at, session:cash_sessions(number, register:cash_registers(name))').eq('status', 'pendiente').order('created_at')), []),
      count('incidents', (q) => site(q.eq('status', 'abierto')))
    ])
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
        receivables: (cxc.data || []).reduce((a, r) => a + Number(r.amount) - Number(r.paid), 0)
      },
      tableUsage: { days: 30, turns: usage.turns, avgMinutes: usage.avgMinutes, medianMinutes: usage.medianMinutes, perHour: usage.perHour, best: usage.rows.slice(0, 5), areas: usage.areas },
      salesByHour: sales.byHour.filter((x) => x.hour >= 6 || x.total > 0),
      calls: (calls.data || []).map((c) => ({ id: c.id, kind: c.kind, table: c.table?.name, createdAt: c.created_at })),
      sessions: (sessions.data || []).map((x) => ({ id: x.id, number: x.number, register: x.register?.name, site: x.site?.name, openingAmount: Number(x.opening_amount), openedAt: x.opened_at })),
      alerts: alerts.slice(0, 8),
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
