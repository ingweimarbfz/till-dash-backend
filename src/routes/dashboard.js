// =====================================================================
// Dashboard por rol: usuarios, sucursales, bodegas, actividad, productos y stock bajo (etapa 2);
// la etapa 3 le suma pedidos por atender, mesas, caja, ventas y llamados.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, todayBogota } = require('../http')
const { auth } = require('../auth')
const { dayStart } = require('./logbook')
const { currentAlerts } = require('../stock')

const router = express.Router()

const count = async (table, f = (q) => q) => (await f(supabase.from(table).select('id', { count: 'exact', head: true }))).count || 0

router.get('/dashboard', auth(), h(async (req, res) => {
  const { role } = req.user
  const today = todayBogota()
  if (role === 'superadmin' || role === 'admin') {
    const site = (q) => (req.siteId ? q.eq('site_id', req.siteId) : q)
    let whs = null
    if (req.siteId) whs = ((await supabase.from('warehouses').select('id').eq('site_id', req.siteId)).data || []).map((w) => w.id)
    const [users, employees, sites, warehouses, activityToday, recent, products, alerts] = await Promise.all([
      count('users', (q) => site(q.eq('active', true))),
      count('users', (q) => site(q.eq('active', true).eq('role', 'empleado'))),
      count('sites', (q) => q.eq('active', true)),
      count('warehouses', (q) => q.eq('active', true)),
      count('audit_log', (q) => site(q.gte('created_at', dayStart(today)))),
      site(supabase.from('audit_log').select('id, action, entity, created_at, user:users(name, last_name)')
        .order('created_at', { ascending: false }).limit(8)),
      count('products', (q) => q.eq('active', true)),
      currentAlerts(whs)
    ])
    return res.send({
      role,
      kpis: { users, employees, sites, warehouses, activityToday, products, lowStock: alerts.filter((a) => !a.out).length, outOfStock: alerts.filter((a) => a.out).length },
      alerts: alerts.slice(0, 8),
      recent: (recent.data || []).map((a) => ({ id: a.id, action: a.action, entity: a.entity, createdAt: a.created_at, user: a.user ? `${a.user.name} ${a.user.last_name || ''}`.trim() : null })),
      // Se llenan en la etapa 3.
      upcoming: ['Pedidos por atender', 'Mesas abiertas', 'Caja del turno', 'Ventas del día', 'Llamados de mesa']
    })
  }
  if (role === 'empleado') {
    const myToday = await count('audit_log', (q) => q.eq('user_id', req.user.id).gte('created_at', dayStart(today)))
    return res.send({ role, positions: req.user.positions || [], kpis: { myActivityToday: myToday }, site: req.user.site?.name || null })
  }
  res.send({ role })
}))

module.exports = router
