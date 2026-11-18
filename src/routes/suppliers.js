// =====================================================================
// Proveedores (TD-005)
// · Ficha con los datos principales: identificación, contacto, condiciones de pago y cuenta bancaria.
// · Se asigna a productos (proveedor habitual), entradas de inventario, gastos de Finanzas y de caja.
// · La ficha muestra lo que se le ha comprado y pagado.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean, EMAIL_RE } = require('../http')
const { auth, ADMIN, STAFF } = require('../auth')
const { audit } = require('../audit')
const { fullName } = require('../ops')
const { SUPPLIER_CATEGORIES } = require('../suppliers')

const router = express.Router()
const DOC_TYPES = ['NIT', 'CC', 'CE', 'RUT', 'Otro']

const supplierDTO = (s) => ({
  id: s.id, name: s.name, legalName: s.legal_name, docType: s.doc_type, docNumber: s.doc_number, category: s.category, categoryLabel: SUPPLIER_CATEGORIES[s.category],
  contactName: s.contact_name, phone: s.phone, whatsapp: s.whatsapp, email: s.email, address: s.address, city: s.city,
  paymentTerms: s.payment_terms, bankName: s.bank_name, bankAccountType: s.bank_account_type, bankAccount: s.bank_account,
  deliveryDays: (s.delivery_days || []).map(Number), notes: s.notes, active: s.active, createdAt: s.created_at, updatedAt: s.updated_at
})

const supplierRow = (b) => {
  const name = clean(b.name)
  if (!name || name.length < 2) return { error: 'Escribe el nombre del proveedor' }
  if (b.docType && !DOC_TYPES.includes(b.docType)) return { error: 'Tipo de documento no válido' }
  const doc = clean(b.docNumber)?.replace(/\s+/g, '') || null
  if (doc && !/^[0-9A-Za-z.-]{3,20}$/.test(doc)) return { error: 'El número de documento no es válido' }
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) return { error: 'El correo no es válido' }
  for (const k of ['phone', 'whatsapp']) if (clean(b[k]) && !/^[0-9 +()-]{7,20}$/.test(clean(b[k]))) return { error: `El ${k === 'phone' ? 'teléfono' : 'WhatsApp'} no es válido` }
  const terms = Number(b.paymentTerms || 0)
  if (!Number.isInteger(terms) || terms < 0 || terms > 365) return { error: 'Los días de crédito van de 0 a 365' }
  if (b.bankAccountType && !['ahorros', 'corriente'].includes(b.bankAccountType)) return { error: 'Tipo de cuenta no válido' }
  const days = [...new Set((Array.isArray(b.deliveryDays) ? b.deliveryDays : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
  return {
    row: {
      name: name.slice(0, 120), legal_name: clean(b.legalName)?.slice(0, 160) ?? null, doc_type: b.docType || 'NIT', doc_number: doc,
      category: SUPPLIER_CATEGORIES[b.category] ? b.category : 'otro', contact_name: clean(b.contactName)?.slice(0, 120) ?? null,
      phone: clean(b.phone), whatsapp: clean(b.whatsapp), email: clean(b.email)?.toLowerCase() ?? null, address: clean(b.address)?.slice(0, 200) ?? null, city: clean(b.city)?.slice(0, 80) ?? null,
      payment_terms: terms, bank_name: clean(b.bankName)?.slice(0, 80) ?? null, bank_account_type: b.bankAccountType || null, bank_account: clean(b.bankAccount)?.slice(0, 40) ?? null,
      delivery_days: days, notes: clean(b.notes)?.slice(0, 500) ?? null, active: b.active !== false, updated_at: new Date().toISOString()
    }
  }
}
const dupError = (res, error) => {
  if (error?.code !== '23505') throw error
  return fail(res, /doc/.test(error.message) ? 'Ya existe un proveedor con ese número de documento' : 'Ya existe un proveedor con ese nombre', 409)
}

// Lista (todo el personal la usa para elegir el proveedor). ?activos=1 solo los activos.
router.get('/proveedores', auth(STAFF), h(async (req, res) => {
  let q = supabase.from('suppliers').select('*').order('name')
  if (req.query.activos === '1') q = q.eq('active', true)
  const since = new Date(Date.now() - 90 * 864e5).toISOString()
  const [{ data, error }, { data: prods }, { data: buys }, { data: exps }] = await Promise.all([
    q,
    supabase.from('products').select('supplier_id').not('supplier_id', 'is', null).eq('active', true),
    supabase.from('inventory_movements').select('supplier_id, quantity, unit_cost, created_at').eq('type', 'entrada').not('supplier_id', 'is', null).gte('created_at', since),
    supabase.from('expenses').select('supplier_id, amount').eq('status', 'activo').not('supplier_id', 'is', null).gte('paid_on', since.slice(0, 10))
  ])
  if (error) throw error
  const count = (list, f) => (list || []).reduce((m, x) => { m[x.supplier_id] = (m[x.supplier_id] || 0) + f(x); return m }, {})
  const pc = count(prods, () => 1)
  const bought = count(buys, (x) => Number(x.quantity) * Number(x.unit_cost || 0))
  const paid = count(exps, (x) => Number(x.amount))
  const last = (buys || []).reduce((m, x) => { if (!m[x.supplier_id] || x.created_at > m[x.supplier_id]) m[x.supplier_id] = x.created_at; return m }, {})
  res.send({
    rows: data.map((s) => ({ ...supplierDTO(s), products: pc[s.id] || 0, purchases90: Math.round(bought[s.id] || 0), paid90: Math.round(paid[s.id] || 0), lastPurchase: last[s.id] || null })),
    categories: SUPPLIER_CATEGORIES
  })
}))

// Ficha: datos, productos que surte, compras (entradas de inventario) y pagos (gastos).
router.get('/proveedores/:id(\\d+)', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const { data: s } = await supabase.from('suppliers').select('*').eq('id', id).maybeSingle()
  if (!s) return fail(res, 'Proveedor no encontrado', 404)
  const [{ data: prods }, { data: moves }, { data: exps }] = await Promise.all([
    supabase.from('products').select('id, name, sku, unit, cost, price, stock, active, category:product_categories(name, emoji)').eq('supplier_id', id).order('name'),
    supabase.from('inventory_movements').select('ref, quantity, unit_cost, invoice_ref, created_at, product:products(name, unit), warehouse:warehouses(name), user:users(name, last_name)')
      .eq('supplier_id', id).eq('type', 'entrada').order('created_at', { ascending: false }).limit(300),
    supabase.from('expenses').select('id, number, category, description, invoice_ref, amount, paid_on, source, status').eq('supplier_id', id).order('paid_on', { ascending: false }).limit(100)
  ])
  // Compras agrupadas por consecutivo (una entrada puede traer varios productos).
  const byRef = new Map()
  for (const m of moves || []) {
    const k = m.ref || `${m.created_at}`
    if (!byRef.has(k)) byRef.set(k, { ref: m.ref, invoiceRef: m.invoice_ref, date: m.created_at, warehouse: m.warehouse?.name ?? null, user: fullName(m.user), items: [], total: 0 })
    const g = byRef.get(k)
    const sub = Number(m.quantity) * Number(m.unit_cost || 0)
    g.items.push({ name: m.product?.name, unit: m.product?.unit, quantity: Number(m.quantity), unitCost: m.unit_cost === null ? null : Number(m.unit_cost), subtotal: sub })
    g.total += sub
  }
  const purchases = [...byRef.values()].slice(0, 50)
  const active = (exps || []).filter((e) => e.status === 'activo')
  const months = {}
  for (const p of byRef.values()) { const k = String(p.date).slice(0, 7); months[k] = (months[k] || 0) + p.total }
  for (const e of active) { const k = String(e.paid_on).slice(0, 7); months[k] = (months[k] || 0) + Number(e.amount) }
  res.send({
    ...supplierDTO(s),
    products: (prods || []).map((p) => ({ id: p.id, name: p.name, sku: p.sku, unit: p.unit, cost: Number(p.cost), price: Number(p.price), stock: Number(p.stock), active: p.active, category: p.category?.name ?? null, categoryEmoji: p.category?.emoji ?? null })),
    purchases,
    payments: (exps || []).map((e) => ({ id: e.id, number: e.number, category: e.category, description: e.description, invoiceRef: e.invoice_ref, amount: Number(e.amount), paidOn: e.paid_on, source: e.source, status: e.status })),
    totals: {
      purchases: Math.round([...byRef.values()].reduce((a, p) => a + p.total, 0)),
      purchaseCount: byRef.size,
      paid: Math.round(active.reduce((a, e) => a + Number(e.amount), 0)),
      lastPurchase: purchases[0]?.date ?? null
    },
    monthly: Object.entries(months).sort().slice(-6).map(([month, total]) => ({ month, total: Math.round(total) }))
  })
}))

router.post('/proveedores', auth(ADMIN), h(async (req, res) => {
  const { row, error: e } = supplierRow(req.body || {})
  if (e) return fail(res, e, 400)
  const { data, error } = await supabase.from('suppliers').insert({ ...row, created_by: req.user.id }).select('*').single()
  if (error) return dupError(res, error)
  await audit(req, 'crear', 'proveedor', data.id, { name: data.name })
  res.status(201).send(supplierDTO(data))
}))
router.put('/proveedores/:id(\\d+)', auth(ADMIN), h(async (req, res) => {
  const { row, error: e } = supplierRow(req.body || {})
  if (e) return fail(res, e, 400)
  const { data, error } = await supabase.from('suppliers').update(row).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) return dupError(res, error)
  if (!data) return fail(res, 'Proveedor no encontrado', 404)
  await audit(req, 'editar', 'proveedor', data.id, { name: data.name, active: data.active })
  res.send(supplierDTO(data))
}))
// Solo se elimina si no tiene compras ni pagos; si los tiene, se desactiva.
router.delete('/proveedores/:id(\\d+)', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const [{ count: m }, { count: x }] = await Promise.all([
    supabase.from('inventory_movements').select('id', { count: 'exact', head: true }).eq('supplier_id', id),
    supabase.from('expenses').select('id', { count: 'exact', head: true }).eq('supplier_id', id)
  ])
  if ((m || 0) + (x || 0) > 0) return fail(res, 'El proveedor tiene compras o pagos registrados. Desactívalo en lugar de eliminarlo.', 409)
  const { data } = await supabase.from('suppliers').delete().eq('id', id).select('id, name').maybeSingle()
  if (!data) return fail(res, 'Proveedor no encontrado', 404)
  await audit(req, 'eliminar', 'proveedor', id, { name: data.name })
  res.send({ ok: true })
}))

module.exports = router
