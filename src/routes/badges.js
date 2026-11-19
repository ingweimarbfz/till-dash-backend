// =====================================================================
// Contadores del menú (TD-023): burbujas con lo que espera atención en cada opción.
// · Comandas: pedidos con productos que aún no se empiezan a preparar (por área del usuario).
// · Mesas: llamados y pedidos QR de las mesas sin atender.
// · Pedidos: cuentas pedidas que aún no se cobran.
// · Domicilios: por despachar (o, para el domiciliario, los suyos que no ha entregado).
// · Caja: solicitudes de recursos y de reapertura de turnos (administrador).
// · Incidentes: incidentes abiertos.
// Solo se cuenta lo que el usuario ve en su menú (rol, cargos y módulos del plan).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { can } = require('../ops')
const plan = require('../plan')

const router = express.Router()

const SELLERS = ['mesero', 'cajero', 'host', 'bartender', 'barista']
const KITCHEN = ['cocina', 'bartender', 'barista']
const AREA_OF_POSITION = { cocina: 'cocina', bartender: 'bar', barista: 'barista' }
const ALL_AREAS = ['cocina', 'bar', 'barista']

// Qué contadores le tocan al usuario. `has` dice si el plan incluye el módulo.
const badgesFor = (user, has = () => true) => {
  const admin = ADMIN.includes(user.role)
  const out = []
  if (has('comandas') && can(user, ...KITCHEN)) out.push('comandas')
  if (has('mesas') && has('carta_qr') && can(user, 'mesero', 'cajero', 'host')) out.push('mesas')
  if (can(user, ...SELLERS)) out.push('pedidos')
  if (has('domicilios') && can(user, ...SELLERS, 'domiciliario')) out.push('domicilios')
  if (admin) out.push('caja')
  if (has('incidentes')) out.push('incidentes')
  return out
}

// Áreas de comanda del usuario (el administrador o quien no tiene cargo de cocina ve todas).
const areasFor = (user) => {
  const mine = (user.positions || []).map((p) => AREA_OF_POSITION[p]).filter(Boolean)
  return ADMIN.includes(user.role) || !mine.length ? ALL_AREAS : mine
}

// Comandas nuevas: un pedido por área con al menos un producto pendiente (como las tarjetas de la pantalla de comandas).
const countTickets = (items) => new Set(items.map((i) => `${i.order_id}-${i.area}`)).size

const bySite = (q, site, column = 'site_id') => (site ? q.eq(column, site) : q)
const count = async (q) => {
  const { count: n, error } = await q
  if (error) throw error
  return n || 0
}

const COUNTERS = {
  comandas: async (req, site) => {
    const since = new Date(Date.now() - 16 * 3600e3).toISOString()
    let q = supabase.from('order_items').select('order_id, area, order:orders!inner(site_id, status)')
      .in('area', areasFor(req.user)).eq('status', 'pendiente').eq('order.status', 'abierto').gte('created_at', since).limit(2000)
    q = bySite(q, site, 'order.site_id')
    const { data, error } = await q
    if (error) throw error
    return countTickets(data || [])
  },
  mesas: (req, site) => count(bySite(supabase.from('table_calls').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'), site)),
  pedidos: (req, site) => count(bySite(supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'abierto').not('bill_requested_at', 'is', null), site)),
  domicilios: (req, site) => {
    let q = supabase.from('orders').select('id', { count: 'exact', head: true }).eq('type', 'domicilio').eq('status', 'abierto')
    if (can(req.user, ...SELLERS)) q = q.or('delivery_status.is.null,delivery_status.eq.por_despachar')
    else q = q.eq('courier_id', req.user.id).or('delivery_status.is.null,delivery_status.neq.entregado')
    return count(bySite(q, site))
  },
  caja: async (req, site) => {
    const [a, b] = await Promise.all([
      count(bySite(supabase.from('cash_requests').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'), site)),
      count(bySite(supabase.from('cash_reopen_requests').select('id', { count: 'exact', head: true }).eq('status', 'pendiente'), site))
    ])
    return a + b
  },
  incidentes: (req, site) => count(bySite(supabase.from('incidents').select('id', { count: 'exact', head: true }).eq('status', 'abierto'), site))
}

// { '/comandas': 3, '/incidentes': 1, ... } — las rutas del menú del frontend.
router.get('/avisos/menu', auth(STAFF), h(async (req, res) => {
  const st = await plan.ensure(req.user.org_id)
  const keys = badgesFor(req.user, (f) => plan.has(st, f))
  // El administrador ve la sucursal elegida (o todas); el empleado, la suya.
  const site = ADMIN.includes(req.user.role) ? req.siteId : req.user.site_id
  if (!ADMIN.includes(req.user.role) && !site) return res.send({})
  const values = await Promise.all(keys.map((k) => COUNTERS[k](req, site).catch(() => 0)))
  res.send(Object.fromEntries(keys.map((k, i) => [`/${k}`, values[i]])))
}))

module.exports = router
module.exports.badgesFor = badgesFor
module.exports.areasFor = areasFor
module.exports.countTickets = countTickets
