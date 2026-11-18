// =====================================================================
// Alertas de stock bajo (TD-002)
// · Una bodega está "baja" en un producto cuando su existencia llega al mínimo del producto o por debajo
//   (si el mínimo es 0, solo cuando se agota).
// · Después de cada movimiento se revisan las bodegas y productos tocados: lo que acaba de quedar bajo
//   se avisa una sola vez por Telegram (warehouse_stock.low_alerted) y lo repuesto se rearma.
// · Los avisos tipo toast los pide el navegador a /inventario/alertas cada minuto.
// =====================================================================
const supabase = require('./db')
const { notify, lowStockMessage } = require('./notify')

const isLow = (stock, min) => Number(stock) <= Number(min) && (Number(min) > 0 || Number(stock) <= 0)

const STOCK_SELECT = 'warehouse_id, product_id, stock, low_alerted, updated_at, product:products(id, name, unit, min_stock, track_stock, active), warehouse:warehouses(id, name, is_main, site_id, site:sites(name))'

const toAlert = (r) => ({
  warehouseId: r.warehouse_id, productId: r.product_id, name: r.product.name, unit: r.product.unit,
  stock: Number(r.stock), minStock: Number(r.product.min_stock), out: Number(r.stock) <= 0, updatedAt: r.updated_at,
  warehouse: { id: r.warehouse.id, name: r.warehouse.name, isMain: r.warehouse.is_main, siteId: r.warehouse.site_id, site: r.warehouse.site?.name ?? null }
})

// pairs: [{ warehouseId, productId }]
const checkLowStock = async (pairs) => {
  const whs = [...new Set(pairs.map((p) => Number(p.warehouseId)))]
  const prods = [...new Set(pairs.map((p) => Number(p.productId)))]
  if (!whs.length || !prods.length) return []
  const { data, error } = await supabase.from('warehouse_stock').select(STOCK_SELECT).in('warehouse_id', whs).in('product_id', prods)
  if (error) throw error
  const fresh = []
  for (const r of data || []) {
    if (!pairs.some((p) => Number(p.warehouseId) === r.warehouse_id && Number(p.productId) === r.product_id)) continue
    const low = r.product?.track_stock && r.product?.active && isLow(r.stock, r.product.min_stock)
    if (low && !r.low_alerted) fresh.push(r)
    if (Boolean(low) !== r.low_alerted) {
      await supabase.from('warehouse_stock').update({ low_alerted: Boolean(low) }).eq('warehouse_id', r.warehouse_id).eq('product_id', r.product_id)
    }
  }
  // Un mensaje por bodega con todo lo que acaba de quedar bajo.
  const byWh = new Map()
  for (const r of fresh) byWh.set(r.warehouse_id, [...(byWh.get(r.warehouse_id) || []), toAlert(r)])
  for (const rows of byWh.values()) notify('inventario', async () => lowStockMessage(rows))
  return fresh.map(toAlert)
}

// Todo lo que está bajo ahora en las bodegas dadas (null = todas).
const currentAlerts = async (warehouseIds = null) => {
  let q = supabase.from('warehouse_stock').select(STOCK_SELECT)
  if (warehouseIds) q = q.in('warehouse_id', warehouseIds.length ? warehouseIds : [0])
  const { data, error } = await q
  if (error) throw error
  return (data || [])
    .filter((r) => r.product?.track_stock && r.product?.active && isLow(r.stock, r.product.min_stock))
    .map(toAlert)
    .sort((a, b) => Number(b.out) - Number(a.out) || a.name.localeCompare(b.name))
}

module.exports = { isLow, checkLowStock, currentAlerts }
