// =====================================================================
// Domicilios (TD-008): domiciliario asignado, estado de la entrega, ruta, totales y su cuenta.
// · Domiciliario: ve solo sus domicilios, marca "en camino" y "entregado", y ve lo que ha ganado y lo que le pagaron.
// · Mesero, cajero, anfitrión y administrador: ven todos los domicilios de la sucursal y asignan el domiciliario.
// · Al domiciliario le toca todo el valor del domicilio o un % (Configuración), más las propinas de sus entregas.
//   Se le paga en el cierre de la caja (courier_payouts).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, todayBogota } = require('../http')
const { auth, STAFF } = require('../auth')
const { audit } = require('../audit')
const { can, guard, workSite, sameSite, fullName, PAY_METHODS, money, isMoney, itemsBlock } = require('../ops')
const { dayStart } = require('./logbook')
const { notify, cashReceivedMessage } = require('../notify')
const bcrypt = require('bcryptjs')
const { NAME_RE, PHONE_RE, DOC_RE } = require('../http')
const plan = require('../plan')
const { COURIER_COLUMNS, courierFrom, vehicleLabel } = require('../courier')

const router = express.Router()

const SELLERS = ['mesero', 'cajero', 'host', 'bartender', 'barista']
const STATUS = { por_despachar: 'Por despachar', en_camino: 'En camino', entregado: 'Entregado' }
const DAY = /^\d{4}-\d{2}-\d{2}$/
const nextDay = (d) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + 864e5).toISOString()
const round = (v) => Math.round(Number(v) || 0)
const num = (v) => (v === null || v === undefined ? null : Number(v))
// Lo que debe pagar el cliente si el domicilio vale `fee` (el total ya trae el valor del domicilio con que se abrió).
const dueWith = (o, fee) => round(Number(o.total) - Number(o.delivery_fee || 0) + fee)

// Qué parte del valor del domicilio le toca al domiciliario.
const shareRule = async () => {
  const { data } = await supabase.from('app_settings').select('courier_share_mode, courier_share_percent, delivery_transfer_timing').maybeSingle()
  const mode = data?.courier_share_mode === 'porcentaje' ? 'porcentaje' : 'todo'
  const percent = mode === 'todo' ? 100 : Number(data?.courier_share_percent ?? 100)
  return { mode, percent, timing: data?.delivery_transfer_timing === 'al_entregar' ? 'al_entregar' : 'antes', of: (fee) => round((Number(fee) || 0) * percent / 100) }
}
// Domiciliario que se paga por jornada como empleado (TD-021): el valor de sus domicilios queda para el negocio.
const byShift = (u) => u?.courier_pay === 'jornada'
// El empleado que solo es domiciliario ve únicamente lo suyo.
const onlyCourier = (user) => !can(user, ...SELLERS)

const MIN_TRIP_MS = 60e3
// Sin forma de pago elegida, el domicilio se paga en efectivo al domiciliario (igual que en la base de cambio).
const paysCash = (o) => !o.delivery_pay_method || o.delivery_pay_method === 'efectivo'
const isCourierUser = (user) => (user.positions || []).includes('domiciliario') && user.role === 'empleado'
const FLOW = { por_despachar: ['en_camino'], en_camino: ['entregado', 'por_despachar'], entregado: ['en_camino'] }
const COLUMNS = 'id, number, site_id, status, type, customer_name, customer_phone, customer_address, note, delivery_pay_method, delivery_cash_with, total, tip, delivery_fee, paid, opened_at, closed_at, session_id, courier_id, delivery_status, dispatched_at, arrived_at, cash_received_at, cash_received_amount, cash_received_fee, courier:users!orders_courier_id_fkey(id, name, last_name, courier_pay, courier_external, vehicle_type, vehicle_has_plate, vehicle_plate), customer:customers(id, zone), items:order_items(name, quantity, status, area)'
const deliveryDTO = (o, rule) => ({
  id: o.id, number: o.number, siteId: o.site_id, status: o.status, customerName: o.customer_name, customerPhone: o.customer_phone, address: o.customer_address, note: o.note, customerId: o.customer?.id ?? null, zone: o.customer?.zone ?? null,
  payMethod: o.delivery_pay_method || null, cashWith: o.delivery_cash_with === null ? null : Number(o.delivery_cash_with),
  change: o.delivery_cash_with !== null && o.delivery_pay_method === 'efectivo' ? Math.max(0, Number(o.delivery_cash_with) - Number(o.total)) : null,
  mustPayFirst: Boolean(o.delivery_pay_method && o.delivery_pay_method !== 'efectivo' && o.status === 'abierto' && rule.timing === 'antes'),
  total: Number(o.total), tip: Number(o.tip), deliveryFee: Number(o.delivery_fee || 0), share: byShift(o.courier) ? 0 : rule.of(o.delivery_fee), paid: o.status === 'cobrado',
  courier: o.courier ? { id: o.courier.id, name: fullName(o.courier), external: Boolean(o.courier.courier_external), vehicle: vehicleLabel(o.courier) } : null, deliveryStatus: o.delivery_status || 'por_despachar', deliveryStatusLabel: STATUS[o.delivery_status || 'por_despachar'],
  openedAt: o.opened_at, closedAt: o.closed_at, dispatchedAt: o.dispatched_at, arrivedAt: o.arrived_at,
  // TD-015: efectivo que el domiciliario dice haber recibido (falta cobrarlo en caja mientras el pedido siga abierto).
  cashPay: paysCash(o), cashReceivedAt: o.cash_received_at || null, cashReceivedAmount: num(o.cash_received_amount), cashReceivedFee: num(o.cash_received_fee),
  minutes: o.dispatched_at && o.arrived_at ? Math.max(0, Math.round((new Date(o.arrived_at) - new Date(o.dispatched_at)) / 60000)) : null,
  items: (o.items || []).filter((i) => i.status !== 'anulado').map((i) => ({ name: i.name, quantity: Number(i.quantity) })),
  // Por qué todavía no puede salir (sin productos o comandas sin entregar); null si ya puede.
  dispatchBlock: (o.delivery_status || 'por_despachar') === 'por_despachar' ? itemsBlock(o.number, o.items) : null
})
// Totales de un grupo de domicilios: lo que se cobró de domicilio, lo que le toca y las propinas.
const totals = (list) => {
  const charged = list.filter((d) => d.paid)
  const share = charged.reduce((a, d) => a + d.share, 0)
  const tips = charged.reduce((a, d) => a + d.tip, 0)
  return {
    deliveries: list.length, delivered: list.filter((d) => d.deliveryStatus === 'entregado').length, onTheWay: list.filter((d) => d.deliveryStatus === 'en_camino').length,
    pending: list.filter((d) => d.deliveryStatus === 'por_despachar').length, fees: charged.reduce((a, d) => a + d.deliveryFee, 0), share, tips, earned: share + tips,
    toCollect: list.filter((d) => !d.paid && d.status === 'abierto').reduce((a, d) => a + d.total, 0), sales: charged.reduce((a, d) => a + d.total - d.tip, 0)
  }
}
// TD-022: si es externo, si trabaja con base propia y su vehículo.
const courierRow = (u) => ({ id: u.id, name: fullName(u), phone: u.phone || null, external: Boolean(u.courier_external), ownFloat: u.courier_float === 'propia', vehicle: vehicleLabel(u) })
const couriersOf = async (siteId) => {
  const { data } = await supabase.from('users').select(`id, name, last_name, site_id, phone, ${COURIER_COLUMNS}`).eq('active', true).eq('role', 'empleado').contains('positions', ['domiciliario']).order('name')
  return (data || []).filter((u) => !siteId || !u.site_id || u.site_id === siteId).map(courierRow)
}

// ---------------------------------------------------------------- Lista del día
router.get('/domicilios', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const day = DAY.test(req.query.dia || '') ? req.query.dia : todayBogota()
  const today = day === todayBogota()
  const site = await workSite(req, req.query.sede)
  const mine = onlyCourier(req.user)
  const courierId = mine ? req.user.id : Number(req.query.domiciliario) || null
  let q = supabase.from('orders').select(COLUMNS).eq('type', 'domicilio').eq('site_id', site).neq('status', 'anulado')
  // Hoy: los abiertos (aunque vengan de ayer) y los del día. Otro día: los que se abrieron ese día.
  q = today ? q.or(`status.eq.abierto,opened_at.gte.${dayStart(day)}`) : q.gte('opened_at', dayStart(day)).lt('opened_at', nextDay(day))
  if (courierId) q = q.eq('courier_id', courierId)
  const [{ data, error }, rule, couriers, settings] = await Promise.all([
    q.order('opened_at', { ascending: false }), shareRule(), mine ? [] : couriersOf(site),
    supabase.from('app_settings').select('business_name').maybeSingle()
  ])
  if (error) throw error
  const { data: siteRow } = await supabase.from('sites').select('name, address, city').eq('id', site).maybeSingle()
  const list = (data || []).map((o) => deliveryDTO(o, rule))
  const byCourier = mine ? [] : [...couriers, { id: null, name: 'Sin asignar' }].map((c) => ({ ...c, ...totals(list.filter((d) => (d.courier?.id ?? null) === c.id)) })).filter((c) => c.id || c.deliveries)
  res.send({
    day, today, mine, rule: { mode: rule.mode, percent: rule.percent, timing: rule.timing }, origin: { name: siteRow?.name || settings.data?.business_name || '', address: siteRow?.address || '', city: siteRow?.city || '' },
    totals: totals(list), couriers, byCourier, deliveries: list
  })
}))

// ---------------------------------------------------------------- Asignar y cambiar estado
const loadDelivery = async (req, res) => {
  const { data: o } = await supabase.from('orders').select('id, number, site_id, type, status, total, delivery_fee, customer_name, customer_address, courier_id, delivery_status, dispatched_at, delivery_pay_method, cash_received_at').eq('id', Number(req.params.id)).maybeSingle()
  if (!o || o.type !== 'domicilio') { fail(res, 'Domicilio no encontrado', 404); return null }
  if (!sameSite(req, o.site_id)) { fail(res, 'El domicilio es de otra sucursal', 403); return null }
  if (o.status === 'anulado') { fail(res, 'El pedido está anulado', 409); return null }
  return o
}

router.post('/domicilios/:id/asignar', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const o = await loadDelivery(req, res)
  if (!o) return
  const courierId = Number(req.body?.courierId) || null
  // TD-012: el domiciliario no se quita, y después de que sale ya no se cambia.
  // Sí se puede asignar a un domicilio viejo que quedó sin domiciliario.
  if (!courierId) return fail(res, o.courier_id ? 'El domiciliario no se puede quitar; si hace falta, cámbialo por otro antes de que salga.' : 'Elige un domiciliario', 400)
  if (o.courier_id && o.courier_id !== courierId && (o.delivery_status || 'por_despachar') !== 'por_despachar') return fail(res, `El ${o.number} ya salió con su domiciliario; no se puede cambiar.`, 409)
  if (courierId) {
    const { data: u } = await supabase.from('users').select('id, active, positions').eq('id', courierId).maybeSingle()
    if (!u || !u.active || !(u.positions || []).includes('domiciliario')) return fail(res, 'Elige un domiciliario activo', 400)
  }
  const { error } = await supabase.from('orders').update({ courier_id: courierId }).eq('id', o.id)
  if (error) throw error
  await audit(req, 'asignar_domiciliario', 'pedido', o.id, { number: o.number, from: o.courier_id, to: courierId })
  res.send({ ok: true })
}))

// Ciclo del domicilio (TD-012): Por despachar → En camino → Entregado, sin saltarse pasos.
// · Sale solo si tiene productos, si las comandas ya lo entregaron y si tiene domiciliario.
// · "Entregado" lo marca solo el domiciliario asignado, y no en el mismo momento en que sale.
router.post('/domicilios/:id/estado', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const o = await loadDelivery(req, res)
  if (!o) return
  const status = req.body?.status
  if (!STATUS[status]) return fail(res, 'Estado no válido', 400)
  const current = o.delivery_status || 'por_despachar'
  if (status === current) return fail(res, `El ${o.number} ya está ${STATUS[status].toLowerCase()}`, 409)
  if (!FLOW[current].includes(status)) {
    return fail(res, status === 'entregado' ? `El ${o.number} todavía no ha salido. Primero marca "Salí con el pedido".` : 'Ese cambio de estado no es válido', 409)
  }
  const isCourier = (req.user.positions || []).includes('domiciliario') && req.user.role === 'empleado'
  const mine = onlyCourier(req.user)
  // TD-022: el domiciliario externo puede no usar la app; sus entregas también las marca el personal.
  const { data: assigned } = o.courier_id ? await supabase.from('users').select('courier_external').eq('id', o.courier_id).maybeSingle() : { data: null }
  const staffDelivers = Boolean(assigned?.courier_external) && !mine
  if (mine && o.courier_id && o.courier_id !== req.user.id) return fail(res, 'Este domicilio lo tiene otro domiciliario', 403)
  // Entregarlo (o deshacer la entrega) es solo del domiciliario asignado.
  if ((status === 'entregado' || current === 'entregado') && !(isCourier && o.courier_id === req.user.id) && !staffDelivers) {
    return fail(res, o.courier_id ? 'Solo el domiciliario asignado puede marcarlo entregado.' : 'El domicilio no tiene domiciliario asignado.', 403)
  }
  if (status === 'en_camino' && current === 'por_despachar') {
    // Con otro medio de pago y "se cobra antes de enviar", el pedido no sale sin estar pagado.
    if (o.status === 'abierto' && o.delivery_pay_method && o.delivery_pay_method !== 'efectivo' && (await shareRule()).timing === 'antes') {
      return fail(res, `El ${o.number} se paga por ${(PAY_METHODS[o.delivery_pay_method] || o.delivery_pay_method).toLowerCase()} antes de enviarlo. Cóbralo en caja y luego despáchalo.`, 409)
    }
    if (!o.courier_id && !isCourier) return fail(res, `Asígnale un domiciliario al ${o.number} antes de despacharlo.`, 409)
    const { data: items } = await supabase.from('order_items').select('status, area').eq('order_id', o.id)
    const block = itemsBlock(o.number, items)
    if (block) return fail(res, block, 409)
  }
  if (status === 'entregado' && !staffDelivers && o.dispatched_at && Date.now() - new Date(o.dispatched_at).getTime() < MIN_TRIP_MS) {
    return fail(res, `El ${o.number} acaba de salir. Márcalo entregado cuando llegues donde el cliente.`, 409)
  }
  const patch = { delivery_status: status }
  // El domiciliario que sale con un domicilio sin asignar lo toma.
  if (isCourier && !o.courier_id) patch.courier_id = req.user.id
  const now = new Date().toISOString()
  if (status === 'por_despachar') { patch.dispatched_at = null; patch.arrived_at = null }
  if (status === 'en_camino') { if (current === 'por_despachar') patch.dispatched_at = now; patch.arrived_at = null }
  if (status === 'entregado') patch.arrived_at = now
  // Si deshace la entrega, también se borra el aviso de dinero recibido.
  if (current === 'entregado' && o.cash_received_at) { patch.cash_received_at = null; patch.cash_received_amount = null; patch.cash_received_fee = null }
  const { error } = await supabase.from('orders').update(patch).eq('id', o.id)
  if (error) throw error
  await audit(req, 'domicilio_' + status, 'pedido', o.id, { number: o.number, from: current })
  res.send({ ok: true })
}))

// ---------------------------------------------------------------- Dinero recibido (TD-015)
// El cliente le pagó en efectivo al domiciliario: él lo marca y al personal le sale un aviso con sonido
// (y por Telegram, sección Domicilios) para cobrarlo en caja. Si iba en camino, queda entregado de una vez.
router.post('/domicilios/:id/dinero-recibido', auth(STAFF), guard('domiciliario'), h(async (req, res) => {
  const o = await loadDelivery(req, res)
  if (!o) return
  if (!isCourierUser(req.user) || o.courier_id !== req.user.id) return fail(res, 'Solo el domiciliario asignado puede avisar que recibió el dinero.', 403)
  if (!paysCash(o)) return fail(res, `El ${o.number} no se paga en efectivo.`, 409)
  if (o.status !== 'abierto') return fail(res, `El ${o.number} ya está cobrado en caja.`, 409)
  if (o.cash_received_at) return fail(res, `Ya avisaste que recibiste el dinero del ${o.number}.`, 409)
  const current = o.delivery_status || 'por_despachar'
  if (current === 'por_despachar') return fail(res, `El ${o.number} todavía no ha salido. Primero marca "Salí con el pedido".`, 409)
  if (current === 'en_camino' && o.dispatched_at && Date.now() - new Date(o.dispatched_at).getTime() < MIN_TRIP_MS) {
    return fail(res, `El ${o.number} acaba de salir. Avisa cuando el cliente te pague.`, 409)
  }
  // El domiciliario registra el valor del domicilio y con cuánto pagó el cliente; al cobrar en caja se precargan.
  const b = req.body || {}
  const fee = b.deliveryFee === undefined || b.deliveryFee === null || b.deliveryFee === '' ? round(o.delivery_fee) : (isMoney(b.deliveryFee) ? money(b.deliveryFee) : NaN)
  if (!(fee >= 0)) return fail(res, 'Escribe el valor del domicilio (0 si no se cobra).', 400)
  const due = dueWith(o, fee)
  const received = b.received === undefined || b.received === null || b.received === '' ? due : (isMoney(b.received) ? money(b.received) : NaN)
  if (!(received >= 0)) return fail(res, 'Escribe cuánto dinero te dio el cliente.', 400)
  if (received < due) return fail(res, `El cliente debe pagar ${due.toLocaleString('es-CO')}; te dio ${received.toLocaleString('es-CO')}.`, 400)
  const change = received - due
  const now = new Date().toISOString()
  const patch = { cash_received_at: now, cash_received_amount: received, cash_received_fee: fee }
  if (current === 'en_camino') { patch.delivery_status = 'entregado'; patch.arrived_at = now }
  // Solo si sigue abierto y sin aviso: evita doble aviso con dos toques seguidos.
  const { data: upd, error } = await supabase.from('orders').update(patch).eq('id', o.id).eq('status', 'abierto').is('cash_received_at', null).select('id')
  if (error) throw error
  if (!upd?.length) return fail(res, `El ${o.number} cambió mientras tanto. Actualiza la pantalla.`, 409)
  if (current === 'en_camino') await audit(req, 'domicilio_entregado', 'pedido', o.id, { number: o.number, from: current })
  await audit(req, 'domicilio_dinero_recibido', 'pedido', o.id, { number: o.number, fee, due, received, change })
  notify('domicilios', async () => {
    const { data: s } = await supabase.from('sites').select('name').eq('id', o.site_id).maybeSingle()
    return cashReceivedMessage({ order: o, amount: due, fee, received, change, courier: req.user, site: s?.name, siteId: o.site_id })
  })
  res.send({ ok: true, delivered: current === 'en_camino', fee, due, received, change })
}))

router.post('/domicilios/:id/dinero-recibido/deshacer', auth(STAFF), guard('domiciliario'), h(async (req, res) => {
  const o = await loadDelivery(req, res)
  if (!o) return
  if (!isCourierUser(req.user) || o.courier_id !== req.user.id) return fail(res, 'Solo el domiciliario asignado puede deshacerlo.', 403)
  if (!o.cash_received_at) return fail(res, `No has avisado dinero recibido del ${o.number}.`, 409)
  if (o.status !== 'abierto') return fail(res, `El ${o.number} ya se cobró en caja; no se puede deshacer.`, 409)
  const { error } = await supabase.from('orders').update({ cash_received_at: null, cash_received_amount: null, cash_received_fee: null }).eq('id', o.id).eq('status', 'abierto')
  if (error) throw error
  await audit(req, 'domicilio_dinero_recibido_deshecho', 'pedido', o.id, { number: o.number })
  res.send({ ok: true })
}))

// Valor del domicilio, lo que debe pagar el cliente, lo que dio y el cambio, según lo que registró el domiciliario.
const cashFigures = (o) => {
  const fee = o.cash_received_fee === null || o.cash_received_fee === undefined ? round(o.delivery_fee) : round(o.cash_received_fee)
  const amount = dueWith(o, fee)
  const received = o.cash_received_amount === null || o.cash_received_amount === undefined ? amount : round(o.cash_received_amount)
  return { fee, amount, received, change: Math.max(0, received - amount) }
}

// Avisos para el personal (no domiciliarios): domicilios con dinero recibido que aún no se cobran en caja.
router.get('/domicilios/avisos', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const { data, error } = await supabase.from('orders').select('id, number, total, delivery_fee, customer_name, customer_address, cash_received_at, cash_received_amount, cash_received_fee, courier:users!orders_courier_id_fkey(id, name, last_name)')
    .eq('type', 'domicilio').eq('site_id', site).eq('status', 'abierto').not('cash_received_at', 'is', null).order('cash_received_at')
  if (error) throw error
  res.send((data || []).map((o) => ({
    ...cashFigures(o), id: o.id, number: o.number, total: Number(o.total), customerName: o.customer_name, address: o.customer_address,
    courier: o.courier ? { id: o.courier.id, name: fullName(o.courier) } : null, receivedAt: o.cash_received_at
  })))
}))

// ---------------------------------------------------------------- Registro rápido de domiciliario externo (TD-022)
// Para el que no trabaja para la empresa: nombre, celular y vehículo. Trabaja con base propia y queda en la sucursal.
// Entra con el usuario que se le genera y su identificación (o su celular) como contraseña, si quiere usar la app.
const slug = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')
const freeUsername = async (name, phone) => {
  const base = `dom.${slug(name).slice(0, 18) || 'externo'}`
  for (const cand of [base, `${base}${String(phone).slice(-4)}`, ...[2, 3, 4, 5].map((n) => `${base}${String(phone).slice(-4)}${n}`)]) {
    const { data } = await supabase.from('users').select('id').eq('username', cand).limit(1)
    if (!(data || []).length) return cand
  }
  return `${base}${Date.now().toString(36)}`
}
const quickCourierErrors = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('Escribe el nombre')
  else if (!NAME_RE.test(clean(b.name))) errors.push('El nombre solo admite letras')
  if (clean(b.lastName) && !NAME_RE.test(clean(b.lastName))) errors.push('Los apellidos solo admiten letras')
  if (!clean(b.phone)) errors.push('Escribe el celular')
  else if (!PHONE_RE.test(clean(b.phone))) errors.push('Celular no válido (7 a 10 dígitos)')
  if (clean(b.identification) && !DOC_RE.test(clean(b.identification))) errors.push('Identificación no válida')
  return errors
}
router.post('/domicilios/domiciliarios', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const b = req.body || {}
  const errors = quickCourierErrors(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const courier = courierFrom({ ...b, courierFloat: b.courierFloat || 'propia' }, { external: true })
  const site = await workSite(req, b.siteId)
  const phone = clean(b.phone)
  const identification = clean(b.identification) || phone
  const { data: same } = await supabase.from('users').select('id, name, last_name, active, positions').eq('identification', identification).maybeSingle()
  if (same) return fail(res, `Ya existe ${fullName(same)} con ${clean(b.identification) ? 'esa identificación' : 'ese celular como identificación'}${(same.positions || []).includes('domiciliario') ? (same.active ? '. Búscalo en la lista de domiciliarios.' : '; está inactivo, actívalo en Usuarios.') : '.'}`, 409)
  await plan.checkLimit(req.user.org_id, 'employees')
  const username = await freeUsername(b.name, phone)
  const { data, error } = await supabase.from('users').insert({
    identification, name: clean(b.name), last_name: clean(b.lastName) || '', username, phone, email: null,
    role: 'empleado', extra_roles: [], positions: ['domiciliario'], site_id: site, active: true,
    password_hash: await bcrypt.hash(identification, 10), courier_pay: 'domicilios', ...courier
  }).select(`id, name, last_name, site_id, phone, ${COURIER_COLUMNS}`).single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un usuario con esa identificación', 409) : fail(res, error)
  await audit(req, 'registro_rapido_domiciliario', 'usuario', data.id, { username, external: true, vehicle: vehicleLabel(data) })
  // Si viene de un domicilio, queda asignado de una vez (mismas reglas de "asignar").
  let assigned = null
  if (Number(b.orderId)) {
    const { data: o } = await supabase.from('orders').select('id, number, site_id, type, status, courier_id, delivery_status').eq('id', Number(b.orderId)).maybeSingle()
    if (o && o.type === 'domicilio' && o.status !== 'anulado' && sameSite(req, o.site_id) && (!o.courier_id || (o.delivery_status || 'por_despachar') === 'por_despachar')) {
      const { error: e2 } = await supabase.from('orders').update({ courier_id: data.id }).eq('id', o.id)
      if (!e2) { assigned = o.number; await audit(req, 'asignar_domiciliario', 'pedido', o.id, { number: o.number, from: o.courier_id, to: data.id }) }
    }
  }
  res.status(201).send({ ...courierRow(data), username, password: clean(b.identification) ? 'su identificación' : 'su celular', assigned })
}))

// ---------------------------------------------------------------- Cuenta del domiciliario
// Por día: domicilios, valor de domicilios, lo que le toca y propinas. Más lo que le han pagado en los cierres
// y lo que tiene pendiente (pedidos cobrados en turnos que aún no se cierran).
router.get('/domicilios/cuenta', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const mine = onlyCourier(req.user)
  const courierId = mine ? req.user.id : Number(req.query.domiciliario)
  if (!courierId) return fail(res, 'Elige el domiciliario', 400)
  const to = DAY.test(req.query.hasta || '') ? req.query.hasta : todayBogota()
  const from = DAY.test(req.query.desde || '') ? req.query.desde : new Date(new Date(`${to}T12:00:00-05:00`).getTime() - 29 * 864e5).toISOString().slice(0, 10)
  const [{ data: orders, error }, { data: payouts }, { data: u }, rule, { data: tipPays }, { data: owed }] = await Promise.all([
    supabase.from('orders').select('id, number, status, total, tip, delivery_fee, closed_at, opened_at, session_id, delivery_status, dispatched_at, arrived_at, session:cash_sessions(status)')
      .eq('type', 'domicilio').eq('courier_id', courierId).neq('status', 'anulado').gte('opened_at', dayStart(from)).lt('opened_at', nextDay(to)).order('opened_at'),
    supabase.from('courier_payouts').select('id, amount, deliveries, fees, share, tips, created_at, session:cash_sessions(number, register:cash_registers(name))')
      .eq('user_id', courierId).gte('created_at', dayStart(from)).lt('created_at', nextDay(to)).order('created_at', { ascending: false }),
    supabase.from('users').select('id, name, last_name, site_id, courier_pay').eq('id', courierId).maybeSingle(),
    shareRule(),
    // Sus propinas se le pagan en Caja → Propinas (TD-020), no en el cierre.
    supabase.from('tip_payouts').select('amount').eq('user_id', courierId).gte('created_at', dayStart(from)).lt('created_at', nextDay(to)).then((r) => (r.error ? { data: [] } : r)),
    // Domicilios que en el cierre quedaron pendientes o se pagaron después en Pagos al personal (TD-020).
    supabase.from('staff_earnings').select('amount, status, paid_at').eq('user_id', courierId).eq('kind', 'domicilios').then((r) => (r.error ? { data: [] } : r))
  ])
  if (error) throw error
  if (!u || (!mine && !sameSite(req, u.site_id) && u.site_id)) return fail(res, 'Domiciliario no encontrado', 404)
  const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date(d))
  const days = {}
  let pending = 0
  for (const o of orders || []) {
    const k = day(o.opened_at)
    const d = (days[k] = days[k] || { date: k, deliveries: 0, fees: 0, share: 0, tips: 0, minutes: [] })
    d.deliveries++
    if (o.dispatched_at && o.arrived_at) d.minutes.push((new Date(o.arrived_at) - new Date(o.dispatched_at)) / 60000)
    if (o.status !== 'cobrado') continue
    const share = byShift(u) ? 0 : rule.of(o.delivery_fee)
    d.fees += Number(o.delivery_fee || 0); d.share += share; d.tips += Number(o.tip)
    if (o.session?.status === 'abierta') pending += share
  }
  const rows = Object.values(days).sort((a, b) => b.date.localeCompare(a.date)).map(({ minutes, ...d }) => ({ ...d, earned: d.share + d.tips, avgMinutes: minutes.length ? Math.round(minutes.reduce((a, x) => a + x, 0) / minutes.length) : null }))
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  const inRange = (d) => d && new Date(d) >= new Date(dayStart(from)) && new Date(d) < new Date(nextDay(to))
  const paid = (payouts || []).reduce((a, p) => a + Number(p.amount), 0) + (owed || []).filter((e) => e.status === 'pagado' && inRange(e.paid_at)).reduce((a, e) => a + Number(e.amount), 0)
  pending += (owed || []).filter((e) => e.status === 'pendiente').reduce((a, e) => a + Number(e.amount), 0)
  res.send({
    courier: { id: u.id, name: fullName(u), byShift: byShift(u) }, from, to, rule: { mode: rule.mode, percent: rule.percent },
    totals: { deliveries: sum('deliveries'), fees: sum('fees'), share: sum('share'), tips: sum('tips'), earned: sum('earned'), paid, pending, tipsPaid: (tipPays || []).reduce((a, t) => a + Number(t.amount), 0) },
    days: rows,
    payouts: (payouts || []).map((p) => ({ id: p.id, amount: Number(p.amount), deliveries: p.deliveries, fees: Number(p.fees), share: Number(p.share), tips: Number(p.tips), session: p.session?.number ?? null, register: p.session?.register?.name ?? null, createdAt: p.created_at }))
  })
}))

// ---------------------------------------------------------------- Cierre de caja: lo que le toca a cada domiciliario
// Domicilios cobrados en el turno con domiciliario asignado: su parte del valor del domicilio más las propinas.
const courierSettlement = async (sessionId) => {
  const [{ data }, rule] = await Promise.all([
    supabase.from('orders').select('id, number, tip, delivery_fee, courier_id, courier:users!orders_courier_id_fkey(id, name, last_name, courier_pay)')
      .eq('session_id', sessionId).eq('status', 'cobrado').eq('type', 'domicilio').not('courier_id', 'is', null),
    shareRule()
  ])
  const m = {}
  for (const o of data || []) {
    const c = (m[o.courier_id] = m[o.courier_id] || { userId: o.courier_id, name: fullName(o.courier), byShift: byShift(o.courier), deliveries: 0, fees: 0, share: 0, tips: 0, orders: [] })
    c.deliveries++; c.fees += Number(o.delivery_fee || 0); c.share += c.byShift ? 0 : rule.of(o.delivery_fee); c.tips += Number(o.tip); c.orders.push(o.number)
  }
  // Las propinas (tips) se muestran pero no se pagan en el cierre: van a Caja → Propinas (TD-020).
  const rows = Object.values(m).map((c) => ({ ...c, suggested: c.share })).sort((a, b) => a.name.localeCompare(b.name))
  return { rule: { mode: rule.mode, percent: rule.percent }, rows, total: rows.reduce((a, r) => a + r.suggested, 0), businessShare: rows.reduce((a, r) => a + r.fees - r.share, 0) }
}

// ---------------------------------------------------------------- Base de cambio del domiciliario
// Sale del efectivo de un turno abierto. Al liquidar, el domiciliario entrega la base más el efectivo de sus
// domicilios (los que se pagan en efectivo y se cobraron en caja después de darle la base).
const FLOAT_COLUMNS = '*, user:users!courier_floats_user_id_fkey(id, name, last_name), session:cash_sessions!courier_floats_session_id_fkey(id, number, status, register:cash_registers(name))'
const floatDTO = (f) => ({
  id: f.id, userId: f.user_id, name: fullName(f.user), amount: Number(f.amount), status: f.status, sessionId: f.session_id, session: f.session?.number ?? null,
  register: f.session?.register?.name ?? null, sessionOpen: f.session?.status === 'abierta', createdAt: f.created_at, settledAt: f.settled_at,
  ordersCash: f.orders_cash === null ? null : Number(f.orders_cash), expected: f.expected === null ? null : Number(f.expected),
  returned: f.returned === null ? null : Number(f.returned), difference: f.difference === null ? null : Number(f.difference), note: f.note, orders: f.orders || []
})
// Domicilios en efectivo del domiciliario desde que se le dio la base y que no entraron en otra liquidación.
const floatOrders = async (f) => {
  const [{ data: orders }, { data: settled }] = await Promise.all([
    supabase.from('orders').select('id, number, status, total, customer_name, customer_address, delivery_pay_method, delivery_status, opened_at, dispatched_at, closed_at, payments:order_payments(method, amount)')
      .eq('type', 'domicilio').eq('courier_id', f.user_id).in('status', ['abierto', 'cobrado']).or(`dispatched_at.gte.${f.created_at},closed_at.gte.${f.created_at},opened_at.gte.${f.created_at}`).order('opened_at'),
    supabase.from('courier_floats').select('orders').eq('user_id', f.user_id).eq('status', 'liquidada').neq('id', f.id).gte('settled_at', new Date(new Date(f.created_at).getTime() - 7 * 864e5).toISOString())
  ])
  const done = new Set((settled || []).flatMap((x) => (x.orders || []).map((o) => o.id)))
  return (orders || []).filter((o) => !done.has(o.id) && (!o.delivery_pay_method || o.delivery_pay_method === 'efectivo')).map((o) => ({
    id: o.id, number: o.number, customerName: o.customer_name, address: o.customer_address, total: Number(o.total), paid: o.status === 'cobrado', deliveryStatus: o.delivery_status,
    cash: (o.payments || []).filter((p) => p.method === 'efectivo').reduce((a, p) => a + Number(p.amount), 0),
    other: (o.payments || []).filter((p) => p.method !== 'efectivo').reduce((a, p) => a + Number(p.amount), 0)
  }))
}
const loadFloat = async (req, res) => {
  const { data: f } = await supabase.from('courier_floats').select(FLOAT_COLUMNS).eq('id', Number(req.params.id)).maybeSingle()
  if (!f) { fail(res, 'Base no encontrada', 404); return null }
  if (!sameSite(req, f.site_id)) { fail(res, 'La base es de otra sucursal', 403); return null }
  return f
}

router.get('/domicilios/bases', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const mine = onlyCourier(req.user)
  const site = await workSite(req, req.query.sede)
  let q = supabase.from('courier_floats').select(FLOAT_COLUMNS).eq('site_id', site).or(`status.eq.abierta,settled_at.gte.${dayStart(todayBogota())}`).order('created_at', { ascending: false })
  if (mine) q = q.eq('user_id', req.user.id)
  const { data, error } = await q
  if (error) throw error
  const rows = await Promise.all((data || []).map(async (f) => {
    const dto = floatDTO(f)
    if (f.status !== 'abierta') return dto
    const orders = await floatOrders(f)
    const cash = orders.filter((o) => o.paid).reduce((a, o) => a + o.cash, 0)
    const unpaid = orders.filter((o) => !o.paid).reduce((a, o) => a + o.total, 0)
    return { ...dto, ordersCash: cash, unpaid, toReturn: dto.amount + cash + unpaid, orders }
  }))
  res.send({ rows })
}))

router.post('/domicilios/bases', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const b = req.body || {}
  const site = await workSite(req, b.siteId)
  if (!isMoney(b.amount) || !(money(b.amount) > 0)) return fail(res, 'Escribe el valor de la base', 400)
  const { data: u } = await supabase.from('users').select('id, name, last_name, active, positions, courier_float').eq('id', Number(b.courierId)).maybeSingle()
  if (!u || !u.active || !(u.positions || []).includes('domiciliario')) return fail(res, 'Elige un domiciliario activo', 400)
  if (u.courier_float === 'propia') return fail(res, `${fullName(u)} trabaja con su propia base; no se le entrega base de la caja.`, 409)
  const { data: open } = await supabase.from('courier_floats').select('id').eq('user_id', u.id).eq('status', 'abierta').limit(1)
  if ((open || []).length) return fail(res, `${fullName(u)} ya tiene una base sin liquidar. Liquídala antes de darle otra.`, 409)
  const { data: sessions } = await supabase.from('cash_sessions').select('id, number, opened_by').eq('site_id', site).eq('status', 'abierta')
  const list = sessions || []
  const s = Number(b.sessionId) ? list.find((x) => x.id === Number(b.sessionId)) : list.find((x) => x.opened_by === req.user.id) || list[0]
  if (!s) return fail(res, 'No hay un turno de caja abierto para sacar la base', 409)
  const { data: cash } = await supabase.rpc('session_cash', { p_session: s.id })
  if (Number(cash || 0) < money(b.amount)) return fail(res, `En la caja hay ${Number(cash || 0).toLocaleString('es-CO')} en efectivo; no alcanza para la base`, 409)
  const { data: f, error } = await supabase.from('courier_floats').insert({ site_id: site, session_id: s.id, user_id: u.id, amount: money(b.amount), note: clean(b.note), given_by: req.user.id }).select('id').single()
  if (error) throw error
  const { error: e2 } = await supabase.from('cash_movements').insert({ session_id: s.id, type: 'base_domiciliario', method: 'efectivo', amount: -money(b.amount), ref: s.number, note: `Base de cambio para ${fullName(u)}`, user_id: req.user.id })
  if (e2) { await supabase.from('courier_floats').delete().eq('id', f.id); throw e2 }
  await audit(req, 'base_domiciliario', 'turno_caja', s.id, { courier: fullName(u), amount: money(b.amount) })
  res.status(201).send({ id: f.id })
}))

router.post('/domicilios/bases/:id/liquidar', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const f = await loadFloat(req, res)
  if (!f) return
  if (f.status !== 'abierta') return fail(res, 'Esta base ya se liquidó', 409)
  const b = req.body || {}
  if (!isMoney(b.returned)) return fail(res, 'Escribe cuánto dinero entregó el domiciliario', 400)
  if (f.session?.status !== 'abierta') return fail(res, `El turno ${f.session?.number} ya está cerrado`, 409)
  const orders = await floatOrders(f)
  const unpaid = orders.filter((o) => !o.paid)
  if (unpaid.length) return fail(res, `Primero cobra ${unpaid.map((o) => o.number).join(', ')}: el domiciliario trae ese dinero.`, 409)
  const ordersCash = orders.reduce((a, o) => a + o.cash, 0)
  const expected = Number(f.amount) + ordersCash
  const returned = money(b.returned)
  const difference = returned - expected
  // El efectivo de los domicilios ya entró a la caja al cobrarlos: lo que vuelve aparte es lo entregado menos eso.
  const back = returned - ordersCash
  const { error } = await supabase.from('courier_floats').update({
    status: 'liquidada', orders_cash: ordersCash, expected, returned, difference, note: clean(b.note) || f.note, settled_by: req.user.id, settled_session_id: f.session_id,
    settled_at: new Date().toISOString(), orders: orders.map((o) => ({ id: o.id, number: o.number, cash: o.cash }))
  }).eq('id', f.id).eq('status', 'abierta')
  if (error) throw error
  if (back !== 0) {
    await supabase.from('cash_movements').insert({ session_id: f.session_id, type: 'retorno_domiciliario', method: 'efectivo', amount: back, ref: f.session?.number, note: `Devolución de la base de ${fullName(f.user)}${difference ? ` (${difference > 0 ? 'sobrante' : 'faltante'} ${Math.abs(difference).toLocaleString('es-CO')})` : ''}`, user_id: req.user.id })
  }
  await audit(req, 'liquidar_base_domiciliario', 'turno_caja', f.session_id, { courier: fullName(f.user), base: Number(f.amount), ordersCash, returned, difference })
  res.send({ ...floatDTO({ ...f, status: 'liquidada', orders_cash: ordersCash, expected, returned, difference }) })
}))

router.get('/caja/turnos/:id/domiciliarios', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const { data: s } = await supabase.from('cash_sessions').select('id, site_id').eq('id', Number(req.params.id)).maybeSingle()
  if (!s || !sameSite(req, s.site_id)) return fail(res, 'Turno no encontrado', 404)
  res.send(await courierSettlement(s.id))
}))

module.exports = router
module.exports.courierSettlement = courierSettlement
module.exports.quickCourierErrors = quickCourierErrors

module.exports.FLOW = FLOW
module.exports.paysCash = paysCash
module.exports.cashFigures = cashFigures
