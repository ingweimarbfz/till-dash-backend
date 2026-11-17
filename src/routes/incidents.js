// =====================================================================
// Incidentes (TD-003): platos o vasos rotos, daños de equipos o del local, faltantes, accidentes y quejas.
// · Cualquier empleado reporta; queda con consecutivo IN-, costo estimado y responsable (opcional).
// · El administrador o el cajero lo resuelve o lo descarta con una nota.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { notify, incidentMessage } = require('../notify')
const { can, workSite, sameSite, money, isMoney, fullName } = require('../ops')

const router = express.Router()

const TYPES = { rotura: 'Rotura', dano: 'Daño', faltante: 'Faltante', accidente: 'Accidente', queja: 'Queja de cliente', otro: 'Otro' }
const STATUS = { abierto: 'Abierto', resuelto: 'Resuelto', descartado: 'Descartado' }
const COLUMNS = '*, site:sites(name), product:products(name), responsible:users!incidents_responsible_id_fkey(name, last_name), reporter:users!incidents_reported_by_fkey(name, last_name), resolver:users!incidents_resolved_by_fkey(name, last_name)'

const dto = (i) => ({
  id: i.id, number: i.number, siteId: i.site_id, site: i.site?.name ?? null, type: i.type, typeLabel: TYPES[i.type], title: i.title, description: i.description,
  cost: Number(i.cost), quantity: i.quantity === null ? null : Number(i.quantity), productId: i.product_id, product: i.product?.name ?? null,
  responsibleId: i.responsible_id, responsible: fullName(i.responsible), chargeToResponsible: i.charge_to_responsible,
  status: i.status, statusLabel: STATUS[i.status], resolution: i.resolution, occurredAt: i.occurred_at,
  reportedBy: fullName(i.reporter), reportedById: i.reported_by, resolvedBy: fullName(i.resolver), resolvedAt: i.resolved_at, createdAt: i.created_at
})
const load = async (id) => (await supabase.from('incidents').select(COLUMNS).eq('id', Number(id)).maybeSingle()).data
const manager = (user) => can(user, 'cajero')

const fields = (b) => {
  const type = TYPES[b.type] ? b.type : null
  if (!type) return { error: 'Elige el tipo de incidente' }
  const title = clean(b.title)
  if (!title || title.length < 3) return { error: 'Describe en pocas palabras qué pasó' }
  if (b.cost !== undefined && b.cost !== '' && b.cost !== null && !isMoney(b.cost)) return { error: 'El costo no es válido' }
  const occurred = b.occurredAt ? new Date(b.occurredAt) : new Date()
  if (Number.isNaN(occurred.getTime()) || occurred > new Date(Date.now() + 5 * 60e3)) return { error: 'La fecha del incidente no es válida' }
  return {
    row: {
      type, title: title.slice(0, 120), description: clean(b.description), cost: money(b.cost),
      quantity: Number(b.quantity) > 0 ? Number(b.quantity) : null, product_id: Number(b.productId) || null,
      responsible_id: Number(b.responsibleId) || null, charge_to_responsible: Boolean(b.chargeToResponsible) && Boolean(Number(b.responsibleId)),
      occurred_at: occurred.toISOString()
    }
  }
}

router.get('/incidentes', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('incidents').select(COLUMNS).order('occurred_at', { ascending: false }).limit(Math.min(Number(req.query.limite) || 100, 300))
  const site = ADMIN.includes(req.user.role) ? req.siteId : req.user.site_id
  if (site) q = q.eq('site_id', site)
  if (STATUS[req.query.estado]) q = q.eq('status', req.query.estado)
  if (TYPES[req.query.tipo]) q = q.eq('type', req.query.tipo)
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) q = q.gte('occurred_at', `${req.query.desde}T00:00:00-05:00`)
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '')) q = q.lte('occurred_at', `${req.query.hasta}T23:59:59-05:00`)
  const f = clean(req.query.q)
  if (f) { const v = f.replace(/[%,()]/g, ''); q = q.or(`number.ilike.%${v}%,title.ilike.%${v}%,description.ilike.%${v}%`) }
  const { data, error } = await q
  if (error) throw error
  const rows = data.map(dto)
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0)
  res.send({
    rows, types: TYPES,
    open: rows.filter((r) => r.status === 'abierto').length,
    costMonth: rows.filter((r) => r.status !== 'descartado' && new Date(r.occurredAt) >= month).reduce((a, r) => a + r.cost, 0)
  })
}))

// Empleados de la sucursal para elegir el responsable.
router.get('/incidentes/personal', auth(STAFF), h(async (req, res) => {
  const site = await workSite(req, req.query.sede)
  const { data, error } = await supabase.from('users').select('id, name, last_name, site_id, role').eq('active', true).in('role', ['empleado', 'admin']).order('name')
  if (error) throw error
  res.send(data.filter((u) => !u.site_id || u.site_id === site).map((u) => ({ id: u.id, name: fullName(u) })))
}))

router.get('/incidentes/:id', auth(STAFF), h(async (req, res) => {
  const i = await load(req.params.id)
  if (!i || !sameSite(req, i.site_id)) return fail(res, 'Incidente no encontrado', 404)
  res.send(dto(i))
}))

router.post('/incidentes', auth(STAFF), h(async (req, res) => {
  const b = req.body || {}
  const f = fields(b)
  if (f.error) return fail(res, f.error, 400)
  const site = await workSite(req, b.siteId)
  const { data: number, error: e1 } = await supabase.rpc('next_consecutive', { p_org: req.user.org_id, p_kind: 'incidente', p_site: site, p_prefix: 'IN-' })
  if (e1) throw e1
  const { data, error } = await supabase.from('incidents').insert({ ...f.row, site_id: site, number, reported_by: req.user.id }).select('id').single()
  if (error) return fail(res, error)
  const i = await load(data.id)
  await audit(req, 'crear', 'incidente', i.id, { number, type: i.type, title: i.title, cost: Number(i.cost) })
  notify('incidentes', () => incidentMessage({ number, type: i.type, typeLabel: TYPES[i.type], title: i.title, cost: Number(i.cost), responsible: fullName(i.responsible), site: i.site?.name, siteId: i.site_id, user: req.user }))
  res.status(201).send(dto(i))
}))

// Editar: quien lo reportó mientras siga abierto, o el administrador / cajero.
router.put('/incidentes/:id', auth(STAFF), h(async (req, res) => {
  const i = await load(req.params.id)
  if (!i || !sameSite(req, i.site_id)) return fail(res, 'Incidente no encontrado', 404)
  if (!manager(req.user) && !(i.reported_by === req.user.id && i.status === 'abierto')) return fail(res, 'Solo quien lo reportó o el administrador pueden editarlo', 403)
  const f = fields({ ...dto(i), ...req.body })
  if (f.error) return fail(res, f.error, 400)
  const { error } = await supabase.from('incidents').update(f.row).eq('id', i.id)
  if (error) return fail(res, error)
  await audit(req, 'editar', 'incidente', i.id, { number: i.number })
  res.send(dto(await load(i.id)))
}))

// Resolver, descartar o reabrir.
router.post('/incidentes/:id/estado', auth(STAFF), h(async (req, res) => {
  if (!manager(req.user)) return fail(res, 'Tu cargo no permite cerrar incidentes', 403)
  const i = await load(req.params.id)
  if (!i || !sameSite(req, i.site_id)) return fail(res, 'Incidente no encontrado', 404)
  const status = STATUS[req.body?.status] ? req.body.status : null
  if (!status) return fail(res, 'Elige el estado', 400)
  const resolution = clean(req.body.resolution)
  if (status !== 'abierto' && !resolution) return fail(res, 'Escribe cómo se resolvió o por qué se descarta', 400)
  const patch = status === 'abierto' ? { status, resolution: null, resolved_by: null, resolved_at: null } : { status, resolution, resolved_by: req.user.id, resolved_at: new Date().toISOString() }
  const { error } = await supabase.from('incidents').update(patch).eq('id', i.id)
  if (error) return fail(res, error)
  await audit(req, status === 'abierto' ? 'reabrir' : status === 'resuelto' ? 'resolver' : 'descartar', 'incidente', i.id, { number: i.number, resolution })
  res.send(dto(await load(i.id)))
}))

module.exports = router
