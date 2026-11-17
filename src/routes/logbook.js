// =====================================================================
// Bitácora del sistema: todo lo que queda en audit_log, con filtros por fecha, usuario, sucursal,
// módulo (entidad) y acción. Paginada; el total va en la cabecera X-Total-Count.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail } = require('../http')
const { auth, ADMIN } = require('../auth')
const { TZ } = require('../config')

const router = express.Router()
const ISO = /^\d{4}-\d{2}-\d{2}$/

// Inicio de un día de Colombia en UTC (Colombia no tiene horario de verano: UTC-5).
const dayStart = (d) => new Date(`${d}T00:00:00-05:00`).toISOString()
const nextDay = (d) => new Date(new Date(`${d}T00:00:00-05:00`).getTime() + 86400000).toISOString()

const LABELS = {
  login: 'Inició sesión', cambio_perfil: 'Cambió de perfil', cambio_contrasena: 'Cambió su contraseña',
  crear: 'Creó', editar: 'Editó', eliminar: 'Eliminó', anular: 'Anuló'
}

router.get('/bitacora', auth(ADMIN), h(async (req, res) => {
  const { desde, hasta, usuario, entidad, accion } = req.query
  if ((desde && !ISO.test(desde)) || (hasta && !ISO.test(hasta))) return fail(res, 'Fechas con formato AAAA-MM-DD', 400)
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const page = Math.max(Number(req.query.pagina) || 1, 1)
  let q = supabase.from('audit_log')
    .select('id, action, entity, entity_id, detail, ip, created_at, site_id, user:users(id, name, last_name, username, role)', { count: 'exact' })
    .order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1)
  if (desde) q = q.gte('created_at', dayStart(desde))
  if (hasta) q = q.lt('created_at', nextDay(hasta))
  if (Number(usuario)) q = q.eq('user_id', Number(usuario))
  if (entidad) q = q.eq('entity', String(entidad))
  if (accion) q = q.eq('action', String(accion))
  if (req.siteId) q = q.eq('site_id', req.siteId)
  const { data, error, count } = await q
  if (error) throw error
  res.set('X-Total-Count', String(count || 0))
  res.send(data.map((a) => ({
    id: a.id, action: a.action, actionLabel: LABELS[a.action] || a.action, entity: a.entity, entityId: a.entity_id,
    detail: a.detail, ip: a.ip, createdAt: a.created_at, siteId: a.site_id,
    user: a.user ? { id: a.user.id, fullName: `${a.user.name} ${a.user.last_name || ''}`.trim(), username: a.user.username, role: a.user.role } : null
  })))
}))

// Valores para los filtros (entidades y acciones que existen en la bitácora del establecimiento).
router.get('/bitacora/filtros', auth(ADMIN), h(async (req, res) => {
  const { data, error } = await supabase.from('audit_log').select('entity, action').order('created_at', { ascending: false }).limit(2000)
  if (error) throw error
  res.send({
    entities: [...new Set(data.map((r) => r.entity))].sort(),
    actions: [...new Set(data.map((r) => r.action))].sort().map((a) => ({ key: a, label: LABELS[a] || a })),
    timezone: TZ
  })
}))

module.exports = router
module.exports.dayStart = dayStart
module.exports.nextDay = nextDay
