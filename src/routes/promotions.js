// =====================================================================
// Descuentos y promociones (TD-002, modelo de QuontUp360)
// · Descuento: porcentaje o valor fijo que se aplica al total de un pedido al cobrar, con ícono y color.
//   Puede exigir que quien lo aplica escriba el motivo.
// · Promoción: precio especial automático por producto, categoría o toda la carta, vigente por fechas,
//   franja horaria (happy hour, también cruzando la medianoche) y días de la semana. src/promo.js decide
//   cuál aplica; si varias aplican al mismo producto, gana la que deja el precio más bajo.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { statusOf, hm } = require('../promo')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/

// ---------------------------------------------------------------- Descuentos
const DISCOUNT_ICONS = ['tag', 'star', 'heart', 'gift', 'handshake', 'cake', 'trophy', 'fire', 'percent', 'user', 'beer', 'party']
const discountDTO = (d) => ({
  id: d.id, name: d.name, type: d.type, value: Number(d.value), icon: d.icon, color: d.color, description: d.description,
  requiresReason: d.requires_reason, active: d.active
})
const discountRow = (b) => ({
  name: clean(b.name), type: b.type, value: Number(b.value), icon: DISCOUNT_ICONS.includes(b.icon) ? b.icon : 'tag',
  color: COLOR_RE.test(b.color || '') ? b.color : '#E4572E', description: clean(b.description), requires_reason: Boolean(b.requiresReason), active: b.active !== false
})
const validateDiscount = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!['porcentaje', 'valor'].includes(b.type)) errors.push('Tipo inválido')
  if (!(Number(b.value) > 0)) errors.push('El valor debe ser mayor que cero')
  if (b.type === 'porcentaje' && Number(b.value) > 100) errors.push('El porcentaje no puede superar 100')
  return errors
}
router.get('/descuentos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('discounts').select('*').order('name')
  if (req.query.activos === '1') q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(discountDTO))
}))
router.post('/descuentos', auth(ADMIN), h(async (req, res) => {
  const errors = validateDiscount(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('discounts').insert(discountRow(req.body)).select().single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un descuento con ese nombre', 409) : fail(res, error)
  await audit(req, 'crear', 'descuento', data.id, { name: data.name, type: data.type, value: Number(data.value) })
  res.status(201).send(discountDTO(data))
}))
router.put('/descuentos/:id', auth(ADMIN), h(async (req, res) => {
  const errors = validateDiscount(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('discounts').update(discountRow(req.body)).eq('id', Number(req.params.id)).select().maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un descuento con ese nombre', 409) : fail(res, error)
  if (!data) return fail(res, 'Descuento no encontrado', 404)
  await audit(req, 'editar', 'descuento', data.id, { name: data.name, active: data.active })
  res.send(discountDTO(data))
}))

// ---------------------------------------------------------------- Promociones
const STATUS_LABEL = { vigente: 'Vigente', programada: 'Programada', fuera_de_horario: 'Fuera de horario', vencida: 'Vencida', inactiva: 'Inactiva' }
const promotionDTO = (p, cats = [], prods = []) => {
  const status = statusOf(p)
  return {
    id: p.id, name: p.name, tag: p.tag, emoji: p.emoji, color: p.color, description: p.description, type: p.type, value: Number(p.value),
    startsAt: p.starts_at, endsAt: p.ends_at, timeFrom: hm(p.time_from), timeTo: hm(p.time_to), weekdays: p.weekdays || [],
    scope: p.scope, categoryIds: (p.category_ids || []).map(Number), productIds: (p.product_ids || []).map(Number),
    categories: (p.category_ids || []).map((id) => cats.find((c) => c.id === Number(id))?.name).filter(Boolean),
    products: (p.product_ids || []).map((id) => prods.find((x) => x.id === Number(id))?.name).filter(Boolean),
    active: p.active, status, statusLabel: STATUS_LABEL[status], createdAt: p.created_at
  }
}
const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))]
const validatePromotion = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!['porcentaje', 'valor'].includes(b.type)) errors.push('Tipo inválido')
  if (!(Number(b.value) > 0)) errors.push('El valor debe ser mayor que cero')
  if (b.type === 'porcentaje' && Number(b.value) > 100) errors.push('El porcentaje no puede superar 100')
  if (clean(b.tag) && clean(b.tag).length > 24) errors.push('La etiqueta admite máximo 24 caracteres')
  if (clean(b.emoji) && [...clean(b.emoji)].length > 4) errors.push('Elige un solo emoji')
  const s = clean(b.startsAt); const e = clean(b.endsAt)
  if (s && isNaN(Date.parse(s))) errors.push('Fecha de inicio inválida')
  if (e && isNaN(Date.parse(e))) errors.push('Fecha de fin inválida')
  if (s && e && Date.parse(e) <= Date.parse(s)) errors.push('La promoción debe terminar después de empezar')
  const tf = clean(b.timeFrom); const tt = clean(b.timeTo)
  if (Boolean(tf) !== Boolean(tt)) errors.push('Indica la hora de inicio y la de fin de la franja diaria')
  if (tf && tt && tf === tt) errors.push('La franja diaria debe tener horas distintas')
  if (!['todos', 'categorias', 'productos'].includes(b.scope || 'todos')) errors.push('Alcance inválido')
  if (b.scope === 'categorias' && !ids(b.categoryIds).length) errors.push('Elige al menos una categoría')
  if (b.scope === 'productos' && !ids(b.productIds).length) errors.push('Elige al menos un producto')
  return errors
}
// Fechas con hora de Colombia (datetime-local llega sin zona).
const atBogota = (v) => (clean(v) ? (/[zZ]|[+-]\d\d:\d\d$/.test(v) ? new Date(v).toISOString() : new Date(`${v.length === 16 ? `${v}:00` : v}-05:00`).toISOString()) : null)
const promotionRow = (b) => ({
  name: clean(b.name), tag: clean(b.tag)?.toUpperCase() ?? null, emoji: clean(b.emoji), description: clean(b.description),
  color: COLOR_RE.test(b.color || '') ? b.color : '#E4572E', type: b.type, value: Number(b.value),
  starts_at: atBogota(b.startsAt), ends_at: atBogota(b.endsAt), time_from: clean(b.timeFrom), time_to: clean(b.timeTo),
  weekdays: ids(b.weekdays).filter((d) => d <= 7), scope: b.scope || 'todos',
  category_ids: b.scope === 'categorias' ? ids(b.categoryIds) : [], product_ids: b.scope === 'productos' ? ids(b.productIds) : [],
  active: b.active !== false, updated_at: new Date().toISOString()
})
const catalogs = async () => {
  const [{ data: cats }, { data: prods }] = await Promise.all([supabase.from('product_categories').select('id, name'), supabase.from('products').select('id, name')])
  return [cats || [], prods || []]
}
router.get('/promociones', auth(STAFF), h(async (req, res) => {
  const [{ data, error }, [cats, prods]] = await Promise.all([supabase.from('promotions').select('*').order('created_at', { ascending: false }), catalogs()])
  if (error) throw error
  const order = { vigente: 0, fuera_de_horario: 1, programada: 2, vencida: 3, inactiva: 4 }
  res.send(data.map((p) => promotionDTO(p, cats, prods)).sort((a, b) => order[a.status] - order[b.status]))
}))
router.post('/promociones', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validatePromotion(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('promotions').insert({ ...promotionRow(b), created_by: req.user.id }).select().single()
  if (error) throw error
  await audit(req, 'crear', 'promocion', data.id, { name: data.name, tag: data.tag })
  res.status(201).send(promotionDTO(data, ...(await catalogs())))
}))
router.put('/promociones/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validatePromotion(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('promotions').update(promotionRow(b)).eq('id', Number(req.params.id)).select().maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Promoción no encontrada', 404)
  await audit(req, 'editar', 'promocion', data.id, { name: data.name, active: data.active })
  res.send(promotionDTO(data, ...(await catalogs())))
}))
// Una promoción que ya se usó en pedidos no se borra (quedaría sin rastro en los reportes): se desactiva.
router.delete('/promociones/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { count } = await supabase.from('order_items').select('id', { count: 'exact', head: true }).eq('promotion_id', id)
  if (count) return fail(res, `La promoción ya se usó en ${count} producto${count === 1 ? '' : 's'} vendido${count === 1 ? '' : 's'}: desactívala en lugar de eliminarla`, 409)
  const { data } = await supabase.from('promotions').delete().eq('id', id).select('id, name').maybeSingle()
  if (!data) return fail(res, 'Promoción no encontrada', 404)
  await audit(req, 'eliminar', 'promocion', id, { name: data.name })
  res.status(204).end()
}))

module.exports = router
module.exports.atBogota = atBogota
module.exports.validatePromotion = validatePromotion
