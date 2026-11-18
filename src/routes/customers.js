// =====================================================================
// Clientes (TD-010): directorio de clientes frecuentes, pensado para distribuidoras que llevan el pedido
// a tiendas, licoreras, bares y personas. Cada cliente tiene dirección, zona de reparto, valor del domicilio,
// forma de pago habitual y plazo de crédito; se ve su historial de compras y su saldo por cobrar.
// · Lo leen los vendedores (mesero, cajero, anfitrión…) y el domiciliario; lo editan los vendedores y el admin.
// · No se borra: se desactiva (sus pedidos lo siguen nombrando).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { guard, sameSite, money, isMoney, fullName } = require('../ops')

const router = express.Router()

const SELLERS = ['mesero', 'cajero', 'host', 'bartender', 'barista']
const KINDS = { persona: 'Persona', tienda: 'Tienda', licorera: 'Licorera', bar: 'Bar', restaurante: 'Restaurante', minimercado: 'Minimercado', empresa: 'Empresa', otro: 'Otro' }
const PAY = ['efectivo', 'tarjeta', 'transferencia', 'nequi', 'daviplata', 'otro']
const like = (v) => clean(v)?.replace(/[%,()*]/g, '').slice(0, 60)
const phoneKey = (v) => (clean(v) ? String(v).replace(/\D/g, '') : null)

const customerDTO = (c) => ({
  id: c.id, siteId: c.site_id, name: c.name, kind: c.kind, kindLabel: KINDS[c.kind] || c.kind, doc: c.doc, contact: c.contact, phone: c.phone, phone2: c.phone2,
  address: c.address, neighborhood: c.neighborhood, city: c.city, zone: c.zone, deliveryFee: c.delivery_fee === null ? null : Number(c.delivery_fee),
  payMethod: c.pay_method, creditDays: c.credit_days, notes: c.notes, active: c.active, createdAt: c.created_at
})

// Valida y arma la fila a guardar. Devuelve { row } o { error }.
const rowFrom = (b, partial = false) => {
  const row = {}
  const put = (key, col, fn = clean) => { if (!partial || key in b) row[col] = fn(b[key]) }
  if (!partial || 'name' in b) {
    if (!clean(b.name)) return { error: 'Escribe el nombre del cliente' }
    row.name = clean(b.name).slice(0, 120)
  }
  if (!partial || 'kind' in b) row.kind = KINDS[b.kind] ? b.kind : 'persona'
  for (const [k, c] of [['doc', 'doc'], ['contact', 'contact'], ['phone', 'phone'], ['phone2', 'phone2'], ['address', 'address'], ['neighborhood', 'neighborhood'], ['city', 'city'], ['notes', 'notes']]) put(k, c)
  if (!partial || 'zone' in b) row.zone = clean(b.zone) ? clean(b.zone).slice(0, 60) : null
  if (!partial || 'deliveryFee' in b) {
    if (b.deliveryFee !== undefined && b.deliveryFee !== null && b.deliveryFee !== '' && !isMoney(b.deliveryFee)) return { error: 'El valor del domicilio no es válido' }
    row.delivery_fee = b.deliveryFee === undefined || b.deliveryFee === null || b.deliveryFee === '' ? null : money(b.deliveryFee)
  }
  if (!partial || 'payMethod' in b) row.pay_method = PAY.includes(b.payMethod) ? b.payMethod : null
  if (!partial || 'creditDays' in b) {
    const d = b.creditDays === undefined || b.creditDays === null || b.creditDays === '' ? null : Number(b.creditDays)
    if (d !== null && !(Number.isInteger(d) && d >= 0 && d <= 365)) return { error: 'El plazo de crédito va de 0 a 365 días' }
    row.credit_days = d
  }
  if ('siteId' in b) row.site_id = Number(b.siteId) || null
  if ('active' in b) row.active = b.active !== false
  return { row }
}

// Otro cliente activo con el mismo celular (para no duplicar).
const samePhone = async (phone, exceptId = 0) => {
  const key = phoneKey(phone)
  if (!key || key.length < 7) return null
  const { data } = await supabase.from('customers').select('id, name, phone').eq('active', true).neq('id', exceptId).ilike('phone', `%${key.slice(-7)}%`).limit(10)
  return (data || []).find((c) => phoneKey(c.phone) === key) || null
}

// Crea un cliente (también desde "Guardar como cliente" al abrir un pedido).
const createCustomer = async (req, body) => {
  const { row, error } = rowFrom(body)
  if (error) return { error }
  const dup = await samePhone(row.phone)
  if (dup) return { error: `Ya existe el cliente ${dup.name} con el celular ${dup.phone}. Búscalo en la lista.`, status: 409 }
  const { data, error: e } = await supabase.from('customers').insert({ ...row, site_id: row.site_id ?? null, created_by: req.user.id }).select('*').single()
  if (e) throw e
  await audit(req, 'crear', 'cliente', data.id, { name: data.name })
  return { customer: data }
}

// Cliente elegido al abrir un pedido (customerId). { customer } | { error, status } | {}.
const customerFromBody = async (req, b, siteId) => {
  if (!Number(b.customerId)) return {}
  const { data: c } = await supabase.from('customers').select('*').eq('id', Number(b.customerId)).maybeSingle()
  if (!c || !c.active) return { error: 'El cliente no existe o está inactivo', status: 404 }
  if (c.site_id && siteId && c.site_id !== Number(siteId)) return { error: 'El cliente es de otra sucursal', status: 400 }
  return { customer: c }
}

// Compras y saldo por cobrar de varios clientes.
const statsFor = async (ids) => {
  const out = new Map(ids.map((id) => [id, { orders: 0, bought: 0, lastOrderAt: null, open: 0, owed: 0 }]))
  if (!ids.length) return out
  const [{ data: orders }, { data: cxc }] = await Promise.all([
    supabase.from('orders').select('customer_id, status, total, opened_at').in('customer_id', ids).neq('status', 'anulado'),
    supabase.from('receivables').select('amount, paid, order:orders!inner(customer_id)').eq('status', 'pendiente').in('order.customer_id', ids)
  ])
  for (const o of orders || []) {
    const s = out.get(o.customer_id)
    if (!s) continue
    if (o.status === 'cobrado') { s.orders++; s.bought += Number(o.total) }
    if (o.status === 'abierto') s.open++
    if (!s.lastOrderAt || o.opened_at > s.lastOrderAt) s.lastOrderAt = o.opened_at
  }
  for (const r of cxc || []) {
    const s = out.get(r.order?.customer_id)
    if (s) s.owed += Number(r.amount) - Number(r.paid)
  }
  return out
}

// ---------------------------------------------------------------- Lista y búsqueda
router.get('/clientes', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const limit = Math.min(Number(req.query.limite) || 200, 500)
  let q = supabase.from('customers').select('*').order('name').limit(limit)
  if (req.query.inactivos !== '1') q = q.eq('active', true)
  const term = like(req.query.q)
  if (term) {
    const digits = term.replace(/\D/g, '')
    q = q.or([`name.ilike.%${term}%`, `doc.ilike.%${term}%`, `address.ilike.%${term}%`, `neighborhood.ilike.%${term}%`, `contact.ilike.%${term}%`, ...(digits.length >= 3 ? [`phone.ilike.%${digits}%`] : [])].join(','))
  }
  if (clean(req.query.zona)) q = q.eq('zone', clean(req.query.zona))
  if (!ADMIN.includes(req.user.role) && req.user.site_id) q = q.or(`site_id.is.null,site_id.eq.${req.user.site_id}`)
  else if (req.siteId) q = q.or(`site_id.is.null,site_id.eq.${req.siteId}`)
  const { data, error } = await q
  if (error) throw error
  const light = req.query.ligero === '1'
  const stats = light ? new Map() : await statsFor((data || []).map((c) => c.id))
  res.set('X-Total-Count', String((data || []).length))
  res.send((data || []).map((c) => ({ ...customerDTO(c), ...(stats.get(c.id) || {}) })))
}))

// Zonas de reparto usadas (para filtros y sugerencias).
router.get('/clientes/zonas', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const { data, error } = await supabase.from('customers').select('zone').eq('active', true).not('zone', 'is', null)
  if (error) throw error
  const count = {}
  for (const r of data || []) count[r.zone] = (count[r.zone] || 0) + 1
  res.send(Object.entries(count).sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([zone, customers]) => ({ zone, customers })))
}))

// ---------------------------------------------------------------- Detalle: datos, pedidos y cuentas por cobrar
router.get('/clientes/:id(\\d+)', auth(STAFF), guard(...SELLERS, 'domiciliario'), h(async (req, res) => {
  const { data: c } = await supabase.from('customers').select('*').eq('id', Number(req.params.id)).maybeSingle()
  if (!c || (c.site_id && !sameSite(req, c.site_id))) return fail(res, 'Cliente no encontrado', 404)
  const [{ data: orders }, { data: cxc }, stats] = await Promise.all([
    supabase.from('orders').select('id, number, type, status, total, opened_at, closed_at, delivery_status, waiter:users!orders_waiter_id_fkey(name, last_name), items:order_items(name, quantity, status)')
      .eq('customer_id', c.id).order('opened_at', { ascending: false }).limit(40),
    supabase.from('receivables').select('id, number, amount, paid, status, due_date, created_at, order:orders!inner(id, number, customer_id)').eq('order.customer_id', c.id).neq('status', 'anulada').order('created_at', { ascending: false }).limit(40),
    statsFor([c.id])
  ])
  // Lo que más compra (de sus últimos pedidos cobrados).
  const top = {}
  for (const o of (orders || []).filter((x) => x.status === 'cobrado')) for (const i of o.items || []) if (i.status !== 'anulado') top[i.name] = (top[i.name] || 0) + Number(i.quantity)
  res.send({
    ...customerDTO(c), ...stats.get(c.id),
    topProducts: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, quantity]) => ({ name, quantity })),
    orders: (orders || []).map((o) => ({ id: o.id, number: o.number, type: o.type, status: o.status, total: Number(o.total), openedAt: o.opened_at, closedAt: o.closed_at, deliveryStatus: o.delivery_status, seller: fullName(o.waiter), items: (o.items || []).filter((i) => i.status !== 'anulado').length })),
    receivables: (cxc || []).map((r) => ({ id: r.id, number: r.number, order: r.order?.number, orderId: r.order?.id, amount: Number(r.amount), paid: Number(r.paid), balance: Number(r.amount) - Number(r.paid), status: r.status, dueDate: r.due_date, createdAt: r.created_at, overdue: r.status === 'pendiente' && r.due_date && r.due_date < new Date().toISOString().slice(0, 10) }))
  })
}))

// ---------------------------------------------------------------- Crear y editar
router.post('/clientes', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const b = req.body || {}
  const made = await createCustomer(req, { ...b, siteId: ADMIN.includes(req.user.role) ? b.siteId : (b.siteId === null ? null : req.user.site_id) })
  if (made.error) return fail(res, made.error, made.status || 400)
  res.status(201).send(customerDTO(made.customer))
}))

router.put('/clientes/:id(\\d+)', auth(STAFF), guard(...SELLERS), h(async (req, res) => {
  const { data: cur } = await supabase.from('customers').select('*').eq('id', Number(req.params.id)).maybeSingle()
  if (!cur || (cur.site_id && !sameSite(req, cur.site_id))) return fail(res, 'Cliente no encontrado', 404)
  const b = req.body || {}
  if ('active' in b && !ADMIN.includes(req.user.role)) return fail(res, 'Solo el administrador activa o desactiva clientes', 403)
  if ('siteId' in b && !ADMIN.includes(req.user.role)) delete b.siteId
  const { row, error } = rowFrom(b, true)
  if (error) return fail(res, error, 400)
  if (!Object.keys(row).length) return fail(res, 'No hay cambios', 400)
  if (row.phone && (row.active ?? cur.active)) {
    const dup = await samePhone(row.phone, cur.id)
    if (dup) return fail(res, `Ya existe el cliente ${dup.name} con el celular ${dup.phone}`, 409)
  }
  const { data, error: e } = await supabase.from('customers').update({ ...row, updated_at: new Date().toISOString() }).eq('id', cur.id).select('*').single()
  if (e) throw e
  await audit(req, 'active' in row && row.active !== cur.active ? (row.active ? 'activar' : 'desactivar') : 'editar', 'cliente', cur.id, { name: data.name })
  res.send(customerDTO(data))
}))

module.exports = router
module.exports.customerFromBody = customerFromBody
module.exports.createCustomer = createCustomer
module.exports.customerDTO = customerDTO
module.exports.rowFrom = rowFrom
