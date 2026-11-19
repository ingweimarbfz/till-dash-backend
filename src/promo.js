// =====================================================================
// Promociones (TD-002, modelo de QuontUp360): cuál aplica a un producto en un momento dado y a qué precio.
// · Vigencia: rango de fechas y horas (starts_at/ends_at), franja horaria diaria (time_from/time_to)
//   y días de la semana. Cualquiera puede ir vacía; si van varias, deben cumplirse todas.
// · Si varias promociones aplican al mismo producto, gana la que deja el precio más bajo.
// =====================================================================
const supabase = require('./db')

const TZ = 'America/Bogota'
// Partes de la fecha en Colombia: día de la semana (1 lunes … 7 domingo) y hora "HH:MM".
const bogota = (now = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now).map((x) => [x.type, x.value]))
  return { weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1, hm: `${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}` }
}
const hm = (t) => (t ? String(t).slice(0, 5) : null)

// Estado de la promoción: vigente (aplica ya), programada, fuera de horario, vencida o inactiva.
const statusOf = (p, now = new Date()) => {
  if (!p.active) return 'inactiva'
  if (p.ends_at && new Date(p.ends_at) <= now) return 'vencida'
  if (p.starts_at && new Date(p.starts_at) > now) return 'programada'
  const b = bogota(now)
  const days = p.weekdays || []
  if (days.length && !days.includes(b.weekday)) return 'fuera_de_horario'
  const from = hm(p.time_from); const to = hm(p.time_to)
  if (from && to) {
    const inside = from <= to ? b.hm >= from && b.hm < to : b.hm >= from || b.hm < to // franja que cruza la medianoche
    if (!inside) return 'fuera_de_horario'
  }
  return 'vigente'
}

const covers = (p, product) => p.scope === 'todos' ||
  (p.scope === 'categorias' && (p.category_ids || []).map(Number).includes(Number(product.category_id))) ||
  (p.scope === 'productos' && (p.product_ids || []).map(Number).includes(Number(product.id)))

const priceWith = (p, price) => Math.max(0, Math.round(p.type === 'porcentaje' ? price * (1 - Number(p.value) / 100) : price - Number(p.value)))

// Mejor promoción vigente para el producto (o null).
const bestFor = (promos, product, now = new Date()) => {
  let best = null
  for (const p of promos) {
    if (!covers(p, product) || statusOf(p, now) !== 'vigente') continue
    const price = priceWith(p, Number(product.price))
    if (!best || price < best.price) best = { promo: p, price }
  }
  return best
}

const promoBrief = (p, price, listPrice) => ({
  id: p.id, name: p.name, tag: p.tag, emoji: p.emoji, color: p.color, type: p.type, value: Number(p.value),
  endsAt: p.ends_at, timeTo: hm(p.time_to), price, savings: listPrice - price
})

// Promociones activas; con siteId, solo las que aplican en esa sucursal (TD-024: site_ids vacío = todas).
const loadActive = async (siteId = null) => ((await supabase.from('promotions').select('*').eq('active', true)).data || [])
  .filter((p) => !siteId || !(p.site_ids || []).length || p.site_ids.map(Number).includes(Number(siteId)))

module.exports = { statusOf, bestFor, priceWith, promoBrief, loadActive, hm, bogota, covers }
