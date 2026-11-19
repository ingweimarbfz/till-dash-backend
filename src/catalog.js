// =====================================================================
// Catálogo por sucursal (TD-024)
// · site_ids vacío = aplica en todas las sucursales (lo general, compartido). Con sucursales elegidas,
//   el producto, la categoría, la promoción o el descuento solo aplica en ellas.
// · Un producto está disponible en una sucursal si él y su categoría aplican en ella.
// · Precio en la sucursal: el de product_site_prices si existe; si no, el precio general.
// =====================================================================
const supabase = require('./db')

const siteIdsOf = (v) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((x) => Number.isInteger(x) && x > 0))]

// ¿La fila aplica en la sucursal? Sin sucursal (vista de todas) aplica todo.
const inSite = (row, siteId) => !siteId || !(row?.site_ids || []).length || row.site_ids.map(Number).includes(Number(siteId))

// Precios por sucursal de los productos: Map product_id → [{ siteId, price }].
const loadSitePrices = async (productIds = null) => {
  let q = supabase.from('product_site_prices').select('product_id, site_id, price')
  if (productIds) q = q.in('product_id', productIds.length ? productIds : [0])
  const { data, error } = await q
  if (error) throw error
  const map = new Map()
  for (const r of data || []) {
    if (!map.has(r.product_id)) map.set(r.product_id, [])
    map.get(r.product_id).push({ siteId: Number(r.site_id), price: Number(r.price) })
  }
  return map
}

// Precio del producto en la sucursal (con prices = lo que devuelve loadSitePrices).
const priceAt = (p, siteId, prices) => {
  const own = siteId ? (prices.get(p.id) || []).find((x) => x.siteId === Number(siteId)) : null
  return own ? own.price : Number(p.price)
}

// El producto (con category.site_ids) se vende en la sucursal.
const availableAt = (p, siteId) => inSite(p, siteId) && inSite(p.category, siteId)

// Guarda los precios por sucursal del producto: [{ siteId, price }]; los que no vengan se borran.
const saveSitePrices = async (productId, list) => {
  if (!Array.isArray(list)) return
  const rows = list.filter((x) => Number(x?.siteId) > 0 && x.price !== '' && x.price !== null && x.price !== undefined && Number(x.price) >= 0)
    .map((x) => ({ product_id: productId, site_id: Number(x.siteId), price: Math.round(Number(x.price) * 100) / 100, updated_at: new Date().toISOString() }))
  const keep = rows.map((r) => r.site_id)
  let del = supabase.from('product_site_prices').delete().eq('product_id', productId)
  if (keep.length) del = del.not('site_id', 'in', `(${keep.join(',')})`)
  const { error } = await del
  if (error) throw error
  if (rows.length) {
    const { error: e2 } = await supabase.from('product_site_prices').upsert(rows, { onConflict: 'product_id,site_id' })
    if (e2) throw e2
  }
}

// Las sucursales elegidas deben existir en el establecimiento.
const checkSites = async (ids) => {
  if (!ids.length) return null
  const { data } = await supabase.from('sites').select('id').in('id', ids)
  return (data || []).length === ids.length ? null : 'Una de las sucursales elegidas no existe'
}

module.exports = { siteIdsOf, inSite, loadSitePrices, priceAt, availableAt, saveSitePrices, checkSites }
