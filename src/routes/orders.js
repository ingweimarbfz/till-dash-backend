// =====================================================================
// Pedidos (TD-003): consecutivo por sucursal, productos con precio de promoción, comandas por área,
// cortesías, anulaciones con motivo, descuento, propina y cobro en varias formas de pago.
// · Mesero: abre pedidos, agrega productos, pide la cuenta y anula lo que la cocina no ha empezado.
// · Cocina, bar y barista: ven sus comandas y marcan preparando o listo.
// · Cajero y administrador: cortesías, anulaciones, descuentos y cobro dentro de un turno de caja.
// · El inventario se descuenta solo (trigger order_item_stock) y avisa si un producto queda bajo.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { bestFor, loadActive } = require('../promo')
const { checkLowStock } = require('../stock')
const { notify, courtesyMessage, voidMessage } = require('../notify')
const { cashOpenAt, NO_CASH, can, guard, workSite, sameSite, dbError, money, isMoney, PAY_METHODS, fullName } = require('../ops')
const { qty } = require('./inventory')
const plan = require('../plan')
const { customerFromBody, createCustomer } = require('./customers')
const { validateSplit } = require('../split')

const router = express.Router()

const TYPES = { mesa: 'Mesa', llevar: 'Para llevar', domicilio: 'Domicilio', barra: 'Barra' }
const ITEM_STATUS = { pendiente: 'Pendiente', preparando: 'Preparando', listo: 'Listo', entregado: 'Entregado', anulado: 'Anulado' }
const KITCHEN = ['cocina', 'bartender', 'barista']
const AREA_OF_POSITION = { cocina: 'cocina', bartender: 'bar', barista: 'barista' }
const SELLERS = ['mesero', 'cajero', 'host', 'bartender', 'barista']

// Formas de pago del domicilio: efectivo al domiciliario u otro medio.
const DELIVERY_PAY = ['efectivo', 'tarjeta', 'transferencia', 'nequi', 'daviplata', 'otro']
const ORDER_COLUMNS = `*, site:sites(name), table:dining_tables!orders_table_id_fkey(id, name),
  waiter:users!orders_waiter_id_fkey(id, name, last_name), cashier:users!orders_cashier_id_fkey(id, name, last_name),
  courier:users!orders_courier_id_fkey(id, name, last_name), customer:customers(id, name, zone, kind)`

const itemDTO = (i) => ({
  id: i.id, productId: i.product_id, name: i.name, area: i.area, quantity: Number(i.quantity), listPrice: Number(i.list_price), unitPrice: Number(i.unit_price),
  total: Math.round(Number(i.quantity) * Number(i.unit_price)), promotion: i.promotion_name, courtesy: i.courtesy, courtesyReason: i.courtesy_reason,
  note: i.note, status: i.status, statusLabel: ITEM_STATUS[i.status], voidReason: i.void_reason, createdAt: i.created_at, readyAt: i.ready_at,
  user: fullName(i.user)
})
const orderDTO = (o) => ({
  id: o.id, number: o.number, siteId: o.site_id, site: o.site?.name ?? null, type: o.type, typeLabel: TYPES[o.type], status: o.status,
  tableId: o.table_id, table: o.table?.name ?? null, alias: o.alias ?? null, guests: o.guests,
  customerId: o.customer_id ?? null, customer: o.customer ? { id: o.customer.id, name: o.customer.name, zone: o.customer.zone, kind: o.customer.kind } : null, customerName: o.customer_name, customerPhone: o.customer_phone,
  customerAddress: o.customer_address, note: o.note, waiter: o.waiter ? { id: o.waiter.id, name: fullName(o.waiter) } : null,
  cashier: o.cashier ? { id: o.cashier.id, name: fullName(o.cashier) } : null,
  gross: Number(o.gross), courtesyTotal: Number(o.courtesy_total), subtotal: Number(o.subtotal),
  discount: o.discount_type ? { id: o.discount_id, name: o.discount_name, type: o.discount_type, value: Number(o.discount_value), reason: o.discount_reason } : null,
  discountTotal: Number(o.discount_total), tip: Number(o.tip), deliveryFee: Number(o.delivery_fee || 0), total: Number(o.total), paid: Number(o.paid),
  courier: o.courier ? { id: o.courier.id, name: fullName(o.courier) } : null, deliveryStatus: o.delivery_status || null, deliveryPayMethod: o.delivery_pay_method || null, deliveryCashWith: o.delivery_cash_with === null || o.delivery_cash_with === undefined ? null : Number(o.delivery_cash_with), dispatchedAt: o.dispatched_at || null, arrivedAt: o.arrived_at || null,
  split: o.split || null, billRequestedAt: o.bill_requested_at, voidReason: o.void_reason, openedAt: o.opened_at, closedAt: o.closed_at,
  items: o.items ? o.items.sort((a, b) => a.id - b.id).map(itemDTO) : undefined
})

// Alias temporal de la mesa: texto corto, se borra al cerrar el pedido.
const aliasOf = (v) => (clean(v) ? clean(v).slice(0, 40) : null)

const loadOrder = async (id) => {
  const { data } = await supabase.from('orders').select(`${ORDER_COLUMNS}, items:order_items(*, user:users!order_items_user_id_fkey(name, last_name))`).eq('id', Number(id)).maybeSingle()
  return data
}
// Pedido de la sucursal del usuario y, si se pide, abierto.
const orderFor = async (req, res, { open = true } = {}) => {
  const o = await loadOrder(req.params.id)
  if (!o) { fail(res, 'Pedido no encontrado', 404); return null }
  if (!sameSite(req, o.site_id)) { fail(res, 'El pedido es de otra sucursal', 403); return null }
  if (open && o.status !== 'abierto') { fail(res, `El pedido ${o.number} ya está ${o.status}`, 409); return null }
  return o
}

// ---------------------------------------------------------------- Listado y detalle
router.get('/pedidos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('orders').select(`${ORDER_COLUMNS}, items:order_items(id, status)`).order('opened_at', { ascending: false }).limit(Math.min(Number(req.query.limite) || 100, 300))
  if (req.siteId) q = q.eq('site_id', req.siteId)
  if (['abierto', 'cobrado', 'anulado'].includes(req.query.estado)) q = q.eq('status', req.query.estado)
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')) {
    const from = new Date(`${req.query.fecha}T00:00:00-05:00`)
    q = q.gte('opened_at', from.toISOString()).lt('opened_at', new Date(from.getTime() + 864e5).toISOString())
  }
  if (clean(req.query.q)) q = q.or(`number.ilike.%${clean(req.query.q).replace(/[%,()]/g, '')}%,customer_name.ilike.%${clean(req.query.q).replace(/[%,()]/g, '')}%`)
  if (req.query.mios === '1') q = q.eq('waiter_id', req.user.id)
  if (Number(req.query.cliente)) q = q.eq('customer_id', Number(req.query.cliente))
  const { data, error } = await q
  if (error) throw error
  res.send(data.map((o) => ({ ...orderDTO({ ...o, items: undefined }), itemCount: (o.items || []).filter((i) => i.status !== 'anulado').length })))
}))

router.get('/pedidos/:id', auth(STAFF), h(async (req, res) => {
  const o = await orderFor(req, res, { open: false })
  if (!o) return
  const [{ data: pays }, { data: cxc }] = await Promise.all([
    supabase.from('order_payments').select('*, user:users(name, last_name)').eq('order_id', o.id).order('id'),
    supabase.from('receivables').select('id, number, customer_name, amount, paid, status').eq('order_id', o.id)
  ])
  res.send({
    ...orderDTO(o),
    payments: (pays || []).map((p) => ({ id: p.id, method: p.method, methodLabel: PAY_METHODS[p.method], amount: Number(p.amount), received: p.received === null ? null : Number(p.received), change: p.change === null ? null : Number(p.change), reference: p.reference, payer: p.payer || null, user: fullName(p.user), createdAt: p.created_at })),
    receivables: (cxc || []).map((r) => ({ id: r.id, number: r.number, customerName: r.customer_name, amount: Number(r.amount), paid: Number(r.paid), status: r.status }))
  })
}))

// ---------------------------------------------------------------- Productos del pedido
// Arma las filas con el precio vigente (promoción incluida) y el área de la categoría.
const buildItems = async (req, items) => {
  const list = (Array.isArray(items) ? items : []).filter((i) => Number(i.productId) && Number(i.quantity) > 0)
  if (!list.length) return { error: 'Agrega al menos un producto' }
  if (list.length > 60) return { error: 'Máximo 60 productos por envío' }
  const ids = [...new Set(list.map((i) => Number(i.productId)))]
  const [{ data: prods }, promos] = await Promise.all([
    supabase.from('products').select('id, name, price, category_id, active, track_stock, category:product_categories(area)').in('id', ids),
    loadActive()
  ])
  const byId = new Map((prods || []).map((p) => [p.id, p]))
  const rows = []
  for (const i of list) {
    const p = byId.get(Number(i.productId))
    if (!p || !p.active) return { error: 'Uno de los productos no existe o está inactivo' }
    const best = bestFor(promos, p)
    rows.push({
      product_id: p.id, name: p.name, area: p.category?.area || 'ninguna', quantity: qty(i.quantity), list_price: Number(p.price),
      unit_price: best ? best.price : Number(p.price), promotion_id: best?.promo.id ?? null, promotion_name: best?.promo.name ?? null,
      note: clean(i.note)?.slice(0, 200) ?? null, user_id: req.user.id, status: p.category?.area && p.category.area !== 'ninguna' ? 'pendiente' : 'listo'
    })
  }
  return { rows }
}

const insertItems = async (req, order, rows) => {
  const { data, error } = await supabase.from('order_items').insert(rows.map((r) => ({ ...r, order_id: order.id }))).select('id, product_id, warehouse_id')
  if (error) return { error }
  const pairs = data.filter((x) => x.warehouse_id).map((x) => ({ warehouseId: x.warehouse_id, productId: x.product_id }))
  if (pairs.length) checkLowStock(pairs).catch((e) => console.error('[stock]', e.message))
  return { data }
}

// Pedido de una mesa desde el QR: usa el pedido abierto de la mesa o abre uno, y le agrega los productos.
// userId: el mesero que aceptó el pedido, o null si el cliente lo hizo directo (queda a nombre del mesero de la mesa).
const addToTable = async ({ orgId, table, items, userId = null, note = null }) => {
  const built = await buildItems({ user: { id: userId } }, items)
  if (built.error) return { error: built.error }
  const find = async () => (await supabase.from('orders').select('id, number, site_id, waiter_id').eq('table_id', table.id).eq('status', 'abierto').maybeSingle()).data
  let o = await find()
  let created = false
  if (!o) {
    const { data: number, error: e1 } = await supabase.rpc('next_consecutive', { p_org: orgId, p_kind: 'pedido', p_site: table.site_id, p_prefix: 'P-' })
    if (e1) throw e1
    const { data, error } = await supabase.from('orders').insert({ site_id: table.site_id, number, type: 'mesa', table_id: table.id, waiter_id: userId, opened_by: userId, note })
      .select('id, number, site_id, waiter_id').single()
    if (error && error.code !== '23505') throw error
    if (error) o = await find(); else { o = data; created = true }
    await supabase.from('dining_tables').update({ to_release_at: null }).eq('id', table.id)
  }
  const r = await insertItems(null, o, built.rows.map((x) => ({ ...x, user_id: x.user_id ?? o.waiter_id ?? null })))
  if (r.error) {
    if (created) await supabase.from('orders').delete().eq('id', o.id)
    return { error: r.error.code === 'P0001' ? r.error.message : 'No se pudo agregar el pedido' }
  }
  return { order: o, created, rows: built.rows }
}

// ---------------------------------------------------------------- Abrir pedido
router.post('/pedidos', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const b = req.body || {}
  const type = TYPES[b.type] ? b.type : (b.tableId ? 'mesa' : 'llevar')
  const site = await workSite(req, b.siteId)
  // Plan sin mesas (distribuidora): solo domicilio y para recoger. Sin domicilios: no hay pedidos a domicilio.
  if ((type === 'mesa' || type === 'barra') && !(await plan.orgHas(req.user.org_id, 'mesas'))) return fail(res, 'Tu plan no incluye mesas: abre el pedido a domicilio o como venta en mostrador.', 403)
  if (type === 'domicilio' && !(await plan.orgHas(req.user.org_id, 'domicilios'))) return fail(res, 'Tu plan no incluye domicilios. Pide un cambio en "Mi plan".', 403)
  // Cliente del directorio: completa nombre, celular y dirección; o se guarda como cliente nuevo.
  const cust = await customerFromBody(req, b, site)
  if (cust.error) return fail(res, cust.error, cust.status || 400)
  if (cust.customer) {
    const c = cust.customer
    b.customerName = clean(b.customerName) || c.name
    b.customerPhone = clean(b.customerPhone) || c.phone
    b.customerAddress = clean(b.customerAddress) || [c.address, c.neighborhood].filter(Boolean).join(', ') || null
    if ((b.deliveryFee === undefined || b.deliveryFee === null || b.deliveryFee === '') && c.delivery_fee !== null && c.delivery_fee !== undefined) b.deliveryFee = Number(c.delivery_fee)
  }
  let table = null
  if (type === 'mesa') {
    if (!Number(b.tableId)) return fail(res, 'Elige la mesa', 400)
    const { data } = await supabase.from('dining_tables').select('id, name, site_id, active').eq('id', Number(b.tableId)).maybeSingle()
    if (!data || !data.active || data.site_id !== site) return fail(res, 'La mesa no existe en esta sucursal', 400)
    table = data
  }
  if (type === 'domicilio' && !clean(b.customerAddress)) return fail(res, 'Escribe la dirección del domicilio', 400)
  if (b.deliveryFee !== undefined && b.deliveryFee !== null && b.deliveryFee !== '' && !isMoney(b.deliveryFee)) return fail(res, 'El valor del domicilio no es válido', 400)
  if (type === 'domicilio' && !DELIVERY_PAY.includes(b.deliveryPayMethod)) return fail(res, 'Elige cómo paga el cliente el domicilio', 400)
  if (!(await cashOpenAt(site))) return fail(res, NO_CASH, 409)
  // "Guardar como cliente": el cliente nuevo entra al directorio con los datos del pedido.
  if (!cust.customer && b.saveCustomer && clean(b.customerName)) {
    const made = await createCustomer(req, { name: b.customerName, phone: b.customerPhone, address: b.customerAddress, zone: b.customerZone, siteId: site })
    if (made.error) return fail(res, made.error, made.status || 400)
    cust.customer = made.customer
  }
  let built = null
  if (Array.isArray(b.items) && b.items.length) {
    built = await buildItems(req, b.items)
    if (built.error) return fail(res, built.error, 400)
  }
  const waiterId = Number(b.waiterId) || req.user.id
  const { data: number, error: e1 } = await supabase.rpc('next_consecutive', { p_org: req.user.org_id, p_kind: 'pedido', p_site: site, p_prefix: 'P-' })
  if (e1) throw e1
  const { data: order, error } = await supabase.from('orders').insert({
    site_id: site, number, type, table_id: table?.id ?? null, guests: Number(b.guests) > 0 ? Math.min(100, Number(b.guests)) : null,
    alias: aliasOf(b.alias), customer_id: cust.customer?.id ?? null, ...(type === 'domicilio' ? { delivery_status: 'por_despachar', courier_id: Number(b.courierId) || null, delivery_pay_method: b.deliveryPayMethod, delivery_cash_with: b.deliveryPayMethod === 'efectivo' && money(b.deliveryCashWith) > 0 ? money(b.deliveryCashWith) : null, ...(money(b.deliveryFee) > 0 ? { delivery_fee: money(b.deliveryFee) } : {}) } : {}), customer_name: clean(b.customerName), customer_phone: clean(b.customerPhone), customer_address: clean(b.customerAddress), note: clean(b.note),
    waiter_id: waiterId, opened_by: req.user.id
  }).select('id, number').single()
  if (error) return error.code === '23505' ? fail(res, `${table?.name || 'La mesa'} ya tiene un pedido abierto`, 409) : fail(res, error)
  if (built) {
    const r = await insertItems(req, order, built.rows)
    if (r.error) {
      await supabase.from('orders').delete().eq('id', order.id)
      return dbError(res, r.error)
    }
  }
  if (table) await supabase.from('dining_tables').update({ to_release_at: null }).eq('id', table.id)
  await supabase.from('table_calls').update({ status: 'atendido', attended_by: req.user.id, attended_at: new Date().toISOString() }).eq('table_id', table?.id ?? 0).eq('kind', 'mesero').eq('status', 'pendiente')
  await audit(req, 'crear', 'pedido', order.id, { number, table: table?.name ?? null, type })
  res.status(201).send(orderDTO(await loadOrder(order.id)))
}))

router.post('/pedidos/:id/items', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  if (!(await cashOpenAt(o.site_id))) return fail(res, NO_CASH, 409)
  const built = await buildItems(req, req.body?.items)
  if (built.error) return fail(res, built.error, 400)
  const r = await insertItems(req, o, built.rows)
  if (r.error) return dbError(res, r.error)
  await audit(req, 'agregar', 'pedido', o.id, { number: o.number, items: built.rows.map((x) => `${x.quantity} × ${x.name}`) })
  res.status(201).send(orderDTO(await loadOrder(o.id)))
}))

// Datos del pedido y cambio de mesa.
router.put('/pedidos/:id', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  const b = req.body || {}
  const patch = {}
  if ('guests' in b) patch.guests = Number(b.guests) > 0 ? Math.min(100, Number(b.guests)) : null
  for (const [k, c] of [['customerName', 'customer_name'], ['customerPhone', 'customer_phone'], ['customerAddress', 'customer_address'], ['note', 'note']]) if (k in b) patch[c] = clean(b[k])
  if ('alias' in b) patch.alias = aliasOf(b.alias)
  if ('deliveryPayMethod' in b || 'deliveryCashWith' in b) {
    if (o.type !== 'domicilio') return fail(res, 'Solo los pedidos a domicilio llevan forma de pago del domicilio', 400)
    const method = 'deliveryPayMethod' in b ? b.deliveryPayMethod : o.delivery_pay_method
    if (!DELIVERY_PAY.includes(method)) return fail(res, 'Forma de pago no válida', 400)
    patch.delivery_pay_method = method
    patch.delivery_cash_with = method === 'efectivo' && money('deliveryCashWith' in b ? b.deliveryCashWith : o.delivery_cash_with) > 0 ? money('deliveryCashWith' in b ? b.deliveryCashWith : o.delivery_cash_with) : null
  }
  if ('deliveryFee' in b) {
    if (o.type !== 'domicilio') return fail(res, 'Solo los pedidos a domicilio llevan valor de domicilio', 400)
    if (b.deliveryFee !== null && b.deliveryFee !== '' && !isMoney(b.deliveryFee)) return fail(res, 'El valor del domicilio no es válido', 400)
    patch.delivery_fee = money(b.deliveryFee)
  }
  if (Number(b.waiterId)) patch.waiter_id = Number(b.waiterId)
  if ('customerId' in b) {
    if (b.customerId === null || b.customerId === '') patch.customer_id = null
    else {
      const { data: c } = await supabase.from('customers').select('id, name, phone, address, neighborhood').eq('id', Number(b.customerId)).eq('active', true).maybeSingle()
      if (!c) return fail(res, 'Cliente no encontrado', 404)
      patch.customer_id = c.id
      if (!('customerName' in b)) patch.customer_name = c.name
      if (!('customerPhone' in b) && c.phone) patch.customer_phone = c.phone
      if (!('customerAddress' in b) && c.address) patch.customer_address = [c.address, c.neighborhood].filter(Boolean).join(', ')
    }
  }
  if (Number(b.tableId) && Number(b.tableId) !== o.table_id) {
    if (!(await plan.orgHas(req.user.org_id, 'mesas'))) return fail(res, 'Tu plan no incluye mesas', 403)
    const { data: t } = await supabase.from('dining_tables').select('id, name, site_id, active').eq('id', Number(b.tableId)).maybeSingle()
    if (!t || !t.active || t.site_id !== o.site_id) return fail(res, 'La mesa no existe en esta sucursal', 400)
    patch.table_id = t.id; patch.type = 'mesa'
  }
  if (!Object.keys(patch).length) return fail(res, 'No hay cambios', 400)
  const { error } = await supabase.from('orders').update(patch).eq('id', o.id)
  if (error) return error.code === '23505' ? fail(res, 'Esa mesa ya tiene un pedido abierto', 409) : fail(res, error)
  if ('delivery_fee' in patch) {
    await supabase.rpc('recalc_order', { p_order: o.id })
    if (patch.delivery_fee !== Number(o.delivery_fee || 0)) await audit(req, 'domicilio', 'pedido', o.id, { number: o.number, from: Number(o.delivery_fee || 0), to: patch.delivery_fee })
  }
  if (patch.table_id) await audit(req, 'mover', 'pedido', o.id, { number: o.number, from: o.table?.name ?? null, to: patch.table_id })
  res.send(orderDTO(await loadOrder(o.id)))
}))

router.post('/pedidos/:id/cuenta', auth(STAFF), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  await supabase.from('orders').update({ bill_requested_at: req.body?.cancel ? null : new Date().toISOString() }).eq('id', o.id)
  res.send(orderDTO(await loadOrder(o.id)))
}))

// Cortesía: el producto queda en el pedido en $0 para el cliente, con el motivo.
router.post('/pedidos/:id/items/:itemId/cortesia', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  const it = o.items.find((i) => i.id === Number(req.params.itemId))
  if (!it || it.status === 'anulado') return fail(res, 'Producto no encontrado en el pedido', 404)
  const on = req.body?.on !== false
  const reason = clean(req.body?.reason)
  if (on && !reason) return fail(res, 'Escribe el motivo de la cortesía', 400)
  const { error } = await supabase.from('order_items').update(on ? { courtesy: true, courtesy_reason: reason, courtesy_by: req.user.id } : { courtesy: false, courtesy_reason: null, courtesy_by: null }).eq('id', it.id)
  if (error) throw error
  await audit(req, on ? 'cortesia' : 'quitar_cortesia', 'pedido', o.id, { number: o.number, item: it.name, quantity: Number(it.quantity), reason })
  if (on) notify('pedidos', () => courtesyMessage({ order: o, item: it, reason, user: req.user, siteId: o.site_id, site: o.site?.name }))
  res.send(orderDTO(await loadOrder(o.id)))
}))

// Anular un producto: devuelve el inventario. El mesero solo puede si la cocina no lo ha empezado.
router.post('/pedidos/:id/items/:itemId/anular', auth(STAFF), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  const it = o.items.find((i) => i.id === Number(req.params.itemId))
  if (!it || it.status === 'anulado') return fail(res, 'Producto no encontrado en el pedido', 404)
  const reason = clean(req.body?.reason)
  if (!reason) return fail(res, 'Escribe el motivo de la anulación', 400)
  if (!can(req.user, 'cajero') && !(can(req.user, ...SELLERS) && it.status === 'pendiente')) {
    return fail(res, 'La cocina ya empezó este producto: pide al cajero o al administrador que lo anule', 403)
  }
  const { error } = await supabase.from('order_items').update({ status: 'anulado', void_reason: reason }).eq('id', it.id)
  if (error) return dbError(res, error)
  await audit(req, 'anular', 'producto_pedido', o.id, { number: o.number, item: it.name, quantity: Number(it.quantity), reason })
  notify('pedidos', () => voidMessage({ order: o, items: [it], reason, user: req.user, siteId: o.site_id, site: o.site?.name }))
  res.send(orderDTO(await loadOrder(o.id)))
}))

router.post('/pedidos/:id/anular', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  const reason = clean(req.body?.reason)
  if (!reason) return fail(res, 'Escribe el motivo de la anulación', 400)
  const live = o.items.filter((i) => i.status !== 'anulado')
  if (live.length) {
    const { error } = await supabase.from('order_items').update({ status: 'anulado', void_reason: reason }).eq('order_id', o.id).neq('status', 'anulado')
    if (error) return dbError(res, error)
  }
  await supabase.from('orders').update({ status: 'anulado', void_reason: reason, voided_by: req.user.id, closed_at: new Date().toISOString() }).eq('id', o.id)
  await supabase.from('table_calls').update({ status: 'atendido', attended_by: req.user.id, attended_at: new Date().toISOString() }).eq('table_id', o.table_id ?? 0).eq('status', 'pendiente')
  await audit(req, 'anular', 'pedido', o.id, { number: o.number, total: Number(o.total), reason })
  notify('pedidos', () => voidMessage({ order: o, items: live, reason, user: req.user, siteId: o.site_id, site: o.site?.name, whole: true }))
  res.send(orderDTO(await loadOrder(o.id)))
}))

// ---------------------------------------------------------------- Cobro
// Turno de caja para cobrar: el indicado, el que abrió el usuario o el único abierto en la sucursal.
const pickSession = async (req, siteId, wanted) => {
  const { data } = await supabase.from('cash_sessions').select('id, opened_by, register:cash_registers(name)').eq('site_id', siteId).eq('status', 'abierta')
  const open = data || []
  if (Number(wanted)) return open.find((s) => s.id === Number(wanted)) || null
  return open.find((s) => s.opened_by === req.user.id) || (open.length === 1 ? open[0] : null)
}

const validatePayments = (payments) => {
  const list = Array.isArray(payments) ? payments : []
  if (!list.length) return 'Agrega al menos una forma de pago'
  for (const p of list) {
    if (!PAY_METHODS[p.method]) return 'Forma de pago no válida'
    if (!(Number(p.amount) > 0)) return 'Cada pago debe tener un valor mayor que cero'
    if (p.method === 'efectivo' && p.received !== undefined && p.received !== null && p.received !== '' && Number(p.received) < Number(p.amount)) return 'El efectivo recibido es menor que el valor a pagar'
  }
  return null
}

// Guarda el reparto en el pedido y el pagador de cada pago (se insertaron en el mismo orden). Si falla, el cobro ya quedó hecho.
const saveSplit = async (orderId, { split, payers }) => {
  try {
    const { error } = await supabase.from('orders').update({ split }).eq('id', orderId)
    if (error) throw error
    const { data: rows } = await supabase.from('order_payments').select('id').eq('order_id', orderId).order('id')
    await Promise.all((rows || []).slice(-payers.length).map((r, n) => supabase.from('order_payments').update({ payer: payers[n] }).eq('id', r.id)))
  } catch (e) { console.error('[cuenta dividida]', e.message) }
}

router.post('/pedidos/:id/cobrar', auth(STAFF), guard('cajero'), h(async (req, res) => {
  const o = await orderFor(req, res)
  if (!o) return
  const b = req.body || {}
  const err = validatePayments(b.payments)
  if (err) return fail(res, err, 400)
  if (b.tip !== undefined && !isMoney(b.tip)) return fail(res, 'La propina no es válida', 400)
  if (b.deliveryFee !== undefined && b.deliveryFee !== null && b.deliveryFee !== '' && !isMoney(b.deliveryFee)) return fail(res, 'El valor del domicilio no es válido', 400)
  let discount = null
  if (Number(b.discountId)) {
    const { data: d } = await supabase.from('discounts').select('*').eq('id', Number(b.discountId)).maybeSingle()
    if (!d || !d.active) return fail(res, 'El descuento no existe o está inactivo', 400)
    if (d.requires_reason && !clean(b.discountReason)) return fail(res, `Escribe el motivo del descuento "${d.name}"`, 400)
    discount = { id: d.id, name: d.name, type: d.type, value: Number(d.value), reason: clean(b.discountReason) }
  }
  const session = await pickSession(req, o.site_id, b.sessionId)
  // Venta a crédito de un cliente del directorio: sus datos y su plazo completan la cuenta por cobrar.
  if (b.receivable && o.customer_id) {
    const { data: c } = await supabase.from('customers').select('name, doc, phone, credit_days').eq('id', o.customer_id).maybeSingle()
    if (c) {
      b.receivable = { ...b.receivable, customerName: clean(b.receivable.customerName) || c.name, customerDoc: clean(b.receivable.customerDoc) || c.doc, customerPhone: clean(b.receivable.customerPhone) || c.phone }
      if (!clean(b.receivable.dueDate) && c.credit_days) b.receivable.dueDate = new Date(Date.now() + c.credit_days * 864e5).toISOString().slice(0, 10)
    }
  }
  const payments = b.payments.map((p) => ({ method: p.method, amount: money(p.amount), received: p.method === 'efectivo' && isMoney(p.received) && p.received !== '' ? money(p.received) : null, reference: clean(p.reference) }))
  // Cuenta dividida entre personas (TD-014): cada pago dice de quién es y las partes deben cuadrar.
  let split = null
  if (b.split) {
    const r = validateSplit(b.split, b.payments, o)
    if (r.error) return fail(res, r.error, 400)
    split = r
  }
  const { data, error } = await supabase.rpc('charge_order', {
    p: {
      org_id: req.user.org_id, order_id: o.id, session_id: session?.id ?? null, user_id: req.user.id, tip: money(b.tip), discount, payments,
      ...(o.type === 'domicilio' && b.deliveryFee !== undefined ? { delivery_fee: money(b.deliveryFee) } : {}),
      receivable: b.receivable ? { customer_name: clean(b.receivable.customerName), customer_doc: clean(b.receivable.customerDoc), customer_phone: clean(b.receivable.customerPhone), due_date: clean(b.receivable.dueDate), note: clean(b.receivable.note) } : null
    }
  })
  if (error) return dbError(res, error)
  if (split) await saveSplit(o.id, split)
  await audit(req, 'cobrar', 'pedido', o.id, { number: o.number, total: Number(data.total), tip: money(b.tip), discount: discount?.name ?? null, methods: payments.map((p) => p.method), session: session?.id ?? null, deliveryFee: Number(data.deliveryFee || 0), ...(split ? { split: split.split.label, persons: split.split.persons.map((p) => `${p.name}: ${p.amount}`) } : {}) })
  res.send({ ...orderDTO(await loadOrder(o.id)), change: Number(data.change || 0), receivable: data.receivable })
}))

// ---------------------------------------------------------------- Comandas (cocina, bar, barista)
router.get('/comandas', auth(STAFF), guard(...KITCHEN, 'mesero'), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const mine = (req.user.positions || []).map((p) => AREA_OF_POSITION[p]).filter(Boolean)
  const area = ['cocina', 'bar', 'barista'].includes(req.query.area) ? req.query.area : null
  const areas = area ? [area] : (ADMIN.includes(req.user.role) || !mine.length ? ['cocina', 'bar', 'barista'] : mine)
  const since = new Date(Date.now() - 16 * 3600e3).toISOString()
  const { data, error } = await supabase.from('order_items')
    .select('id, name, quantity, note, area, status, courtesy, created_at, started_at, ready_at, order:orders!inner(id, number, site_id, status, type, alias, customer_name, table:dining_tables!orders_table_id_fkey(name), waiter:users!orders_waiter_id_fkey(name, last_name))')
    .in('area', areas).in('status', req.query.listos === '1' ? ['listo'] : ['pendiente', 'preparando', 'listo'])
    .eq('order.site_id', site).eq('order.status', 'abierto').gte('created_at', since).order('created_at')
  if (error) throw error
  const groups = new Map()
  for (const i of data) {
    const key = `${i.order.id}-${i.area}`
    if (!groups.has(key)) groups.set(key, { orderId: i.order.id, number: i.order.number, area: i.area, table: i.order.table?.name ?? null, alias: i.order.alias, type: TYPES[i.order.type], customer: i.order.customer_name, waiter: fullName(i.order.waiter), since: i.created_at, items: [] })
    groups.get(key).items.push({ id: i.id, name: i.name, quantity: Number(i.quantity), note: i.note, status: i.status, courtesy: i.courtesy, createdAt: i.created_at, startedAt: i.started_at, readyAt: i.ready_at })
  }
  res.send({ areas, tickets: [...groups.values()] })
}))

router.put('/comandas/:itemId', auth(STAFF), guard(...KITCHEN, 'mesero'), h(async (req, res) => {
  const status = req.body?.status
  if (!['preparando', 'listo', 'entregado', 'pendiente'].includes(status)) return fail(res, 'Estado no válido', 400)
  const ids = (Array.isArray(req.body?.ids) && req.body.ids.length ? req.body.ids : [req.params.itemId]).map(Number).filter(Boolean)
  const { data: items } = await supabase.from('order_items').select('id, status, order:orders!inner(site_id, status)').in('id', ids)
  const ok = (items || []).filter((i) => i.status !== 'anulado' && i.order.status === 'abierto' && sameSite(req, i.order.site_id))
  if (!ok.length) return fail(res, 'No hay productos para actualizar', 404)
  const now = new Date().toISOString()
  const patch = { status, ...(status === 'preparando' ? { started_at: now } : status === 'listo' ? { ready_at: now } : status === 'entregado' ? { delivered_at: now } : {}) }
  const { error } = await supabase.from('order_items').update(patch).in('id', ok.map((i) => i.id))
  if (error) throw error
  res.send({ ok: true, updated: ok.length })
}))

module.exports = router
module.exports.validatePayments = validatePayments
module.exports.TYPES = TYPES
module.exports.addToTable = addToTable
module.exports.buildItems = buildItems
