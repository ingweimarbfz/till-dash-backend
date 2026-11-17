// =====================================================================
// Catálogo e inventario (TD-002, modelo de QuontUp360)
// · Categorías de la carta y productos, con precio, costo, unidad y foto.
// · Existencias por bodega: la bodega principal abastece a las sucursales y cada sucursal tiene las suyas.
// · Entradas, ajustes y bajas (varios productos a la vez, con un consecutivo), traslados entre bodegas
//   y las ventas (pedidos) descuentan de la bodega de la sucursal.
// · Alertas de stock bajo: toast en el navegador (/inventario/alertas) y Telegram (src/stock.js).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, num, imageError } = require('../http')
const { bestFor, promoBrief, loadActive, statusOf, priceWith, hm, covers } = require('../promo')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const plan = require('../plan')
const { currentOrg } = require('../tenant')
const { notify, movementMessage, transferMessage } = require('../notify')
const { isLow, checkLowStock, currentAlerts } = require('../stock')

const router = express.Router()

const UNITS = { und: 'Unidad', porcion: 'Porción', botella: 'Botella', g: 'Gramos', kg: 'Kilos', ml: 'Mililitros', l: 'Litros' }
const AREAS = { cocina: 'Cocina', bar: 'Bar', barista: 'Barista', ninguna: 'Sin preparación' }
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/
const p0001 = (res, error) => (error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error))
// Cantidades con hasta 3 decimales (gramos, mililitros, kilos).
const qty = (v) => Math.round(Number(v) * 1000) / 1000
const isQty = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v))

const mainWarehouse = async () => (await supabase.from('warehouses').select('id, name, site_id, is_main').eq('is_main', true).maybeSingle()).data

// Bodegas a consultar: ?bodega= una; ?sede= (o la sucursal del empleado) las de esa sucursal; nada = todas.
const warehouseFilter = async (req) => {
  if (Number(req.query.bodega)) return [Number(req.query.bodega)]
  if (req.siteId) {
    const { data } = await supabase.from('warehouses').select('id').eq('site_id', req.siteId)
    return (data || []).map((w) => w.id)
  }
  return null
}

const placeOf = (w) => ({ id: w.id, name: w.name, isMain: w.is_main, siteId: w.site_id, site: w.site?.name ?? null })
const loadPlace = async (id) => {
  const { data } = await supabase.from('warehouses').select('id, name, is_main, site_id, active, site:sites(name)').eq('id', Number(id)).maybeSingle()
  return data
}

// ---------------------------------------------------------------- Categorías
const categoryDTO = (c) => ({
  id: c.id, name: c.name, description: c.description, emoji: c.emoji, color: c.color, area: c.area, areaLabel: AREAS[c.area],
  sortOrder: c.sort_order, showInMenu: c.show_in_menu, active: c.active, products: c.products?.[0]?.count ?? undefined
})
const categoryRow = (b) => ({
  name: clean(b.name), description: clean(b.description), emoji: clean(b.emoji),
  color: COLOR_RE.test(b.color || '') ? b.color : '#E4572E', area: AREAS[b.area] ? b.area : 'cocina',
  sort_order: Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0, show_in_menu: b.showInMenu !== false, active: b.active !== false
})
const validateCategory = (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (clean(b.emoji) && [...clean(b.emoji)].length > 4) errors.push('Elige un solo emoji')
  return errors
}

router.get('/inventario/categorias', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('product_categories').select('*, products(count)').order('sort_order').order('name')
  if (req.query.activas === '1') q = q.eq('active', true)
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(categoryDTO))
}))
router.post('/inventario/categorias', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validateCategory(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('product_categories').insert(categoryRow(b)).select('*').single()
  if (error) return error.code === '23505' ? fail(res, 'Esa categoría ya existe', 409) : fail(res, error)
  await audit(req, 'crear', 'categoria', data.id, { name: data.name })
  res.status(201).send(categoryDTO(data))
}))
router.put('/inventario/categorias/:id', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = validateCategory(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('product_categories').update(categoryRow(b)).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Esa categoría ya existe', 409) : fail(res, error)
  if (!data) return fail(res, 'Categoría no encontrada', 404)
  await audit(req, 'editar', 'categoria', data.id, { name: data.name, active: data.active })
  res.send(categoryDTO(data))
}))

// ---------------------------------------------------------------- Productos
const PRODUCT_COLUMNS = 'id, sku, name, category_id, description, unit, cost, price, track_stock, stock, min_stock, photo_url, show_in_menu, active, category:product_categories(id, name, emoji, color, area)'
// promos: promociones activas; si alguna está vigente para el producto, se informa el precio con promoción.
const productDTO = (p, promos = []) => {
  const best = bestFor(promos, p)
  return {
    id: p.id, sku: p.sku, name: p.name, categoryId: p.category_id, category: p.category?.name ?? null, categoryEmoji: p.category?.emoji ?? null,
    categoryColor: p.category?.color ?? null, area: p.category?.area ?? null, description: p.description, unit: p.unit, unitLabel: UNITS[p.unit],
    cost: Number(p.cost), price: Number(p.price), trackStock: p.track_stock, stock: Number(p.stock), minStock: Number(p.min_stock),
    lowStock: p.track_stock && isLow(p.stock, p.min_stock), photoUrl: p.photo_url, showInMenu: p.show_in_menu, active: p.active,
    promo: best ? promoBrief(best.promo, best.price, Number(p.price)) : null, finalPrice: best ? best.price : Number(p.price),
    ...(p.gallery !== undefined ? { gallery: p.gallery || [] } : {})
  }
}
const validateProduct = async (b) => {
  const errors = []
  if (!clean(b.name)) errors.push('El nombre es requerido')
  if (!Number(b.categoryId)) errors.push('Selecciona la categoría del producto')
  else {
    const { data: c } = await supabase.from('product_categories').select('id, active').eq('id', Number(b.categoryId)).maybeSingle()
    if (!c || !c.active) errors.push('La categoría no existe o está inactiva')
  }
  if (b.unit !== undefined && !UNITS[b.unit]) errors.push('Unidad de medida inválida')
  if (!(Number(b.price) >= 0)) errors.push('Precio de venta inválido')
  if (b.cost !== undefined && b.cost !== '' && !(Number(b.cost) >= 0)) errors.push('Costo inválido')
  if (b.minStock !== undefined && b.minStock !== '' && !(Number(b.minStock) >= 0)) errors.push('Stock mínimo inválido')
  const e = imageError(b.photoUrl, 600); if (e) errors.push(`Foto: ${e}`)
  if (b.gallery !== undefined) {
    if (!Array.isArray(b.gallery) || b.gallery.length > 3) errors.push('Puedes agregar hasta 3 imágenes adicionales')
    else b.gallery.forEach((g, i) => { const ge = imageError(g, 600); if (ge) errors.push(`Imagen adicional ${i + 1}: ${ge}`) })
  }
  return errors
}
const productRow = (b) => ({
  sku: clean(b.sku), name: clean(b.name), category_id: num(b.categoryId), description: clean(b.description), unit: UNITS[b.unit] ? b.unit : 'und',
  cost: Number(b.cost) || 0, price: Number(b.price) || 0, track_stock: b.trackStock !== false, min_stock: qty(Number(b.minStock) || 0),
  photo_url: clean(b.photoUrl), show_in_menu: b.showInMenu !== false, active: b.active !== false,
  ...(Array.isArray(b.gallery) ? { gallery: b.gallery.filter(Boolean).slice(0, 3) } : {})
})

// Con ?bodega= o ?sede=, stock es lo que hay en esas bodegas (y byWarehouse el detalle).
router.get('/inventario/productos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('products').select(PRODUCT_COLUMNS).order('name')
  if (req.query.activos === '1') q = q.eq('active', true)
  if (Number(req.query.categoria)) q = q.eq('category_id', Number(req.query.categoria))
  const whs = await warehouseFilter(req)
  let sq = supabase.from('warehouse_stock').select('product_id, warehouse_id, stock, warehouse:warehouses(name, is_main)').gt('stock', 0)
  if (whs) sq = sq.in('warehouse_id', whs.length ? whs : [0])
  const [{ data, error }, { data: stock, error: e2 }, promos] = await Promise.all([q, sq, loadActive()])
  if (error) throw error
  if (e2) throw e2
  let rows = data.map((p) => {
    const ls = stock.filter((s) => s.product_id === p.id)
    const dto = productDTO(p, promos)
    if (whs) { dto.stock = ls.reduce((a, s) => a + Number(s.stock), 0); dto.lowStock = p.track_stock && isLow(dto.stock, dto.minStock) }
    dto.byWarehouse = ls.map((s) => ({ warehouseId: s.warehouse_id, name: s.warehouse?.name, isMain: s.warehouse?.is_main, stock: Number(s.stock) }))
    return dto
  })
  if (req.query.promo === '1') rows = rows.filter((p) => p.promo)
  res.send(rows)
}))

// Ficha del producto: galería, existencias por bodega, últimos movimientos, promoción vigente y las próximas.
router.get('/inventario/productos/:id', auth(STAFF), h(async (req, res) => {
  const id = Number(req.params.id)
  const [{ data: p }, { data: stock }, promos, { data: moves }] = await Promise.all([
    supabase.from('products').select(`${PRODUCT_COLUMNS}, gallery`).eq('id', id).maybeSingle(),
    supabase.from('warehouse_stock').select('warehouse_id, stock, warehouse:warehouses(name, is_main, site:sites(name))').eq('product_id', id),
    loadActive(),
    supabase.from('inventory_movements').select('id, type, quantity, stock_after, ref, note, created_at, warehouse:warehouses(name), user:users(name, last_name)')
      .eq('product_id', id).order('created_at', { ascending: false }).limit(15)
  ])
  if (!p) return fail(res, 'Producto no encontrado', 404)
  const dto = productDTO(p, promos)
  dto.byWarehouse = (stock || []).map((s) => ({ warehouseId: s.warehouse_id, name: s.warehouse?.name, isMain: s.warehouse?.is_main, site: s.warehouse?.site?.name ?? null, stock: Number(s.stock), low: p.track_stock && isLow(s.stock, p.min_stock) }))
  dto.movements = (moves || []).map(moveDTO)
  dto.upcoming = promos.filter((x) => x.id !== dto.promo?.id && covers(x, p) && ['programada', 'fuera_de_horario'].includes(statusOf(x)))
    .map((x) => ({ ...promoBrief(x, priceWith(x, Number(p.price)), Number(p.price)), status: statusOf(x), startsAt: x.starts_at, timeFrom: hm(x.time_from), weekdays: x.weekdays }))
  res.send(dto)
}))

router.post('/inventario/productos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = await validateProduct(b)
  const initial = qty(Number(b.initialStock) || 0)
  if (!(initial >= 0)) errors.push('Stock inicial inválido')
  if (b.trackStock === false && initial > 0) errors.push('Un producto sin inventario no lleva stock inicial')
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (b.active !== false) await plan.checkLimit(req.user.org_id, 'products')
  const { data, error } = await supabase.from('products').insert(productRow(b)).select('id').single()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un producto con ese código (SKU)', 409) : fail(res, error)
  if (initial > 0) {
    const warehouseId = Number(b.warehouseId) || (await mainWarehouse()).id
    const { data: ref } = await supabase.rpc('next_consecutive', { p_org: currentOrg(), p_kind: 'entrada', p_site: 0, p_prefix: 'EN-' })
    const { error: e2 } = await supabase.from('inventory_movements').insert({ warehouse_id: warehouseId, product_id: data.id, type: 'entrada', quantity: initial, unit_cost: Number(b.cost) || 0, ref, note: 'Stock inicial', user_id: req.user.id })
    if (e2) return p0001(res, e2)
    await checkLowStock([{ warehouseId, productId: data.id }])
  }
  await audit(req, 'crear', 'producto', data.id, { name: clean(b.name) })
  const { data: p } = await supabase.from('products').select(PRODUCT_COLUMNS).eq('id', data.id).single()
  res.status(201).send(productDTO(p, await loadActive()))
}))

router.put('/inventario/productos/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const b = req.body || {}
  const errors = await validateProduct(b)
  const { data: cur } = await supabase.from('products').select('id, stock, track_stock, min_stock, active').eq('id', id).maybeSingle()
  if (!cur) return fail(res, 'Producto no encontrado', 404)
  if (b.active !== false && !cur.active) await plan.checkLimit(req.user.org_id, 'products')
  if (b.trackStock === false && Number(cur.stock) > 0) errors.push('El producto tiene existencias: dales de baja antes de quitarle el inventario')
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data, error } = await supabase.from('products').update(productRow(b)).eq('id', id).select(PRODUCT_COLUMNS).maybeSingle()
  if (error) return error.code === '23505' ? fail(res, 'Ya existe un producto con ese código (SKU)', 409) : fail(res, error)
  // Si cambió el mínimo, se revisan sus bodegas: puede quedar bajo (o dejar de estarlo) sin moverse el stock.
  if (Number(cur.min_stock) !== Number(data.min_stock)) {
    const { data: ws } = await supabase.from('warehouse_stock').select('warehouse_id').eq('product_id', id)
    await checkLowStock((ws || []).map((w) => ({ warehouseId: w.warehouse_id, productId: id })))
  }
  await audit(req, 'editar', 'producto', id, { name: data.name, price: Number(data.price), active: data.active })
  res.send(productDTO(data, await loadActive()))
}))

// ---------------------------------------------------------------- Existencias por bodega
router.get('/inventario/existencias', auth(STAFF), h(async (req, res) => {
  const whs = await warehouseFilter(req)
  let q = supabase.from('warehouse_stock')
    .select('stock, warehouse_id, product_id, warehouse:warehouses(id, name, is_main, site:sites(name)), product:products(id, sku, name, unit, price, cost, min_stock, track_stock, active, category_id, category:product_categories(name, emoji))')
  if (whs) q = q.in('warehouse_id', whs.length ? whs : [0])
  if (req.query.todos !== '1') q = q.gt('stock', 0)
  const { data, error } = await q
  if (error) throw error
  const term = clean(req.query.q)?.toLowerCase()
  const cat = Number(req.query.categoria)
  res.send(data
    .filter((r) => r.product && r.product.track_stock && (!cat || r.product.category_id === cat))
    .filter((r) => !term || [r.product.name, r.product.sku].some((x) => x && x.toLowerCase().includes(term)))
    .map((r) => {
      const stock = Number(r.stock)
      return {
        warehouseId: r.warehouse_id, warehouse: r.warehouse?.name, isMain: r.warehouse?.is_main, site: r.warehouse?.site?.name ?? null,
        productId: r.product_id, sku: r.product.sku, name: r.product.name, unit: r.product.unit, category: r.product.category?.name, categoryEmoji: r.product.category?.emoji,
        stock, minStock: Number(r.product.min_stock), low: isLow(stock, r.product.min_stock), active: r.product.active,
        price: Number(r.product.price), saleValue: stock * Number(r.product.price), costValue: stock * Number(r.product.cost)
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.warehouse.localeCompare(b.warehouse)))
}))

// Bodegas con sus totales (productos, unidades y valor) para el resumen.
router.get('/inventario/bodegas', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('warehouses').select('id, name, description, responsible, is_main, active, site_id, site:sites(name)').order('is_main', { ascending: false }).order('name')
  if (req.siteId) q = q.eq('site_id', req.siteId)
  const [{ data, error }, { data: stock }] = await Promise.all([
    q, supabase.from('warehouse_stock').select('warehouse_id, stock, product:products(cost, price, min_stock, active)').gt('stock', 0)
  ])
  if (error) throw error
  res.send(data.map((w) => {
    const ls = (stock || []).filter((s) => s.warehouse_id === w.id)
    return {
      ...placeOf(w), description: w.description, responsible: w.responsible, active: w.active,
      products: ls.length,
      costValue: ls.reduce((a, s) => a + Number(s.stock) * Number(s.product?.cost || 0), 0),
      saleValue: ls.reduce((a, s) => a + Number(s.stock) * Number(s.product?.price || 0), 0)
    }
  }))
}))

// ---------------------------------------------------------------- Movimientos
const MOVE_LABELS = {
  entrada: 'Entrada', ajuste: 'Ajuste', baja: 'Baja', traslado_salida: 'Traslado enviado', traslado_entrada: 'Traslado recibido',
  venta: 'Venta', devolucion: 'Devolución'
}
const moveDTO = (m) => ({
  id: m.id, type: m.type, typeLabel: MOVE_LABELS[m.type], quantity: Number(m.quantity), stockAfter: m.stock_after === null ? null : Number(m.stock_after),
  unitCost: m.unit_cost === null || m.unit_cost === undefined ? null : Number(m.unit_cost), note: m.note, ref: m.ref, createdAt: m.created_at,
  warehouse: m.warehouse ? { id: m.warehouse.id, name: m.warehouse.name } : null,
  product: m.product || null, user: m.user ? `${m.user.name} ${m.user.last_name || ''}`.trim() : null
})

router.get('/inventario/movimientos', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('inventory_movements')
    .select('id, type, quantity, stock_after, unit_cost, note, ref, created_at, warehouse_id, warehouse:warehouses(id, name), product:products(id, name, sku, unit), user:users(name, last_name)')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(Math.min(Number(req.query.limit) || 200, 500))
  if (Number(req.query.producto)) q = q.eq('product_id', Number(req.query.producto))
  if (req.query.tipo && MOVE_LABELS[req.query.tipo]) q = q.eq('type', req.query.tipo)
  if (clean(req.query.ref)) q = q.eq('ref', clean(req.query.ref).toUpperCase())
  const whs = await warehouseFilter(req)
  if (whs) q = q.in('warehouse_id', whs.length ? whs : [0])
  const { data, error } = await q
  if (error) throw error
  res.send(data.map(moveDTO))
}))

// Entrada (compra), ajuste (+/-) o baja (daño, pérdida, vencimiento) de uno o varios productos en una bodega.
const MOVE_PREFIX = { entrada: 'EN-', ajuste: 'AJ-', baja: 'BA-' }
router.post('/inventario/movimientos', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!MOVE_PREFIX[b.type]) return fail(res, 'Tipo de movimiento inválido', 400)
  const raw = Array.isArray(b.items) ? b.items : [{ productId: b.productId, quantity: b.quantity, unitCost: b.unitCost }]
  const items = raw.map((i) => ({ productId: Number(i.productId), quantity: isQty(i.quantity) ? qty(i.quantity) : NaN, unitCost: i.unitCost === '' || i.unitCost === undefined || i.unitCost === null ? null : Number(i.unitCost) }))
    .filter((i) => i.productId)
  if (!items.length) return fail(res, 'Agrega al menos un producto', 400)
  if (new Set(items.map((i) => i.productId)).size !== items.length) return fail(res, 'Hay productos repetidos', 400)
  if (items.some((i) => !Number.isFinite(i.quantity) || i.quantity === 0)) return fail(res, 'Cada cantidad debe ser un número distinto de cero', 400)
  if (b.type !== 'ajuste' && items.some((i) => i.quantity < 0)) return fail(res, 'Las cantidades deben ser positivas', 400)
  if (items.some((i) => i.unitCost !== null && !(i.unitCost >= 0))) return fail(res, 'Costo unitario inválido', 400)
  if ((b.type === 'ajuste' || b.type === 'baja') && !clean(b.note)) return fail(res, 'Escribe el motivo del ajuste o la baja', 400)
  const warehouseId = Number(b.warehouseId) || (await mainWarehouse()).id
  const wh = await loadPlace(warehouseId)
  if (!wh || !wh.active) return fail(res, 'Selecciona una bodega activa', 400)
  const { data: prods } = await supabase.from('products').select('id, name, unit, track_stock, active').in('id', items.map((i) => i.productId))
  for (const i of items) {
    const p = (prods || []).find((x) => x.id === i.productId)
    if (!p) return fail(res, 'Hay un producto que no existe', 400)
    if (!p.track_stock) return fail(res, `"${p.name}" no maneja inventario`, 400)
    i.name = p.name; i.unit = p.unit
  }
  const { data: ref, error: e1 } = await supabase.rpc('next_consecutive', { p_org: currentOrg(), p_kind: b.type, p_site: 0, p_prefix: MOVE_PREFIX[b.type] })
  if (e1) throw e1
  const note = [clean(b.supplier) && `Proveedor: ${clean(b.supplier)}`, clean(b.invoice) && `Factura: ${clean(b.invoice)}`, clean(b.note)].filter(Boolean).join(' · ') || null
  // Un solo insert: si un producto no alcanza, no se registra ninguno.
  const { error } = await supabase.from('inventory_movements').insert(items.map((i) => ({
    warehouse_id: warehouseId, product_id: i.productId, type: b.type, quantity: b.type === 'baja' ? -i.quantity : i.quantity,
    unit_cost: b.type === 'entrada' ? i.unitCost : null, ref, note, user_id: req.user.id
  })))
  if (error) return p0001(res, error)
  const signed = items.map((i) => ({ ...i, quantity: b.type === 'baja' ? -i.quantity : i.quantity }))
  await audit(req, 'crear', 'movimiento_inventario', ref, { type: b.type, warehouse: wh.name, items: signed.map((i) => ({ product: i.name, quantity: i.quantity })) })
  notify('inventario', async () => movementMessage({ type: b.type, ref, warehouse: placeOf(wh), items: signed, note, user: req.user }))
  const alerts = await checkLowStock(items.map((i) => ({ warehouseId, productId: i.productId })))
  res.status(201).send({ ref, items: items.length, alerts })
}))

// ---------------------------------------------------------------- Traslados entre bodegas
router.post('/inventario/traslados', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const from = Number(b.fromWarehouseId); const to = Number(b.toWarehouseId)
  if (!from || !to) return fail(res, 'Selecciona la bodega de origen y la de destino', 400)
  if (from === to) return fail(res, 'La bodega de origen y la de destino son la misma', 400)
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ product_id: Number(i.productId), quantity: isQty(i.quantity) ? qty(i.quantity) : NaN })).filter((i) => i.product_id)
  if (!items.length) return fail(res, 'Agrega al menos un producto al traslado', 400)
  if (new Set(items.map((i) => i.product_id)).size !== items.length) return fail(res, 'Hay productos repetidos en el traslado', 400)
  if (items.some((i) => !(i.quantity > 0))) return fail(res, 'Las cantidades deben ser mayores que cero', 400)
  const { data: ref, error } = await supabase.rpc('transfer_stock', { p: { org_id: currentOrg(), from_warehouse_id: from, to_warehouse_id: to, user_id: req.user.id, note: clean(b.note), items } })
  if (error) return p0001(res, error)
  const [fw, tw, { data: prods }] = await Promise.all([loadPlace(from), loadPlace(to), supabase.from('products').select('id, name, unit').in('id', items.map((i) => i.product_id))])
  const named = items.map((i) => { const p = (prods || []).find((x) => x.id === i.product_id); return { name: p?.name, unit: p?.unit, quantity: i.quantity } })
  await audit(req, 'crear', 'traslado', ref, { from: fw?.name, to: tw?.name, items: named.map((i) => ({ product: i.name, quantity: i.quantity })) })
  notify('inventario', async () => transferMessage({ ref, from: placeOf(fw), to: placeOf(tw), items: named, note: clean(b.note), user: req.user }))
  const alerts = await checkLowStock(items.map((i) => ({ warehouseId: from, productId: i.product_id })).concat(items.map((i) => ({ warehouseId: to, productId: i.product_id }))))
  res.status(201).send({ ref, items: items.length, alerts })
}))

// Traslados recientes, agrupados por consecutivo.
router.get('/inventario/traslados', auth(STAFF), h(async (req, res) => {
  const whs = await warehouseFilter(req)
  let q = supabase.from('inventory_movements')
    .select('ref, type, quantity, note, created_at, warehouse:warehouses(id, name), product:products(id, name, unit), user:users(name, last_name)')
    .in('type', ['traslado_salida', 'traslado_entrada']).order('created_at', { ascending: false }).limit(400)
  const { data, error } = await q
  if (error) throw error
  const map = new Map()
  for (const m of data) {
    const t = map.get(m.ref) || { ref: m.ref, createdAt: m.created_at, note: m.note, user: m.user ? `${m.user.name} ${m.user.last_name || ''}`.trim() : null, from: null, to: null, items: [] }
    if (m.type === 'traslado_salida') { t.from = m.warehouse; t.items.push({ product: m.product, quantity: -Number(m.quantity) }) } else t.to = m.warehouse
    map.set(m.ref, t)
  }
  let rows = [...map.values()]
  if (whs) rows = rows.filter((t) => whs.includes(t.from?.id) || whs.includes(t.to?.id))
  res.send(rows.slice(0, 100))
}))

// ---------------------------------------------------------------- Resumen y alertas
router.get('/inventario/resumen', auth(STAFF), h(async (req, res) => {
  const whs = await warehouseFilter(req)
  let sq = supabase.from('warehouse_stock').select('product_id, warehouse_id, stock')
  if (whs) sq = sq.in('warehouse_id', whs.length ? whs : [0])
  const [{ data: products, error }, { data: stock }, { count: categories }, alerts] = await Promise.all([
    supabase.from('products').select('id, stock, min_stock, cost, price, track_stock, active, category:product_categories(name)').eq('active', true),
    sq,
    supabase.from('product_categories').select('id', { count: 'exact', head: true }).eq('active', true),
    currentAlerts(whs)
  ])
  if (error) throw error
  const qtyOf = (p) => (whs ? (stock || []).filter((s) => s.product_id === p.id).reduce((a, s) => a + Number(s.stock), 0) : Number(p.stock))
  const rows = products.filter((p) => p.track_stock).map((p) => ({ ...p, qty: qtyOf(p) }))
  const byCategory = {}
  for (const p of rows) { const k = p.category?.name || 'Sin categoría'; byCategory[k] = (byCategory[k] || 0) + p.qty * Number(p.price) }
  res.send({
    products: products.length,
    withStock: rows.filter((p) => p.qty > 0).length,
    costValue: rows.reduce((s, p) => s + p.qty * Number(p.cost), 0),
    saleValue: rows.reduce((s, p) => s + p.qty * Number(p.price), 0),
    lowStock: alerts.filter((a) => !a.out).length,
    outOfStock: alerts.filter((a) => a.out).length,
    categories: categories || 0,
    byCategory: Object.entries(byCategory).map(([name, value]) => ({ name, value })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
  })
}))

// Lo que está en el mínimo o agotado. El navegador lo consulta cada minuto para mostrar los avisos (toast).
// El empleado ve las bodegas de su sucursal y la principal.
router.get('/inventario/alertas', auth(STAFF), h(async (req, res) => {
  let whs = await warehouseFilter(req)
  if (!ADMIN.includes(req.user.role)) {
    const main = await mainWarehouse()
    whs = [...(whs || []), main?.id].filter(Boolean)
  }
  res.send(await currentAlerts(whs))
}))

module.exports = router
module.exports.UNITS = UNITS
module.exports.qty = qty
