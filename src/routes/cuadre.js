// =====================================================================
// Cuadre del día (TD-006): todo lo que pasó con el dinero en una jornada, para ver si las cuentas cuadran.
// Jornada (TD-019): un turno pertenece a la jornada del día en que se abrió, y la jornada empieza a la hora de
// corte configurada (por defecto 6 a. m.). Así un turno de 4 p. m. a 2 a. m. y otro abierto a las 3 a. m. son de
// la misma jornada. Lo vendido, las propinas y los gastos se toman de esos mismos turnos, para que cuadren.
// · Turnos de caja del día: base, ventas por forma de pago, gastos, propinas, esperado vs. contado y lo que pasó a la bóveda.
// · Lo vendido: pedidos cobrados, descuentos, cortesías y propinas.
// · Caja general (fondos): saldo al iniciar y al terminar el día, y sus movimientos.
// · Verificaciones: cobros en caja vs. pedidos cobrados, diferencias de arqueo y cierres que llegaron a la bóveda.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail } = require('../http')
const { auth, ADMIN } = require('../auth')
const { PAY_METHODS, fullName } = require('../ops')

const router = express.Router()
const round = (v) => Math.round(Number(v) || 0)
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
const minutes = (a, b) => Math.max(0, Math.round((new Date(b || Date.now()) - new Date(a)) / 60000))
const VAULT_TYPES = { deposito: 'Depósitos', retiro: 'Retiros', cierre_caja: 'Cierres de caja', base_caja: 'Bases de caja', consignacion: 'Consignaciones al banco', ajuste: 'Ajustes', ingreso: 'Ingresos de dinero', gasto: 'Gastos pagados con fondos', traslado: 'Traslados', retiro_socio: 'Retiros de socios', anulacion: 'Anulaciones' }

// Hora (0-12) en que empieza la jornada. Si la columna aún no existe, 6 a. m.
const cutoffHour = async () => {
  const { data } = await supabase.from('app_settings').select('*').maybeSingle()
  const hour = Number(data?.day_cutoff_hour ?? 6)
  return Number.isInteger(hour) && hour >= 0 && hour <= 12 ? hour : 6
}
// Inicio de la jornada `day` (YYYY-MM-DD) en Colombia (UTC-5, sin horario de verano).
const jornadaStart = (day, hour) => new Date(new Date(`${day}T00:00:00-05:00`).getTime() + hour * 3600000).toISOString()
// La jornada en curso: la fecha de Colombia de hace `hour` horas.
const jornadaToday = (hour) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(Date.now() - hour * 3600000))

const all = async (build) => {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw error
    out.push(...data)
    if (data.length < 1000) return out
  }
}

const buildCuadre = async ({ day, siteId, hour }) => {
  if (hour === undefined) hour = await cutoffHour()
  const start = jornadaStart(day, hour)
  const end = new Date(new Date(start).getTime() + 86400000).toISOString()
  const bySite = (q) => (siteId ? q.eq('site_id', siteId) : q)
  const EXP_COLS = 'id, number, category, description, supplier, amount, source, session_id, created_at'
  const [sessions, looseExpenses, vaults, sites] = await Promise.all([
    // Turnos de la jornada: los que se abrieron entre el inicio de la jornada y el inicio de la siguiente.
    all(() => bySite(supabase.from('cash_sessions').select('*, register:cash_registers(name), site:sites(name), opener:users!cash_sessions_opened_by_fkey(name, last_name), closer:users!cash_sessions_closed_by_fkey(name, last_name)')
      .gte('opened_at', start).lt('opened_at', end)).order('opened_at')),
    // Gastos que no son de un turno (pagados con fondos u otros) registrados durante la jornada.
    all(() => bySite(supabase.from('expenses').select(EXP_COLS).eq('status', 'activo').is('session_id', null).gte('created_at', start).lt('created_at', end)).order('created_at')),
    supabase.from('vaults').select('id, site_id, kind, name, balance').then((r) => r.data || []),
    supabase.from('sites').select('id, name').then((r) => r.data || [])
  ])
  const ids = sessions.map((s) => s.id)
  // Pedidos cobrados y gastos de los turnos de la jornada, sin importar a qué hora pasaron.
  const [orders, sessionExpenses] = ids.length ? await Promise.all([
    all(() => supabase.from('orders').select('id, number, gross, courtesy_total, subtotal, discount_total, tip, total, session_id, closed_at').eq('status', 'cobrado').in('session_id', ids).order('closed_at')),
    all(() => supabase.from('expenses').select(EXP_COLS).eq('status', 'activo').in('session_id', ids).order('created_at'))
  ]) : [[], []]
  const expenses = [...looseExpenses, ...sessionExpenses].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const [moves, payouts, credit] = ids.length ? await Promise.all([
    all(() => supabase.from('cash_movements').select('session_id, type, method, amount, created_at').in('session_id', ids)),
    all(() => supabase.from('tip_payouts').select('session_id, amount').in('session_id', ids)),
    // Lo cobrado "a cuenta por cobrar" no mueve dinero en la caja, pero es parte de lo vendido en el turno.
    all(() => supabase.from('order_payments').select('session_id, amount').in('session_id', ids).eq('method', 'cuenta_por_cobrar'))
  ]) : [[], [], []]
  const siteName = (id) => (id ? sites.find((x) => x.id === id)?.name ?? null : 'General')

  // ---------- Turnos
  const methodTotals = {}
  const shiftRows = sessions.map((s) => {
    const m = moves.filter((x) => x.session_id === s.id)
    const sum = (t) => m.filter((x) => x.type === t).reduce((a, x) => a + Number(x.amount), 0)
    const byMethod = {}
    for (const x of m.filter((y) => y.type === 'venta' || y.type === 'abono')) byMethod[x.method] = (byMethod[x.method] || 0) + Number(x.amount)
    const cxc = credit.filter((x) => x.session_id === s.id).reduce((a, x) => a + Number(x.amount), 0)
    if (cxc) byMethod.cuenta_por_cobrar = (byMethod.cuenta_por_cobrar || 0) + cxc
    for (const [k, v] of Object.entries(byMethod)) methodTotals[k] = (methodTotals[k] || 0) + v
    const os = orders.filter((o) => o.session_id === s.id)
    const open = s.status === 'abierta'
    const cashNow = m.filter((x) => x.method === 'efectivo').reduce((a, x) => a + Number(x.amount), 0)
    return {
      id: s.id, number: s.number, status: s.status, register: s.register?.name ?? null, site: s.site?.name ?? null,
      openedAt: s.opened_at, closedAt: s.closed_at, openedBy: fullName(s.opener), closedBy: fullName(s.closer), minutes: minutes(s.opened_at, s.closed_at),
      opening: round(s.opening_amount), sales: round(sum('venta') + cxc), credit: round(cxc), receivablePayments: round(sum('abono')),
      byMethod: Object.entries(byMethod).map(([method, amount]) => ({ method, label: PAY_METHODS[method] || method, amount: round(amount) })).sort((a, b) => b.amount - a.amount),
      cashSales: round(byMethod.efectivo || 0), income: round(sum('ingreso')), expenses: round(-sum('egreso')),
      tips: round(os.reduce((a, o) => a + Number(o.tip), 0)), tipsPaid: round(payouts.filter((t) => t.session_id === s.id).reduce((a, t) => a + Number(t.amount), 0)),
      couriersPaid: round(-sum('domicilio_pagado')), orders: os.length,
      expected: open ? round(cashNow) : round(s.expected_cash), counted: open ? null : round(s.counted_cash), difference: open ? null : round(s.difference),
      toVault: round(s.to_vault), nextFloat: round(s.next_float), reopened: Number(s.reopen_count || 0), closeNote: s.close_note
    }
  })
  const tot = (k) => shiftRows.reduce((a, r) => a + (Number(r[k]) || 0), 0)

  // ---------- Lo vendido (pedidos cobrados en los turnos de la jornada)
  const o = (k) => round(orders.reduce((a, x) => a + Number(x[k]), 0))
  const sold = { orders: orders.length, gross: o('gross'), courtesies: o('courtesy_total'), discounts: o('discount_total'), net: o('total') - o('tip'), tips: o('tip'), charged: o('total') }

  // ---------- Gastos del día
  const expBy = { caja: 0, fondo: 0, otro: 0 }
  for (const e of expenses) expBy[e.source === 'caja' ? 'caja' : e.source === 'fondo' ? 'fondo' : 'otro'] += Number(e.amount)

  // ---------- Caja general: saldo al empezar y al terminar el día (saldo actual menos lo que pasó después).
  const vs = vaults.filter((v) => !siteId || v.site_id === siteId || (v.site_id === null && v.kind === 'principal'))
  const vIds = vs.map((v) => v.id)
  const vmoves = vIds.length ? await all(() => supabase.from('vault_movements').select('vault_id, type, amount, created_at, session_id').in('vault_id', vIds).gte('created_at', start)) : []
  const fundRows = vs.map((v) => {
    const mv = vmoves.filter((x) => x.vault_id === v.id)
    const after = (t) => mv.filter((x) => new Date(x.created_at) >= new Date(t)).reduce((a, x) => a + Number(x.amount), 0)
    const inDay = mv.filter((x) => new Date(x.created_at) < new Date(end))
    const byType = {}
    for (const x of inDay) byType[x.type] = (byType[x.type] || 0) + Number(x.amount)
    return {
      id: v.id, name: v.kind === 'subcuenta' ? v.name : v.site_id ? `Fondo ${siteName(v.site_id)}` : 'Fondo general', kind: v.kind,
      start: round(Number(v.balance) - after(start)), end: round(Number(v.balance) - after(end)), now: round(v.balance),
      movements: Object.entries(byType).map(([type, amount]) => ({ type, label: VAULT_TYPES[type] || type, amount: round(amount) })).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    }
  }).filter((f) => f.start || f.end || f.movements.length)
  // Cierres de los turnos de la jornada, aunque el turno haya cerrado después de que empezó la jornada siguiente.
  const vaultClosings = round(vmoves.filter((x) => x.type === 'cierre_caja' && ids.includes(x.session_id)).reduce((a, x) => a + Number(x.amount), 0))

  // ---------- Verificaciones
  const shiftSales = tot('sales')
  const closed = shiftRows.filter((r) => r.status === 'cerrada')
  const diff = closed.reduce((a, r) => a + r.difference, 0)
  const toVault = closed.reduce((a, r) => a + r.toVault, 0)
  const checks = [
    {
      key: 'ventas', ok: Math.abs(shiftSales - sold.charged) < 1, title: 'Cobros en caja vs. pedidos cobrados',
      detail: `Las cajas registran ${round(shiftSales)} en cobros y los pedidos cobrados en esos turnos suman ${sold.charged}.`,
      hint: Math.abs(shiftSales - sold.charged) < 1 ? null : 'Revisa los pedidos cobrados a cuenta por cobrar o divididos entre varias personas, y los cobros que se hicieron en un turno distinto al del pedido.',
      a: round(shiftSales), b: sold.charged
    },
    {
      key: 'arqueo', ok: diff === 0, title: 'Efectivo contado vs. esperado',
      detail: !closed.length ? 'Aún no se ha cerrado ningún turno del día.' : diff === 0 ? 'Todos los turnos cerrados cuadraron exacto.' : diff > 0 ? `Sobran ${diff} en los arqueos.` : `Faltan ${-diff} en los arqueos.`,
      a: round(closed.reduce((a, r) => a + r.counted, 0)), b: round(closed.reduce((a, r) => a + r.expected, 0)), pending: !closed.length
    },
    {
      key: 'boveda', ok: Math.abs(toVault - vaultClosings) < 1, title: 'Cierres que llegaron a la bóveda',
      detail: `Los cierres enviaron ${toVault} a la bóveda y la bóveda recibió ${vaultClosings}.`, a: toVault, b: vaultClosings
    },
    {
      key: 'propinas', ok: tot('tipsPaid') <= tot('tips') + 1, title: 'Propinas pagadas vs. propinas de la jornada',
      detail: `Los clientes dejaron ${tot('tips')} de propina en estos turnos y se pagaron ${tot('tipsPaid')} al personal.`,
      hint: tot('tipsPaid') <= tot('tips') + 1 ? null : 'Se pagaron más propinas de las que entraron: puede ser un pago de propinas acumuladas de otras jornadas.', a: tot('tipsPaid'), b: tot('tips')
    }
  ]

  return {
    day, today: jornadaToday(hour), jornada: { from: start, to: end, cutoffHour: hour }, site: siteId ? siteName(siteId) : null, generatedAt: new Date().toISOString(),
    totals: {
      shifts: shiftRows.length, openShifts: shiftRows.filter((r) => r.status === 'abierta').length, minutes: tot('minutes'),
      opening: tot('opening'), sales: round(shiftSales), cashSales: tot('cashSales'), income: tot('income'), shiftExpenses: tot('expenses'),
      tips: tot('tips'), tipsPaid: tot('tipsPaid'), expected: tot('expected'), counted: closed.reduce((a, r) => a + r.counted, 0), difference: diff,
      toVault: tot('toVault'), nextFloat: tot('nextFloat'),
      expenses: round(expBy.caja + expBy.fondo + expBy.otro), expensesCash: round(expBy.caja), expensesFunds: round(expBy.fondo), expensesOther: round(expBy.otro)
    },
    byMethod: Object.entries(methodTotals).map(([method, amount]) => ({ method, label: PAY_METHODS[method] || method, amount: round(amount) })).sort((a, b) => b.amount - a.amount),
    sold, shifts: shiftRows, funds: fundRows,
    expenses: expenses.map((e) => ({ id: e.id, number: e.number, description: e.description, supplier: e.supplier, amount: round(e.amount), source: e.source, createdAt: e.created_at })),
    checks, balanced: checks.every((c) => c.ok || c.pending)
  }
}

router.get('/reportes/cuadre', auth(ADMIN), h(async (req, res) => {
  const hour = await cutoffHour()
  const today = jornadaToday(hour)
  const day = isDay(req.query.fecha) ? req.query.fecha : today
  if (day > today) return fail(res, 'Elige una jornada que ya haya empezado', 400)
  res.send(await buildCuadre({ day, siteId: req.siteId || null, hour }))
}))

module.exports = router
module.exports.buildCuadre = buildCuadre
module.exports.jornadaStart = jornadaStart
module.exports.jornadaToday = jornadaToday
