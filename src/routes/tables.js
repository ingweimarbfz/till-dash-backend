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
const { runAsOrg } = require('../tenant')
const { workSite, sameSite, fullName, cashOpenAt } = require('../ops')
const { bestFor, promoBrief, loadActive } = require('../promo')
const { notify, callMessage } = require('../notify')

const router = express.Router()
const SHAPES = ['cuadrada', 'redonda', 'barra']
const CALLS = { mesero: 'Llamar al mesero', cuenta: 'Pedir la cuenta' }

const areaDTO = (a) => ({ id: a.id, siteId: a.site_id, name: a.name, sortOrder: a.sort_order, active: a.active })
const tableDTO = (t) => ({ id: t.id, siteId: t.site_id, areaId: t.area_id, name: t.name, seats: t.seats, shape: t.shape, sortOrder: t.sort_order, qrToken: t.qr_token, active: t.active })
const callDTO = (c) => ({ id: c.id, tableId: c.table_id, table: c.table?.name, kind: c.kind, label: CALLS[c.kind], note: c.note, status: c.status, createdAt: c.created_at })

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
      status: !o ? 'libre' : o.bill_requested_at ? 'por_cobrar' : 'ocupada',
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
  const { data, error } = await supabase.from('dining_tables').insert(rows).select('*')
  if (error) return error.code === '23505' ? fail(res, 'Ya existe una mesa con ese nombre en la sucursal', 409) : fail(res, error)
  await audit(req, 'crear', 'mesa', data.length === 1 ? data[0].id : null, { names: data.map((t) => t.name) })
  res.status(201).send(data.map(tableDTO))
}))
router.put('/mesas/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.name)) return fail(res, 'Escribe el nombre o número de la mesa', 400)
  const patch = { ...tableRow(b), active: b.active !== false }
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
    await supabase.from('table_calls').update({ status: 'atendido', attended_by: req.user.id, attended_at: new Date().toISOString() }).eq('id', c.id)
  }
  res.send({ ok: true })
}))

// ---------------------------------------------------------------- Carta pública (QR)
const publicTable = async (token) => {
  if (!/^[0-9a-f]{8,40}$/i.test(token || '')) return null
  const { data } = await supabase.from('dining_tables').select('id, org_id, site_id, name, active, site:sites(name, active), org:organizations(status)').eq('qr_token', token).maybeSingle()
  if (!data || !data.active || !data.site?.active || ['suspendida', 'cancelada'].includes(data.org?.status)) return null
  return data
}

router.get('/carta/:token', h(async (req, res) => {
  const t = await publicTable(req.params.token)
  if (!t) return fail(res, 'Este código QR ya no está activo. Pide ayuda al personal.', 404)
  await runAsOrg(t.org_id, async () => {
    const { data: wh } = await supabase.rpc('sale_warehouse', { p_site: t.site_id })
    const [{ data: s }, { data: cats }, { data: prods }, { data: stock }, promos, { data: order }, { data: calls }] = await Promise.all([
      supabase.from('app_settings').select('business_name, short_name, slogan, logo_url, color_primary, color_secondary, color_accent, font_family, social').maybeSingle(),
      supabase.from('product_categories').select('id, name, emoji, color, description, sort_order').eq('active', true).eq('show_in_menu', true).order('sort_order').order('name'),
      supabase.from('products').select('id, name, description, price, photo_url, category_id, track_stock, unit').eq('active', true).eq('show_in_menu', true).order('name'),
      supabase.from('warehouse_stock').select('product_id, stock').eq('warehouse_id', wh || 0),
      loadActive(),
      supabase.from('orders').select('number, total, tip, bill_requested_at, items:order_items(name, quantity, unit_price, courtesy, status)').eq('table_id', t.id).eq('status', 'abierto').maybeSingle(),
      supabase.from('table_calls').select('kind, created_at').eq('table_id', t.id).eq('status', 'pendiente')
    ])
    const left = new Map((stock || []).map((x) => [x.product_id, Number(x.stock)]))
    const products = (prods || []).map((p) => {
      const best = bestFor(promos, p)
      return {
        id: p.id, name: p.name, description: p.description, photoUrl: p.photo_url, categoryId: p.category_id, unit: p.unit,
        price: Number(p.price), finalPrice: best ? best.price : Number(p.price), promo: best ? promoBrief(best.promo, best.price, Number(p.price)) : null,
        soldOut: p.track_stock && !(left.get(p.id) > 0)
      }
    })
    res.send({
      business: s ? { name: s.business_name, shortName: s.short_name, slogan: s.slogan, logoUrl: s.logo_url, primary: s.color_primary, secondary: s.color_secondary, accent: s.color_accent, font: s.font_family, social: s.social } : null,
      table: { name: t.name, site: t.site?.name },
      categories: (cats || []).filter((c) => products.some((p) => p.categoryId === c.id)).map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, color: c.color, description: c.description })),
      products,
      order: order ? {
        number: order.number, total: Number(order.total), billRequested: Boolean(order.bill_requested_at),
        items: (order.items || []).filter((i) => i.status !== 'anulado').map((i) => ({ name: i.name, quantity: Number(i.quantity), price: Number(i.unit_price), courtesy: i.courtesy, status: i.status }))
      } : null,
      calls: (calls || []).map((c) => c.kind)
    })
  })
}))

router.post('/carta/:token/llamar', h(async (req, res) => {
  const t = await publicTable(req.params.token)
  if (!t) return fail(res, 'Este código QR ya no está activo. Pide ayuda al personal.', 404)
  const kind = CALLS[req.body?.kind] ? req.body.kind : 'mesero'
  await runAsOrg(t.org_id, async () => {
    const note = clean(req.body?.note)?.slice(0, 140) ?? null
    const { error } = await supabase.from('table_calls').insert({ site_id: t.site_id, table_id: t.id, kind, note })
    if (error && error.code !== '23505') throw error
    if (!error) notify('mesas', () => callMessage({ table: t.name, kind, note, site: t.site?.name, siteId: t.site_id }))
    if (kind === 'cuenta') await supabase.from('orders').update({ bill_requested_at: new Date().toISOString() }).eq('table_id', t.id).eq('status', 'abierto').is('bill_requested_at', null)
    res.status(error ? 200 : 201).send({ ok: true, message: kind === 'cuenta' ? 'Listo, ya le avisamos al personal que quieres la cuenta.' : 'Listo, tu mesero viene en camino.' })
  })
}))

module.exports = router
module.exports.CALLS = CALLS
