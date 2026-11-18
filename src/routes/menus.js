// =====================================================================
// Módulo Carta (TD-004)
// · Todo el personal ve la carta tal como la ve el cliente (por sucursal y por carta).
// · El administrador arma las cartas: secciones y su orden, destacados, productos ocultos,
//   presentación, sucursales y horario.
// · Opciones del QR: llamar al mesero, pedir la cuenta, pedir con confirmación y pedir directo.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, imageError } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const plan = require('../plan')
const { currentOrg } = require('../tenant')
const { buildMenu, menuDTO, menuAppliesAt, clock, qrOptionsOf, orderMode } = require('../menu')

const router = express.Router()
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]

// Carta tal como la ve el cliente. ?carta=<id> para ver una en particular; sin ella, la que aplica ahora.
router.get('/cartas/vista', auth(STAFF), h(async (req, res) => {
  let site = req.siteId || req.user.site_id || null
  if (!site) {
    const { data } = await supabase.from('sites').select('id').eq('active', true).order('is_main', { ascending: false }).order('id').limit(1).maybeSingle()
    site = data?.id || null
  }
  const m = await buildMenu({ siteId: site, menuId: Number(req.query.carta) || null })
  res.send({ ...m, siteId: site })
}))

router.get('/cartas', auth(STAFF), h(async (req, res) => {
  const [{ data, error }, { data: s }] = await Promise.all([
    supabase.from('menus').select('*').order('sort_order').order('id'),
    supabase.from('app_settings').select('timezone').maybeSingle()
  ])
  if (error) throw error
  const c = clock(s?.timezone)
  const site = req.siteId || req.user.site_id || null
  const firstNow = (data || []).find((m) => menuAppliesAt(m, site, c))
  res.send({ rows: (data || []).map((m) => ({ ...menuDTO(m), now: firstNow?.id === m.id })) })
}))

const menuRow = async (b) => {
  const name = clean(b.name)
  if (!name || name.length < 2) return { error: 'Escribe el nombre de la carta' }
  for (const k of ['timeFrom', 'timeTo']) if (b[k] && !TIME_RE.test(b[k])) return { error: 'La hora no es válida' }
  if (Boolean(b.timeFrom) !== Boolean(b.timeTo)) return { error: 'Escribe la hora de inicio y la de fin, o deja ambas vacías' }
  const days = ids((b.days || []).map((d) => Number(d) + 1)).map((d) => d - 1).filter((d) => d >= 0 && d <= 6)
  if (!days.length) return { error: 'Elige al menos un día' }
  const img = imageError(b.coverUrl, 1500)
  if (img) return { error: img }
  return {
    row: {
      name: name.slice(0, 80), title: clean(b.title)?.slice(0, 80) ?? null, welcome: clean(b.welcome)?.slice(0, 300) ?? null, cover_url: clean(b.coverUrl),
      layout: b.layout === 'cuadricula' ? 'cuadricula' : 'lista', show_photos: b.showPhotos !== false, show_descriptions: b.showDescriptions !== false,
      sold_out: b.soldOut === 'ocultar' ? 'ocultar' : 'marcar', footer_note: clean(b.footerNote)?.slice(0, 200) ?? null,
      site_ids: ids(b.siteIds), days: days.sort(), time_from: b.timeFrom || null, time_to: b.timeTo || null,
      category_ids: ids(b.categoryIds), featured_ids: ids(b.featuredIds).slice(0, 12), hidden_product_ids: ids(b.hiddenProductIds),
      active: b.active !== false, sort_order: Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0, updated_at: new Date().toISOString()
    }
  }
}
router.post('/cartas', auth(ADMIN), h(async (req, res) => {
  const { row, error: e } = await menuRow(req.body || {})
  if (e) return fail(res, e, 400)
  const { data, error } = await supabase.from('menus').insert({ ...row, created_by: req.user.id }).select('*').single()
  if (error) throw error
  await audit(req, 'crear', 'carta', data.id, { name: data.name })
  res.status(201).send(menuDTO(data))
}))
router.put('/cartas/:id(\\d+)', auth(ADMIN), h(async (req, res) => {
  const { row, error: e } = await menuRow(req.body || {})
  if (e) return fail(res, e, 400)
  const { data, error } = await supabase.from('menus').update(row).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Carta no encontrada', 404)
  await audit(req, 'editar', 'carta', data.id, { name: data.name, active: data.active })
  res.send(menuDTO(data))
}))
router.delete('/cartas/:id(\\d+)', auth(ADMIN), h(async (req, res) => {
  const { data } = await supabase.from('menus').delete().eq('id', Number(req.params.id)).select('id, name').maybeSingle()
  if (!data) return fail(res, 'Carta no encontrada', 404)
  await audit(req, 'eliminar', 'carta', data.id, { name: data.name })
  res.send({ ok: true })
}))

// ---------------------------------------------------------------- Opciones del QR
const optionsDTO = (s) => { const o = qrOptionsOf(s); return { ...o, mode: orderMode(o) } }
router.get('/cartas/opciones', auth(STAFF), h(async (req, res) => {
  const { data } = await supabase.from('app_settings').select('qr_ordering, qr_call_waiter, qr_request_bill, qr_order_confirm, qr_order_direct, qr_direct_categories').maybeSingle()
  res.send({ ...optionsDTO(data), qrModule: await plan.orgHas(req.user.org_id, 'carta_qr') })
}))
router.put('/cartas/opciones', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!(await plan.orgHas(req.user.org_id, 'carta_qr'))) return fail(res, 'Tu plan no incluye la carta por QR. Pide un cambio en "Mi plan".', 403)
  const row = {
    qr_call_waiter: b.callWaiter !== false, qr_request_bill: b.requestBill !== false,
    qr_order_confirm: Boolean(b.orderConfirm), qr_order_direct: Boolean(b.orderDirect),
    qr_direct_categories: ids(b.directCategories)
  }
  if (row.qr_order_confirm && row.qr_order_direct && !row.qr_direct_categories.length) return fail(res, 'Con las dos formas de pedir activas, elige qué categorías van directo a cocina y bar', 400)
  // Compatibilidad con la opción anterior (una sola forma).
  row.qr_ordering = row.qr_order_direct && !row.qr_order_confirm ? 'directo' : row.qr_order_confirm ? 'confirmar' : 'llamar'
  const { data, error } = await supabase.from('app_settings').update(row).eq('org_id', currentOrg()).select('qr_ordering, qr_call_waiter, qr_request_bill, qr_order_confirm, qr_order_direct, qr_direct_categories').single()
  if (error) throw error
  await audit(req, 'editar', 'opciones_qr', null, { callWaiter: row.qr_call_waiter, requestBill: row.qr_request_bill, confirm: row.qr_order_confirm, direct: row.qr_order_direct })
  res.send({ ...optionsDTO(data), qrModule: true })
}))

module.exports = router
