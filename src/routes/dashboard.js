// =====================================================================
// Dashboard por rol. En la etapa 1 muestra lo que ya existe (usuarios, sucursales, bodegas, actividad);
// cada etapa le suma sus indicadores: pedidos por atender, mesas, caja, ventas, stock bajo, llamados.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, todayBogota } = require('../http')
const { auth } = require('../auth')
const { dayStart } = require('./logbook')

const router = express.Router()

const count = async (table, f = (q) => q) => (await f(supabase.from(table).select('id', { count: 'exact', head: true }))).count || 0

router.get('/dashboard', auth(), h(async (req, res) => {
  const { role } = req.user
  const today = todayBogota()
  if (role === 'superadmin' || role === 'admin') {
    const site = (q) => (req.siteId ? q.eq('site_id', req.siteId) : q)
    const [users, employees, sites, warehouses, activityToday, recent] = await Promise.all([
      count('users', (q) => site(q.eq('active', true))),
      count('users', (q) => site(q.eq('active', true).eq('role', 'empleado'))),
      count('sites', (q) => q.eq('active', true)),
      count('warehouses', (q) => q.eq('active', true)),
      count('audit_log', (q) => site(q.gte('created_at', dayStart(today)))),
      site(supabase.from('audit_log').select('id, action, entity, created_at, user:users(name, last_name)')
        .order('created_at', { ascending: false }).limit(8))
    ])
    return res.send({
      role,
      kpis: { users, employees, sites, warehouses, activityToday },
      recent: (recent.data || []).map((a) => ({ id: a.id, action: a.action, entity: a.entity, createdAt: a.created_at, user: a.user ? `${a.user.name} ${a.user.last_name || ''}`.trim() : null })),
      // Se llenan en las etapas 2 y 3.
      upcoming: ['Pedidos por atender', 'Mesas abiertas', 'Caja del turno', 'Ventas del día', 'Stock bajo', 'Llamados de mesa']
    })
  }
  if (role === 'empleado') {
    const myToday = await count('audit_log', (q) => q.eq('user_id', req.user.id).gte('created_at', dayStart(today)))
    return res.send({ role, positions: req.user.positions || [], kpis: { myActivityToday: myToday }, site: req.user.site?.name || null })
  }
  res.send({ role })
}))

module.exports = router
