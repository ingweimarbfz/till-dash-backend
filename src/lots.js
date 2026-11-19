// =====================================================================
// Vencimientos por lote (TD-016)
// · Cada entrada con fecha de vencimiento crea o suma a un lote (stock_lots: bodega + producto + fecha).
// · La base de datos descuenta las salidas por FEFO (primero lo que vence primero) y bloquea vender
//   lo que solo queda vencido (migración 20261119000022). Aquí se arma lo que ve la gente:
//   el tablero de próximos a vencer, la recomendación de qué hacer con cada lote y el aviso por producto.
// =====================================================================
const supabase = require('./db')
const { todayBogota } = require('./http')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v) => DATE_RE.test(v || '') && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime()) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v
const daysBetween = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 864e5)

// Qué tan urgente es un lote: vencido, vence en 3 días o menos, dentro de la ventana de aviso, o al día.
const URGENT_DAYS = 3
const statusOf = (days, windowDays) => (days < 0 ? 'vencido' : days <= URGENT_DAYS ? 'urgente' : days <= windowDays ? 'proximo' : 'ok')

// Recomendación para el lote (en el sistema y en la bodega física).
// first: es el lote vigente que vence primero en esa bodega (el que debe ir adelante en el estante).
const adviceFor = (status, first) => {
  if (status === 'vencido') return { action: 'baja', text: 'Retíralo del estante, sepáralo como vencido y dalo de baja. El sistema no deja venderlo.' }
  if (status === 'urgente') return { action: 'promocion', text: 'Ponlo adelante y véndelo ya: ofrécelo en promoción, como recomendado del día o en un combo.' }
  if (status === 'proximo') return { action: 'adelante', text: first ? 'Va adelante en el estante: es lo próximo que se vende.' : 'Detrás del lote que vence antes; revísalo en el conteo.' }
  return { action: 'ninguna', text: first ? 'Va adelante en el estante.' : 'Al día.' }
}

const LOT_SELECT = 'id, warehouse_id, product_id, expires_on, quantity, received, unit_cost, ref, created_at, product:products(id, name, sku, unit, cost, price, active, category:product_categories(name, emoji)), warehouse:warehouses(id, name, is_main, site:sites(name))'

// Ventana de aviso del negocio (días antes del vencimiento).
const alertWindow = async () => {
  const { data } = await supabase.from('app_settings').select('expiry_alert_days').maybeSingle()
  return Number(data?.expiry_alert_days) || 15
}

const lotDTO = (l, today, windowDays, first = false) => {
  const days = daysBetween(today, l.expires_on)
  const status = statusOf(days, windowDays)
  const quantity = Number(l.quantity)
  const cost = l.unit_cost === null || l.unit_cost === undefined ? Number(l.product?.cost || 0) : Number(l.unit_cost)
  return {
    id: l.id, expiresOn: l.expires_on, days, status, first, quantity, received: Number(l.received), ref: l.ref, createdAt: l.created_at,
    unitCost: cost, costValue: Math.round(quantity * cost), saleValue: Math.round(quantity * Number(l.product?.price || 0)),
    product: l.product ? { id: l.product.id, name: l.product.name, sku: l.product.sku, unit: l.product.unit, price: Number(l.product.price), category: l.product.category?.name ?? null, emoji: l.product.category?.emoji ?? null } : null,
    warehouse: l.warehouse ? { id: l.warehouse.id, name: l.warehouse.name, isMain: l.warehouse.is_main, site: l.warehouse.site?.name ?? null } : null,
    advice: adviceFor(status, first)
  }
}

// Marca, por bodega y producto, el lote vigente que vence primero (el que va adelante).
const markFirst = (lots, today) => {
  const seen = new Set()
  return [...lots].sort((a, b) => a.expires_on.localeCompare(b.expires_on) || a.id - b.id).map((l) => {
    const k = `${l.warehouse_id}-${l.product_id}`
    const first = l.expires_on >= today && !seen.has(k)
    if (first) seen.add(k)
    return { l, first }
  })
}

// Lotes con existencias (opcional: solo de ciertas bodegas, de un producto o hasta una fecha).
const loadLots = async ({ warehouseIds = null, productId = null, until = null } = {}) => {
  let q = supabase.from('stock_lots').select(LOT_SELECT).gt('quantity', 0).order('expires_on').order('id')
  if (warehouseIds) q = q.in('warehouse_id', warehouseIds.length ? warehouseIds : [0])
  if (productId) q = q.eq('product_id', productId)
  if (until) q = q.lte('expires_on', until)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

const addDays = (day, n) => new Date(new Date(`${day}T12:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10)

// Tablero de próximos a vencer: lo vencido y lo que vence dentro de la ventana (días).
const expiryBoard = async ({ warehouseIds = null, days = null } = {}) => {
  const today = todayBogota()
  const windowDays = days || await alertWindow()
  const all = await loadLots({ warehouseIds })
  const marked = markFirst(all, today)
  const rows = marked.map(({ l, first }) => lotDTO(l, today, windowDays, first)).filter((r) => r.status !== 'ok')
  const sum = (list, k) => list.reduce((a, r) => a + r[k], 0)
  const by = (s) => rows.filter((r) => r.status === s)
  return {
    today, windowDays, urgentDays: URGENT_DAYS,
    summary: {
      expired: { lots: by('vencido').length, costValue: sum(by('vencido'), 'costValue'), saleValue: sum(by('vencido'), 'saleValue') },
      urgent: { lots: by('urgente').length, costValue: sum(by('urgente'), 'costValue'), saleValue: sum(by('urgente'), 'saleValue') },
      soon: { lots: by('proximo').length, costValue: sum(by('proximo'), 'costValue'), saleValue: sum(by('proximo'), 'saleValue') },
      products: new Set(rows.map((r) => r.product?.id)).size,
      trackedLots: all.length
    },
    rows: rows.sort((a, b) => a.days - b.days || (a.product?.name || '').localeCompare(b.product?.name || ''))
  }
}

// Por producto: la fecha más próxima de lo vigente en las bodegas dadas (para el aviso al vender).
const nearestByProduct = async (warehouseIds = null) => {
  const today = todayBogota()
  const windowDays = await alertWindow()
  const lots = await loadLots({ warehouseIds, until: addDays(today, windowDays) }).catch(() => [])
  const m = new Map()
  for (const l of lots) {
    const days = daysBetween(today, l.expires_on)
    const cur = m.get(l.product_id) || { expiredQty: 0 }
    if (days < 0) cur.expiredQty += Number(l.quantity)
    else if (cur.expiresOn === undefined) Object.assign(cur, { expiresOn: l.expires_on, days, quantity: Number(l.quantity), status: statusOf(days, windowDays) })
    m.set(l.product_id, cur)
  }
  return m
}

module.exports = { isDate, daysBetween, statusOf, adviceFor, markFirst, lotDTO, loadLots, expiryBoard, nearestByProduct, alertWindow, addDays, URGENT_DAYS }
