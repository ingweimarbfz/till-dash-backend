// =====================================================================
// Sucursales y bodegas
// · Cada establecimiento nace con una "Sede principal" y una "Bodega principal" (trigger en la base).
// · Las bodegas de sucursal pertenecen a una sucursal; la principal es de todo el establecimiento.
// · El stock por bodega, los traslados y las alertas de stock bajo están en routes/inventory.js.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, PHONE_RE } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()

const siteDTO = (s) => ({
  id: s.id, name: s.name, city: s.city, address: s.address, phone: s.phone, isMain: s.is_main, active: s.active,
  warehouses: (s.warehouses || []).map(whDTO).sort((a, b) => a.name.localeCompare(b.name))
})
const whDTO = (w) => ({ id: w.id, siteId: w.site_id, name: w.name, description: w.description, responsible: w.responsible, isMain: w.is_main, active: w.active })
const dup = (e, what) => (e?.code === '23505' ? `Ya existe ${what} con ese nombre` : null)

router.get('/sedes', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('sites').select('*, warehouses(*)').order('is_main', { ascending: false }).order('name')
  if (req.query.activas) q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(siteDTO))
}))

const siteRow = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre de la sucursal es requerido')
  if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) errors.push('Teléfono no válido (7 a 10 dígitos)')
  return { errors, row: { name: clean(b.name), city: clean(b.city), address: clean(b.address), phone: clean(b.phone), active: b.active !== false } }
}

router.post('/sedes', auth(ADMIN), h(async (req, res) => {
  const { errors, row } = siteRow(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('sites').insert(row).select('*, warehouses(*)').single()
  if (error) return dup(error, 'una sucursal') ? fail(res, dup(error, 'una sucursal'), 409) : fail(res, error)
  // Cada sucursal nueva arranca con su propia bodega.
  if (req.body?.createWarehouse !== false) {
    await supabase.from('warehouses').insert({ site_id: data.id, name: `Bodega ${data.name}` })
  }
  await audit(req, 'crear', 'sucursal', data.id, { name: data.name })
  const { data: full } = await supabase.from('sites').select('*, warehouses(*)').eq('id', data.id).single()
  res.status(201).send(siteDTO(full))
}))

router.put('/sedes/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { errors, row } = siteRow(req.body || {})
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data: cur } = await supabase.from('sites').select('id, is_main').eq('id', id).maybeSingle()
  if (!cur) return fail(res, 'Sucursal no encontrada', 404)
  if (cur.is_main && !row.active) return fail(res, 'La sede principal no se puede desactivar', 400)
  const { data, error } = await supabase.from('sites').update(row).eq('id', id).select('*, warehouses(*)').single()
  if (error) return dup(error, 'una sucursal') ? fail(res, dup(error, 'una sucursal'), 409) : fail(res, error)
  await audit(req, 'editar', 'sucursal', id, { name: data.name, active: data.active })
  res.send(siteDTO(data))
}))

const whRow = async (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre de la bodega es requerido')
  const siteId = Number(b.siteId) || null
  if (siteId) {
    const { data } = await supabase.from('sites').select('id').eq('id', siteId).maybeSingle()
    if (!data) errors.push('La sucursal no existe')
  }
  return { errors, row: { name: clean(b.name), description: clean(b.description), responsible: clean(b.responsible), site_id: siteId, active: b.active !== false } }
}

router.get('/bodegas', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('warehouses').select('*').order('is_main', { ascending: false }).order('name')
  if (req.siteId) q = q.or(`site_id.eq.${req.siteId},is_main.eq.true`)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(whDTO))
}))

router.post('/bodegas', auth(ADMIN), h(async (req, res) => {
  const { errors, row } = await whRow(req.body || {})
  if (!row.site_id) errors.push('Elige la sucursal de la bodega')
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('warehouses').insert(row).select('*').single()
  if (error) return dup(error, 'una bodega') ? fail(res, dup(error, 'una bodega'), 409) : fail(res, error)
  await audit(req, 'crear', 'bodega', data.id, { name: data.name, site: data.site_id })
  res.status(201).send(whDTO(data))
}))

router.put('/bodegas/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { data: cur } = await supabase.from('warehouses').select('id, is_main').eq('id', id).maybeSingle()
  if (!cur) return fail(res, 'Bodega no encontrada', 404)
  const { errors, row } = await whRow(req.body || {})
  if (cur.is_main) { row.site_id = null; if (!row.active) errors.push('La bodega principal no se puede desactivar') } else if (!row.site_id) errors.push('Elige la sucursal de la bodega')
  if (!row.active && !cur.is_main) {
    const { count } = await supabase.from('warehouse_stock').select('product_id', { count: 'exact', head: true }).eq('warehouse_id', id).gt('stock', 0)
    if (count) errors.push('La bodega tiene existencias: trasládalas antes de desactivarla')
  }
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('warehouses').update(row).eq('id', id).select('*').single()
  if (error) return dup(error, 'una bodega') ? fail(res, dup(error, 'una bodega'), 409) : fail(res, error)
  await audit(req, 'editar', 'bodega', id, { name: data.name, active: data.active })
  res.send(whDTO(data))
}))

module.exports = router
