// =====================================================================
// Buscador inteligente: una sola caja busca usuarios, sucursales, bodegas y pantallas del sistema.
// Ignora tildes y mayúsculas. Cada etapa agrega sus fuentes (productos, mesas, órdenes por número…).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')

const router = express.Router()
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
// Texto seguro para un filtro ilike de PostgREST.
const safe = (s) => String(s).replace(/[%,()*\\]/g, ' ').trim()

router.get('/buscar', auth(STAFF), h(async (req, res) => {
  const raw = String(req.query.q || '').trim()
  if (raw.length < 2) return res.send({ q: raw, groups: [] })
  const q = safe(raw)
  const admin = ADMIN.includes(req.user.role)
  const groups = { usuarios: [], sucursales: [], bodegas: [] }
  const jobs = []
  if (admin) {
    jobs.push(supabase.from('users').select('id, name, last_name, username, identification, role')
      .or(`name.ilike.%${q}%,last_name.ilike.%${q}%,username.ilike.%${q}%,identification.ilike.%${q}%`).limit(6)
      .then(({ data }) => (data || []).forEach((u) => groups.usuarios.push({ id: u.id, title: `${u.name} ${u.last_name || ''}`.trim(), subtitle: `@${u.username} · ${u.identification}`, to: `/usuarios?id=${u.id}` }))))
    jobs.push(supabase.from('sites').select('id, name, city').or(`name.ilike.%${q}%,city.ilike.%${q}%`).limit(4)
      .then(({ data }) => (data || []).forEach((s) => groups.sucursales.push({ id: s.id, title: s.name, subtitle: s.city || 'Sucursal', to: '/sucursales' }))))
    jobs.push(supabase.from('warehouses').select('id, name').ilike('name', `%${q}%`).limit(4)
      .then(({ data }) => (data || []).forEach((w) => groups.bodegas.push({ id: w.id, title: w.name, subtitle: 'Bodega', to: '/sucursales' }))))
  }
  await Promise.all(jobs)
  // En cada grupo, primero lo que empieza igual que la búsqueda.
  const f = fold(raw)
  const LABELS = { usuarios: 'Usuarios', sucursales: 'Sucursales', bodegas: 'Bodegas' }
  res.send({
    q: raw,
    groups: Object.entries(groups).filter(([, items]) => items.length).map(([key, items]) => ({
      key, label: LABELS[key], items: items.sort((a, b) => Number(fold(b.title).startsWith(f)) - Number(fold(a.title).startsWith(f)))
    }))
  })
}))

module.exports = router
module.exports.fold = fold
module.exports.safe = safe
