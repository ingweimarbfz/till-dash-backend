// =====================================================================
// Mesas (TD-003): zonas, mesas, estado del salón, llamados y la carta pública por QR.
// · El salón muestra cada mesa libre, ocupada (con su pedido) o por cobrar (pidió la cuenta).
// · Cada mesa tiene un código QR único. La carta pública (/carta/:token) no pide sesión: muestra
//   los productos con su precio de promoción y deja llamar al mesero o pedir la cuenta.
// · Los llamados se ven en el salón y como aviso con sonido en el navegador del personal.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const plan = require('../plan')
const { runAsOrg } = require('../tenant')
const { workSite, sameSite, fullName, cashOpenAt, NO_CASH } = require('../ops')
const { buildMenu, qrOptionsOf, orderMode, goesDirect } = require('../menu')
const { notify, callMessage } = require('../notify')
const jwt = require('jsonwebtoken')
const { JWT_SECRET } = require('../config')

// Sesión de la carta: al escanear el QR se abre una sesión corta que se renueva mientras el cliente usa
// la carta. Si la deja quieta, vence y para volver a llamar o pedir debe escanear de nuevo.
// Así una pestaña olvidada no sigue consultando ni puede enviar llamados.
const QR_SESSION_MIN = 15
const qrSign = (token) => jwt.sign({ qr: token }, JWT_SECRET, { expiresIn: `${QR_SESSION_MIN}m` })
const QR_EXPIRED = 'La carta se cerró por inactividad. Escanea de nuevo el código QR de tu mesa.'
// undefined: no trae sesión (escaneo nuevo) · false: vencida o de otra mesa · true: válida
const qrCheck = (req, token) => {
  const v = req.get('x-carta-session')
  if (!v) return undefined
  try { return jwt.verify(v, JWT_SECRET).qr === token } catch { return false }
}

const router = express.Router()
const SHAPES = ['cuadrada', 'redonda', 'barra']
const CALLS = { mesero: 'Llamar al mesero', cuenta: 'Pedir la cuenta', pedido: 'Pedido desde la mesa' }
const ORDERING = { llamar: 'Solo llamar al mesero', confirmar: 'Pedir con confirmación del mesero', directo: 'Pedir directo a la cocina y el bar' }

const areaDTO = (a) => ({ id: a.id, siteId: a.site_id, name: a.name, sortOrder: a.sort_order, active: a.active })
const tableDTO = (t) => ({ id: t.id, siteId: t.site_id, areaId: t.area_id, name: t.name, seats: t.seats, shape: t.shape, sortOrder: t.sort_order, qrToken: t.qr_token, active: t.active })
const callDTO = (c) => ({
  id: c.id, tableId: c.table_id, table: c.table?.name, kind: c.kind, label: CALLS[c.kind], note: c.note, status: c.status, createdAt: c.created_at,
  items: c.items || null, total: c.total === null || c.total === undefined ? null : Number(c.total), customerName: c.customer_name ?? null, orderId: c.order_id ?? null, result: c.result ?? null
})

// ---------------------------------------------------------------- Salón
router.get('/mesas', auth(STAFF), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const [{ data: areas }, { data: tables }, { data: orders }, { data: calls }, { data: siteRow }] = await Promise.all([
    supabase.from('dining_areas').select('*').eq('site_id', site).order('sort_order').order('name'),
    supabase.from('dining_tables').select('*').eq('site_id', site).order('sort_order').order('id'),
    supabase.from('orders').select('id, number, table_id, alias, guests, total, opened_at, bill_requested_at, customer_name, waiter:users!orders_waiter_id_fkey(name, last_name), items:order_items(status, quantity)')
      .eq('site_id', site).eq('status', 'abierto'),
    supabase.from('table_calls').select('*').eq('site_id', site).eq('status', 'pendiente').order('created_at'),
    supabase.from('sites').select('id, name').eq('id', site).maybeSingle()
  ])
  const byTable = new Map((orders || []).filter((o) => o.table_id).map((o) => [o.table_id, o]))
  const rows = (tables || []).filter((t) => t.active || req.query.todas === '1').map((t) => {
    const o = byTable.get(t.id)
    const live = (o?.items || []).filter((i) => i.status !== 'anulado')
    return {
      ...tableDTO(t),
      status: o ? (o.bill_requested_at ? 'por_cobrar' : 'ocupada') : t.to_release_at ? 'por_liberar' : 'libre',
      releasePending: !o && t.to_release_at ? { since: t.to_release_at, orderId: t.last_order_id } : null,
      order: o ? {
        id: o.id, number: o.number, alias: o.alias, guests: o.guests, total: Number(o.total), openedAt: o.opened_at, billRequestedAt: o.bill_requested_at,
        waiter: fullName(o.waiter), customer: o.customer_name, items: live.length, ready: live.filter((i) => i.status === 'listo').length
      } : null,
      calls: (calls || []).filter((c) => c.table_id === t.id).map(callDTO)
    }
  })
  const counter = (orders || []).filter((o) => !o.table_id).map((o) => ({ id: o.id, number: o.number, customer: o.customer_name, total: Number(o.total), openedAt: o.opened_at }))
  res.send({ site: siteRow, cashOpen: await cashOpenAt(site), areas: (areas || []).map(areaDTO), tables: rows, counter })
}))

// ---------------------------------------------------------------- Zonas
router.post('/mesas/zonas', auth(ADMIN), h(async (req, res) => {
  const name = clean(req.body?.name)
  if (!name) return fail(res, 'Escribe el nombre de la zona', 400)
  const site = await workSite(req, req.body.siteId)
  const { data, error } = await supabase.from('dining_areas').insert({ site_id: site, name, sort_order: Number(req.body.sortOrder) || 0 }).select('*').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una zona con ese nombre', 409) : fail(res, error)
  await audit(req, 'crear', 'zona', data.id, { name })
  res.status(201).send(areaDTO(data))
}))
router.put('/mesas/zonas/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const name = clean(b.name)
  if (!name) return fail(res, 'Escribe el nombre de la zona', 400)
  const { data, error } = await supabase.from('dining_areas').update({ name, sort_order: Number(b.sortOrder) || 0, active: b.active !== false }).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una zona con ese nombre', 409) : fail(res, error)
  if (!data) return fail(res, 'Zona no encontrada', 404)
  await audit(req, 'editar', 'zona', data.id, { name })
  res.send(areaDTO(data))
}))

// ---------------------------------------------------------------- Mesas
const tableRow = (b) => ({
  name: clean(b.name), seats: Math.min(50, Math.max(1, Number(b.seats) || 4)), shape: SHAPES.includes(b.shape) ? b.shape : 'cuadrada',
  area_id: Number(b.areaId) || null, sort_order: Number(b.sortOrder) || 0
})

// Una mesa, o varias a la vez con { count, prefix } (Mesa 1, Mesa 2…).
router.post('/mesas', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const site = await workSite(req, b.siteId)
  const count = Math.min(60, Math.max(0, Number(b.count) || 0))
  let rows
  if (count) {
    const prefix = clean(b.prefix) || 'Mesa'
    const { data: existing } = await supabase.from('dining_tables').select('name').eq('site_id', site)
    const used = new Set((existing || []).map((t) => t.name))
    rows = []
    for (let n = 1; rows.length < count && n < 1000; n++) {
      const name = `${prefix} ${n}`
      if (!used.has(name)) rows.push({ ...tableRow({ ...b, name }), site_id: site, sort_order: n })
    }
  } else {
    if (!clean(b.name)) return fail(res, 'Escribe el nombre o número de la mesa', 400)
    rows = [{ ...tableRow(b), site_id: site }]
  }
  await plan.checkLimit(req.user.org_id, 'tables', rows.length)
  const { data, error } = await supabase.from('dining_tables').insert(rows).select('*')
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una mesa con ese nombre en la sucursal', 409) : fail(res, error)
  await audit(req, 'crear', 'mesa', data.length === 1 ? data[0].id : null, { names: data.map((t) => t.name) })
  res.status(201).send(data.map(tableDTO))
}))
router.put('/mesas/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.name)) return fail(res, 'Escribe el nombre o número de la mesa', 400)
  const patch = { ...tableRow(b), active: b.active !== false }
  if (patch.active) {
    const { data: cur } = await supabase.from('dining_tables').select('active').eq('id', Number(req.params.id)).maybeSingle()
    if (cur && !cur.active) await plan.checkLimit(req.user.org_id, 'tables')
  }
  if (!patch.active) {
    const { count } = await supabase.from('orders').select('id', { count: 'exact', head: true }).eq('table_id', Number(req.params.id)).eq('status', 'abierto')
    if (count) return fail(res, 'La mesa tiene un pedido abierto: cóbralo o muévelo antes de desactivarla', 409)
  }
  const { data, error } = await supabase.from('dining_tables').update(patch).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una mesa con ese nombre en la sucursal', 409) : fail(res, error)
  if (!data) return fail(res, 'Mesa no encontrada', 404)
  await audit(req, 'editar', 'mesa', data.id, { name: data.name })
  res.send(tableDTO(data))
}))
// Mesa cobrada que ya se limpió: queda libre para los siguientes clientes.
router.post('/mesas/:id/liberar', auth(STAFF), h(async (req, res) => {
  const { data: t } = await supabase.from('dining_tables').select('id, name, site_id, to_release_at').eq('id', Number(req.params.id)).maybeSingle()
  if (!t || !sameSite(req, t.site_id)) return fail(res, 'Mesa no encontrada', 404)
  if (t.to_release_at) {
    const { error } = await supabase.from('dining_tables').update({ to_release_at: null }).eq('id', t.id)
    if (error) throw error
    await audit(req, 'liberar', 'mesa', t.id, { name: t.name })
  }
  res.send({ ok: true })
}))

// Un QR nuevo deja sin servicio el anterior (por ejemplo, si se fotografió y se usa desde fuera).
router.post('/mesas/:id/qr', auth(ADMIN), h(async (req, res) => {
  const token = require('crypto').randomBytes(9).toString('hex')
  const { data, error } = await supabase.from('dining_tables').update({ qr_token: token }).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Mesa no encontrada', 404)
  await audit(req, 'editar', 'mesa', data.id, { name: data.name, qr: 'nuevo' })
  res.send(tableDTO(data))
}))

// ---------------------------------------------------------------- Llamados
router.get('/llamados', auth(STAFF), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const { data, error } = await supabase.from('table_calls').select('*, table:dining_tables(name)').eq('site_id', site).eq('status', 'pendiente').order('created_at')
  if (error) throw error
  res.send(data.map(callDTO))
}))
router.post('/llamados/:id/atender', auth(STAFF), h(async (req, res) => {
  const { data: c } = await supabase.from('table_calls').select('*, table:dining_tables(name)').eq('id', Number(req.params.id)).maybeSingle()
  if (!c) return fail(res, 'Llamado no encontrado', 404)
  if (!sameSite(req, c.site_id)) return fail(res, 'El llamado es de otra sucursal', 403)
  if (c.status === 'pendiente') {
    // Un pedido por confirmar que se marca atendido sin aceptarlo queda rechazado.
    const result = c.kind === 'pedido' && !c.order_id ? 'rechazado' : c.result
    await supabase.from('table_calls').update({ status: 'atendido', result, note: c.kind === 'pedido' && clean(req.body?.reason) ? clean(req.body.reason).slice(0, 140) : c.note, attended_by: req.user.id, attended_at: new Date().toISOString() }).eq('id', c.id)
    if (result === 'rechazado') await audit(req, 'rechazar', 'pedido_qr', c.id, { table: c.table?.name, reason: clean(req.body?.reason) })
  }
  res.send({ ok: true })
}))
// El mesero acepta el pedido que el cliente armó en la carta: entra a la cuenta de la mesa y a las comandas.
router.post('/llamados/:id/aceptar', auth(STAFF), h(async (req, res) => {
  const { addToTable } = require('./orders')
  const { data: c } = await supabase.from('table_calls').select('*, table:dining_tables(id, name, site_id)').eq('id', Number(req.params.id)).maybeSingle()
  if (!c || c.kind !== 'pedido') return fail(res, 'Pedido no encontrado', 404)
  if (!sameSite(req, c.site_id)) return fail(res, 'El pedido es de otra sucursal', 403)
  if (c.status !== 'pendiente' || c.order_id) return fail(res, 'Este pedido ya fue atendido', 409)
  if (!(await cashOpenAt(c.site_id))) return fail(res, NO_CASH, 409)
  const r = await addToTable({ orgId: req.user.org_id, table: c.table, items: c.items, userId: req.user.id, note: c.customer_name ? `Cliente: ${c.customer_name}` : null })
  if (r.error) return fail(res, r.error, 400)
  await supabase.from('table_calls').update({ status: 'atendido', result: 'aceptado', order_id: r.order.id, attended_by: req.user.id, attended_at: new Date().toISOString() }).eq('id', c.id)
  await audit(req, 'aceptar', 'pedido_qr', c.id, { table: c.table?.name, order: r.order.number, items: r.rows.map((x) => `${x.quantity} × ${x.name}`) })
  res.send({ orderId: r.order.id, number: r.order.number })
}))

// ---------------------------------------------------------------- Carta pública (QR)
// Pedido que el cliente puede calificar: el abierto de la mesa o el último cobrado en las últimas 3 horas.
const rateableOrder = async (tableId) => {
  const { data: open } = await supabase.from('orders').select('id, site_id, waiter_id').eq('table_id', tableId).eq('status', 'abierto').maybeSingle()
  if (open) return open
  const since = new Date(Date.now() - 3 * 3600e3).toISOString()
  const { data: last } = await supabase.from('orders').select('id, site_id, waiter_id').eq('table_id', tableId).eq('status', 'cobrado').gte('closed_at', since).order('closed_at', { ascending: false }).limit(1).maybeSingle()
  return last || null
}

const publicTable = async (token) => {
  if (!/^[0-9a-f]{8,40}$/i.test(token || '')) return null
  const { data } = await supabase.from('dining_tables').select('id, org_id, site_id, name, seats, active, area:dining_areas(name), site:sites(name, active), org:organizations(status)').eq('qr_token', token).maybeSingle()
  if (!data || !data.active || !data.site?.active || ['suspendida', 'cancelada'].includes(data.org?.status)) return null
  // La carta por QR es un módulo del plan.
  if (!(await plan.orgHas(data.org_id, 'carta_qr')) || !(await plan.orgHas(data.org_id, 'mesas'))) return null
  return data
}

router.get('/carta/:token', h(async (req, res) => {
  if (qrCheck(req, req.params.token) === false) return res.status(401).send({ message: QR_EXPIRED, expired: true })
  const t = await publicTable(req.params.token)
  if (!t) return fail(res, 'Este código QR ya no está activo. Pide ayuda al personal.', 404)
  // Siempre fresco: el cliente ve al instante cuando el mesero confirma o entrega.
  res.set('Cache-Control', 'no-store')
  await runAsOrg(t.org_id, async () => {
    const rateable = await rateableOrder(t.id)
    const { data: given } = rateable ? await supabase.from('service_ratings').select('stars, comment').eq('order_id', rateable.id).maybeSingle() : { data: null }
    const [m, { data: order }, { data: calls }, cashOpen] = await Promise.all([
      buildMenu({ siteId: t.site_id }),
      supabase.from('orders').select('number, total, tip, guests, opened_at, bill_requested_at, waiter:users!orders_waiter_id_fkey(name), items:order_items(id, name, quantity, unit_price, courtesy, status)').eq('table_id', t.id).eq('status', 'abierto').maybeSingle(),
      supabase.from('table_calls').select('kind, created_at, items, total, order_id').eq('table_id', t.id).eq('status', 'pendiente'),
      cashOpenAt(t.site_id)
    ])
    res.send({
      session: qrSign(req.params.token), sessionMinutes: QR_SESSION_MIN,
      business: m.business, menu: m.menu,
      table: { name: t.name, site: t.site?.name, area: t.area?.name ?? null, seats: t.seats },
      // Qué puede hacer el cliente (cada opción por separado). Sin caja abierta no se pide.
      actions: { callWaiter: m.qr.callWaiter, requestBill: m.qr.requestBill },
      ordering: m.orderMode, canOrder: m.orderMode !== 'none' && cashOpen,
      categories: m.categories,
      products: m.products,
      // Cuenta del cliente según la configuración: completa, solo productos y estado (sin valores) u oculta.
      billView: m.qr.billView,
      order: order ? {
        number: order.number, total: m.qr.billView === 'completa' ? Number(order.total) : null, billRequested: Boolean(order.bill_requested_at), openedAt: order.opened_at, guests: order.guests, waiter: order.waiter?.name ?? null,
        items: m.qr.billView === 'oculta' ? [] : (order.items || []).filter((i) => i.status !== 'anulado').sort((a, b) => a.id - b.id).map((i) => ({ name: i.name, quantity: Number(i.quantity), price: m.qr.billView === 'completa' ? Number(i.unit_price) : null, courtesy: i.courtesy, status: i.status }))
      } : null,
      calls: (calls || []).map((c) => c.kind),
      rating: { canRate: Boolean(rateable), stars: given?.stars ?? null, comment: given?.comment ?? null },
      pendingOrder: (() => { const p = (calls || []).find((c) => c.kind === 'pedido' && !c.order_id); return p ? { items: p.items || [], total: m.qr.billView === 'completa' ? Number(p.total || 0) : null, at: p.created_at } : null })()
    })
  })
}))

router.post('/carta/:token/llamar', h(async (req, res) => {
  if (qrCheck(req, req.params.token) !== true) return res.status(401).send({ message: QR_EXPIRED, expired: true })
  const t = await publicTable(req.params.token)
  if (!t) return fail(res, 'Este código QR ya no está activo. Pide ayuda al personal.', 404)
  const kind = ['mesero', 'cuenta'].includes(req.body?.kind) ? req.body.kind : 'mesero'
  await runAsOrg(t.org_id, async () => {
    const { data: st } = await supabase.from('app_settings').select('qr_call_waiter, qr_request_bill').maybeSingle()
    const o = qrOptionsOf(st)
    if (kind === 'mesero' && !o.callWaiter) return fail(res, 'Esta opción no está disponible en este lugar.', 403)
    if (kind === 'cuenta' && !o.requestBill) return fail(res, 'Pide la cuenta directamente al personal.', 403)
    const note = clean(req.body?.note)?.slice(0, 140) ?? null
    const { error } = await supabase.from('table_calls').insert({ site_id: t.site_id, table_id: t.id, kind, note })
    if (error && error.code !== '23505') throw error
    if (!error) notify('mesas', () => callMessage({ table: t.name, kind, note, site: t.site?.name, siteId: t.site_id }))
    if (kind === 'cuenta') await supabase.from('orders').update({ bill_requested_at: new Date().toISOString() }).eq('table_id', t.id).eq('status', 'abierto').is('bill_requested_at', null)
    res.status(error ? 200 : 201).send({ ok: true, message: kind === 'cuenta' ? 'Listo, ya le avisamos al personal que quieres la cuenta.' : 'Listo, tu mesero viene en camino.' })
  })
}))

// El cliente califica el servicio (1 a 5 estrellas). Puede cambiar su calificación mientras siga en la mesa.
router.post('/carta/:token/calificar', h(async (req, res) => {
  if (qrCheck(req, req.params.token) !== true) return res.status(401).send({ message: QR_EXPIRED, expired: true })
  const t = await publicTable(req.params.token)
  if (!t) return fail(res, 'Este código QR ya no está activo. Pide ayuda al personal.', 404)
  const stars = Math.round(Number(req.body?.stars))
  if (!(stars >= 1 && stars <= 5)) return fail(res, 'Elige de 1 a 5 estrellas', 400)
  const comment = clean(req.body?.comment)?.slice(0, 300) ?? null
  await runAsOrg(t.org_id, async () => {
    const o = await rateableOrder(t.id)
    if (!o) return fail(res, 'Podrás calificar cuando tengas un pedido en la mesa.', 409)
    const { error } = await supabase.from('service_ratings').upsert({ site_id: o.site_id, table_id: t.id, order_id: o.id, waiter_id: o.waiter_id, stars, comment, updated_at: new Date().toISOString() }, { onConflict: 'order_id' })
    if (error) throw error
    if (stars <= 2) notify('mesas', () => callMessage({ table: t.name, kind: 'mesero', note: `Calificación de ${stars} ★${comment ? `: ${comment}` : ''}`, site: t.site?.name, siteId: t.site_id }))
    res.status(201).send({ ok: true, message: stars >= 4 ? '¡Gracias! Nos alegra que lo disfrutes.' : 'Gracias por contarnos. Vamos a mejorar.' })
  })
}))

// El cliente pide desde la carta. Según la configuración:
// · confirmar: queda como llamado 'pedido' hasta que el mesero lo acepte (un pedido pendiente por mesa).
// · directo: entra a la cuenta de la mesa y a las comandas; el personal recibe el aviso.
router.post('/carta/:token/pedido', h(async (req, res) => {
  if (qrCheck(req, req.params.token) !== true) return res.status(401).send({ message: QR_EXPIRED, expired: true })
  const { addToTable } = require('./orders')
  const t = await publicTable(req.params.token)
  if (!t) return fail(res, 'Este código QR ya no está activo. Pide ayuda al personal.', 404)
  const b = req.body || {}
  const list = (Array.isArray(b.items) ? b.items : []).filter((i) => Number(i.productId) && Number(i.quantity) > 0)
  if (!list.length) return fail(res, 'Agrega al menos un producto', 400)
  if (list.length > 30 || list.some((i) => Number(i.quantity) > 20)) return fail(res, 'Para un pedido tan grande, llama al mesero', 400)
  const items = list.map((i) => ({ productId: Number(i.productId), quantity: Math.round(Number(i.quantity)), note: clean(i.note)?.slice(0, 120) ?? null }))
  const customer = clean(b.name)?.slice(0, 60) ?? null
  const note = clean(b.note)?.slice(0, 140) ?? null
  await runAsOrg(t.org_id, async () => {
    const { data: st } = await supabase.from('app_settings').select('qr_ordering, qr_order_confirm, qr_order_direct, qr_direct_categories').maybeSingle()
    const o = qrOptionsOf(st)
    const mode = orderMode(o)
    if (mode === 'none') return fail(res, 'En este lugar los pedidos se hacen con el mesero. Toca "Llamar al mesero".', 403)
    if (!(await cashOpenAt(t.site_id))) return fail(res, 'Todavía no estamos recibiendo pedidos. Llama al mesero.', 409)
    const { buildItems } = require('./orders')
    const built = await buildItems({ user: { id: null } }, items, { allowCourtesy: false, siteId: t.site_id })
    if (built.error) return fail(res, built.error, 400)
    // Cada producto va directo o por confirmación según su categoría (con ambas formas de pedir activas).
    const { data: pc } = await supabase.from('products').select('id, category_id').in('id', items.map((i) => i.productId))
    const catOf = new Map((pc || []).map((x) => [x.id, x.category_id]))
    const isDirect = (productId) => goesDirect(o, catOf.get(Number(productId)))
    const directItems = items.filter((i) => isDirect(i.productId))
    const confirmItems = items.filter((i) => !isDirect(i.productId))
    const lines = (list) => built.rows.filter((r) => list.some((i) => Number(i.productId) === Number(r.product_id)))
      .map((r) => ({ productId: r.product_id, name: r.name, quantity: Number(r.quantity), price: Number(r.unit_price), note: r.note }))
    const sum = (rows) => rows.reduce((a, r) => a + r.quantity * r.price, 0)
    const msg = (summary, extra) => notify('mesas', () => callMessage({ table: t.name, kind: 'pedido', note: [customer, note, extra].filter(Boolean).join(' · ') || null, items: summary, site: t.site?.name, siteId: t.site_id }))
    const done = []
    if (confirmItems.length) {
      const summary = lines(confirmItems)
      const { error } = await supabase.from('table_calls').insert({ site_id: t.site_id, table_id: t.id, kind: 'pedido', note, items: summary, total: sum(summary), customer_name: customer })
      if (error?.code === '23505') return fail(res, 'Ya enviaste un pedido. Espera a que el mesero lo confirme.', 409)
      if (error) throw error
      msg(summary, 'por confirmar')
      done.push('confirmar')
    }
    if (directItems.length) {
      const summary = lines(directItems)
      const r = await addToTable({ orgId: t.org_id, table: t, items: directItems, note: customer ? `Cliente: ${customer}` : null })
      if (r.error) return fail(res, r.error, 400)
      // Aviso para el personal: si ya hay uno directo sin ver, se le suman los productos.
      const { data: prev } = await supabase.from('table_calls').select('id, items, total').eq('table_id', t.id).eq('kind', 'pedido').eq('status', 'pendiente').not('order_id', 'is', null).maybeSingle()
      if (prev) await supabase.from('table_calls').update({ items: [...(prev.items || []), ...summary], total: Number(prev.total || 0) + sum(summary), order_id: r.order.id, result: 'directo' }).eq('id', prev.id)
      else {
        const { error: ce } = await supabase.from('table_calls').insert({ site_id: t.site_id, table_id: t.id, kind: 'pedido', note, items: summary, total: sum(summary), customer_name: customer, order_id: r.order.id, result: 'directo' })
        if (ce && ce.code !== '23505') throw ce
      }
      msg(summary, 'directo a cocina')
      done.push('directo')
    }
    const message = done.length === 2
      ? 'Listo. Una parte de tu pedido ya va para la cocina y el bar; el resto lo confirma tu mesero.'
      : done[0] === 'directo' ? 'Listo, tu pedido ya va para la cocina y el bar.' : 'Listo, tu pedido le llegó al mesero. Te avisamos cuando lo confirme.'
    res.status(201).send({ ok: true, mode: done.length === 2 ? 'mixto' : done[0], message })
  })
}))

module.exports = router
module.exports.CALLS = CALLS
module.exports.ORDERING = ORDERING
