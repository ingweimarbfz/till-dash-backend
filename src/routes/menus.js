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
const { buildMenu, menuDTO, menuAppliesAt, clock, qrOptionsAt, ownQrOf, orderMode, QR_COLUMNS } = require('../menu')

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
// Generales (app_settings) o de una sucursal (?sucursal= / body.siteId, TD-025). La sucursal sin opciones
// propias usa las generales; con body.useGeneral vuelve a usarlas.
const optionsDTO = (o) => ({ ...o, mode: orderMode(o) })
const siteOf = async (v) => {
  const id = Number(v) || null
  if (!id) return { id: null }
  const { data } = await supabase.from('sites').select('id').eq('id', id).maybeSingle()
  return data ? { id } : { error: 'La sucursal no existe' }
}
router.get('/cartas/opciones', auth(STAFF), h(async (req, res) => {
  const site = await siteOf(req.query.sucursal)
  if (site.error) return fail(res, site.error, 404)
  const { data } = await supabase.from('app_settings').select(QR_COLUMNS).maybeSingle()
  const { options, own } = await qrOptionsAt(site.id, data)
  res.send({ ...optionsDTO(options), siteId: site.id, own, qrModule: await plan.orgHas(req.user.org_id, 'carta_qr') })
}))
router.put('/cartas/opciones', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!(await plan.orgHas(req.user.org_id, 'carta_qr'))) return fail(res, 'Tu plan no incluye la carta por QR. Pide un cambio en "Mi plan".', 403)
  const site = await siteOf(b.siteId)
  if (site.error) return fail(res, site.error, 404)
  const o = ownQrOf({ ...b, directCategories: ids(b.directCategories) })
  if (site.id && b.useGeneral) {
    const { error } = await supabase.from('sites').update({ qr_options: null }).eq('id', site.id)
    if (error) throw error
    await audit(req, 'editar', 'opciones_qr', site.id, { site: site.id, general: true })
    const { options } = await qrOptionsAt(site.id)
    return res.send({ ...optionsDTO(options), siteId: site.id, own: false, qrModule: true })
  }
  if (o.orderConfirm && o.orderDirect && !o.directCategories.length) return fail(res, 'Con las dos formas de pedir activas, elige qué categorías van directo a cocina y bar', 400)
  if (site.id) {
    const { error } = await supabase.from('sites').update({ qr_options: o }).eq('id', site.id)
    if (error) throw error
  } else {
    const row = {
      qr_call_waiter: o.callWaiter, qr_request_bill: o.requestBill, qr_bill_view: o.billView,
      qr_order_confirm: o.orderConfirm, qr_order_direct: o.orderDirect, qr_direct_categories: o.directCategories,
      // Compatibilidad con la opción anterior (una sola forma).
      qr_ordering: o.orderDirect && !o.orderConfirm ? 'directo' : o.orderConfirm ? 'confirmar' : 'llamar'
    }
    const { error } = await supabase.from('app_settings').update(row).eq('org_id', currentOrg())
    if (error) throw error
  }
  await audit(req, 'editar', 'opciones_qr', site.id, { site: site.id, callWaiter: o.callWaiter, requestBill: o.requestBill, billView: o.billView, confirm: o.orderConfirm, direct: o.orderDirect })
  res.send({ ...optionsDTO(o), siteId: site.id, own: Boolean(site.id), qrModule: true })
}))

module.exports = router
