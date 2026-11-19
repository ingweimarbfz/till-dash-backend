// =====================================================================
// Carta: arma lo que ve el cliente por el QR (y el personal en el módulo Carta).
// · Cartas (menus): el administrador elige secciones y su orden, destacados, productos ocultos,
//   presentación, sucursales y horario. Se usa la primera carta activa que aplica a la sucursal y la hora.
//   Sin cartas configuradas, se muestran todas las categorías y productos marcados "en la carta".
// · Opciones del QR: llamar al mesero, pedir la cuenta, pedir con confirmación y pedir directo.
//   Con ambas formas de pedir, las categorías elegidas van directo y las demás las confirma el mesero.
// =====================================================================
const supabase = require('./db')
const { bestFor, promoBrief, loadActive } = require('./promo')
const { inSite, loadSitePrices, priceAt } = require('./catalog')

const DEFAULT_PRESENTATION = { layout: 'lista', showPhotos: true, showDescriptions: true, soldOut: 'marcar' }

const qrOptionsOf = (s) => ({
  callWaiter: s?.qr_call_waiter ?? true,
  requestBill: s?.qr_request_bill ?? true,
  billView: ['completa', 'sin_valores', 'oculta'].includes(s?.qr_bill_view) ? s.qr_bill_view : 'completa',
  orderConfirm: s?.qr_order_confirm ?? s?.qr_ordering === 'confirmar',
  orderDirect: s?.qr_order_direct ?? s?.qr_ordering === 'directo',
  directCategories: (s?.qr_direct_categories || []).map(Number)
})
// TD-025: opciones del QR de una sucursal. Si la sucursal no tiene las suyas (sites.qr_options null),
// usa las generales. Devuelve { options, own } (own: la sucursal tiene opciones propias).
const QR_COLUMNS = 'qr_ordering, qr_call_waiter, qr_request_bill, qr_bill_view, qr_order_confirm, qr_order_direct, qr_direct_categories'
const ownQrOf = (o) => ({
  callWaiter: o.callWaiter !== false, requestBill: o.requestBill !== false,
  billView: ['completa', 'sin_valores', 'oculta'].includes(o.billView) ? o.billView : 'completa',
  orderConfirm: Boolean(o.orderConfirm), orderDirect: Boolean(o.orderDirect),
  directCategories: (Array.isArray(o.directCategories) ? o.directCategories : []).map(Number).filter((x) => Number.isInteger(x) && x > 0)
})
const qrOptionsAt = async (siteId, general = undefined) => {
  const [g, { data: site }] = await Promise.all([
    general !== undefined ? Promise.resolve(general) : supabase.from('app_settings').select(QR_COLUMNS).maybeSingle().then((r) => r.data),
    siteId ? supabase.from('sites').select('qr_options').eq('id', Number(siteId)).maybeSingle() : Promise.resolve({ data: null })
  ])
  if (site?.qr_options) return { options: ownQrOf(site.qr_options), own: true }
  return { options: qrOptionsOf(g), own: false }
}

// none · confirmar · directo · mixto
const orderMode = (o) => (o.orderConfirm && o.orderDirect ? 'mixto' : o.orderDirect ? 'directo' : o.orderConfirm ? 'confirmar' : 'none')
// ¿Este producto va directo a cocina? (según el modo y su categoría)
const goesDirect = (o, categoryId) => {
  const mode = orderMode(o)
  if (mode === 'directo') return true
  if (mode === 'mixto') return o.directCategories.includes(Number(categoryId))
  return false
}

// Día (0 domingo) y minutos del día en la zona horaria del establecimiento.
const clock = (tz, now = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Bogota', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]))
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { day: days[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}
const toMin = (t) => (t ? Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5)) : null)
// ¿La carta aplica ahora? Si el horario pasa la medianoche, la parte de la madrugada cuenta como el día anterior.
const menuAppliesAt = (m, siteId, c) => {
  if (!m.active) return false
  if ((m.site_ids || []).length && siteId && !m.site_ids.map(Number).includes(Number(siteId))) return false
  const days = (m.days || []).map(Number)
  const from = toMin(m.time_from); const to = toMin(m.time_to)
  if (from === null || to === null || from === to) return days.includes(c.day)
  if (from < to) return days.includes(c.day) && c.minutes >= from && c.minutes < to
  if (c.minutes >= from) return days.includes(c.day)
  return c.minutes < to && days.includes((c.day + 6) % 7)
}

const menuDTO = (m) => ({
  id: m.id, name: m.name, title: m.title, welcome: m.welcome, coverUrl: m.cover_url, layout: m.layout, showPhotos: m.show_photos, showDescriptions: m.show_descriptions,
  soldOut: m.sold_out, footerNote: m.footer_note, siteIds: (m.site_ids || []).map(Number), days: (m.days || []).map(Number),
  timeFrom: m.time_from ? String(m.time_from).slice(0, 5) : null, timeTo: m.time_to ? String(m.time_to).slice(0, 5) : null,
  categoryIds: (m.category_ids || []).map(Number), featuredIds: (m.featured_ids || []).map(Number), hiddenProductIds: (m.hidden_product_ids || []).map(Number),
  active: m.active, sortOrder: m.sort_order, updatedAt: m.updated_at
})

// Carta que aplica en la sucursal ahora (o la pedida por id). null: carta automática.
const pickMenu = async ({ siteId, menuId, tz }) => {
  const { data: menus } = await supabase.from('menus').select('*').order('sort_order').order('id')
  const list = menus || []
  if (menuId) return list.find((m) => m.id === Number(menuId)) || null
  const c = clock(tz)
  return list.find((m) => menuAppliesAt(m, siteId, c)) || null
}

// Datos de la carta para una sucursal: negocio, presentación, secciones y productos con precio y disponibilidad.
// Debe correr en el contexto del establecimiento (runAsOrg o una petición autenticada).
const buildMenu = async ({ siteId, menuId = null }) => {
  const { data: s } = await supabase.from('app_settings')
    .select('business_name, short_name, slogan, logo_url, color_primary, color_secondary, color_accent, font_family, social, timezone, qr_ordering, qr_call_waiter, qr_request_bill, qr_bill_view, qr_order_confirm, qr_order_direct, qr_direct_categories')
    .maybeSingle()
  const menu = await pickMenu({ siteId, menuId, tz: s?.timezone })
  const { data: wh } = siteId ? await supabase.rpc('sale_warehouse', { p_site: siteId }) : { data: null }
  const [{ data: cats }, { data: prods }, { data: stock }, promos] = await Promise.all([
    supabase.from('product_categories').select('id, name, emoji, color, description, sort_order, site_ids').eq('active', true).eq('show_in_menu', true).order('sort_order').order('name'),
    supabase.from('products').select('id, name, description, price, photo_url, category_id, track_stock, unit, site_ids').eq('active', true).eq('show_in_menu', true).order('name'),
    wh ? supabase.from('warehouse_stock').select('product_id, stock').eq('warehouse_id', wh) : Promise.resolve({ data: [] }),
    loadActive(siteId)
  ])
  // TD-024: solo lo que se vende en la sucursal, con su precio.
  const siteCats = (cats || []).filter((c) => inSite(c, siteId))
  const catIds = new Set(siteCats.map((c) => c.id))
  const prices = siteId ? await loadSitePrices() : new Map()
  const left = new Map((stock || []).map((x) => [x.product_id, Number(x.stock)]))
  const hidden = new Set((menu?.hidden_product_ids || []).map(Number))
  const p = { ...DEFAULT_PRESENTATION, ...(menu ? { layout: menu.layout, showPhotos: menu.show_photos, showDescriptions: menu.show_descriptions, soldOut: menu.sold_out } : {}) }
  const { options: qr } = await qrOptionsAt(siteId, s)
  let products = (prods || []).filter((x) => !hidden.has(x.id) && inSite(x, siteId) && catIds.has(x.category_id)).map((raw) => {
    const x = { ...raw, price: priceAt(raw, siteId, prices) }
    const best = bestFor(promos, x)
    return {
      id: x.id, name: x.name, description: p.showDescriptions ? x.description : null, photoUrl: p.showPhotos ? x.photo_url : null, categoryId: x.category_id, unit: x.unit,
      price: Number(x.price), finalPrice: best ? best.price : Number(x.price), promo: best ? promoBrief(best.promo, best.price, Number(x.price)) : null,
      soldOut: Boolean(wh) && x.track_stock && !(left.get(x.id) > 0),
      direct: goesDirect(qr, x.category_id)
    }
  })
  if (p.soldOut === 'ocultar') products = products.filter((x) => !x.soldOut)
  // Secciones: las elegidas en la carta y en su orden; si no eligió, todas las categorías de la carta.
  const chosen = (menu?.category_ids || []).map(Number)
  const allCats = siteCats
  const ordered = chosen.length ? chosen.map((id) => allCats.find((c) => c.id === id)).filter(Boolean) : allCats
  const categories = ordered.filter((c) => products.some((x) => x.categoryId === c.id))
    .map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, color: c.color, description: c.description }))
  const inCats = new Set(categories.map((c) => c.id))
  products = products.filter((x) => inCats.has(x.categoryId))
  const featured = (menu?.featured_ids || []).map(Number).filter((id) => products.some((x) => x.id === id))
  return {
    business: s ? { name: s.business_name, shortName: s.short_name, slogan: s.slogan, logoUrl: s.logo_url, primary: s.color_primary, secondary: s.color_secondary, accent: s.color_accent, font: s.font_family, social: s.social } : null,
    menu: { id: menu?.id ?? null, name: menu?.name ?? 'Carta', title: menu?.title || null, welcome: menu?.welcome || null, coverUrl: menu?.cover_url || null, footerNote: menu?.footer_note || null, ...p, featured },
    qr,
    orderMode: orderMode(qr),
    categories,
    products
  }
}

module.exports = { buildMenu, pickMenu, menuDTO, menuAppliesAt, clock, qrOptionsOf, qrOptionsAt, ownQrOf, orderMode, goesDirect, QR_COLUMNS }
