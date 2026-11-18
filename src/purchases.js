// =====================================================================
// TD-011 · Pago de las compras de inventario.
// Toda entrada (y el stock inicial de un producto nuevo) dice de dónde se pagó:
// · caja: efectivo de un turno abierto (gasto del turno).
// · cuenta: el fondo general, el de una sucursal o una subcuenta de Finanzas (gasto de la cuenta).
// · credito: a crédito con un proveedor registrado → cuenta por pagar (CP-…), se abona desde Finanzas.
// · inicial: mercancía que ya estaba en la bodega; no mueve dinero. Solo el super administrador.
// Caja y cuenta validan el saldo antes de tocar el inventario: si no alcanza, no se registra nada.
// =====================================================================
const supabase = require('./db')
const { currentOrg } = require('./tenant')

const PAYMENT_LABELS = { caja: 'Efectivo de la caja', cuenta: 'Cuenta de Finanzas', credito: 'A crédito con el proveedor', inicial: 'Inventario inicial (sin pago)' }
const ACCOUNT_RE = /^(general|\d+|v\d+)$/

// Validación pura (se prueba sin base de datos). Devuelve { pay } o { error }.
// Compatibilidad: si solo llega paySessionId, es un pago con la caja.
const parsePayment = (b = {}, { role, total, supplierId } = {}) => {
  const method = b.payment || (Number(b.paySessionId) ? 'caja' : null)
  if (!method) return { error: 'Elige de dónde se pagó la compra' }
  if (!PAYMENT_LABELS[method]) return { error: 'Forma de pago de la compra no válida' }
  if (method === 'inicial') {
    if (role !== 'superadmin') return { error: 'Solo el super administrador puede cargar inventario inicial sin pago' }
    return { pay: { method } }
  }
  if (!(total > 0)) return { error: 'Escribe el costo de los productos para registrar el pago' }
  if (method === 'caja') {
    if (!Number(b.paySessionId)) return { error: 'Elige el turno de caja del que sale el dinero' }
    return { pay: { method, sessionId: Number(b.paySessionId) } }
  }
  if (method === 'cuenta') {
    const key = String(b.payAccount ?? '')
    if (!ACCOUNT_RE.test(key)) return { error: 'Elige la cuenta de Finanzas con la que se pagó' }
    return { pay: { method, account: key } }
  }
  if (!Number(supplierId)) return { error: 'Para comprar a crédito elige un proveedor registrado' }
  return { pay: { method, supplierId: Number(supplierId) } }
}

const accountVault = async (key) => {
  const sub = /^v(\d+)$/.exec(key)
  if (sub) {
    const { data } = await supabase.from('vaults').select('id, site_id, balance, name, kind, active').eq('id', Number(sub[1])).eq('kind', 'subcuenta').maybeSingle()
    return data
  }
  const site = key === 'general' ? null : Number(key)
  const { data: id } = await supabase.rpc('vault_of', { p_org: currentOrg(), p_site: site })
  if (!id) return null
  const { data } = await supabase.from('vaults').select('id, site_id, balance, name, kind, active').eq('id', id).maybeSingle()
  return data
}
const money = (v) => `$${Math.round(Number(v)).toLocaleString('es-CO')}`

// Revisa que haya con qué pagar, antes de registrar el inventario. Devuelve { error } o datos para settle().
const checkPayment = async (pay, total) => {
  if (pay.method === 'caja') {
    const { data: s } = await supabase.from('cash_sessions').select('id, number, status, site_id').eq('id', pay.sessionId).maybeSingle()
    if (!s || s.status !== 'abierta') return { error: 'El turno de caja elegido para pagar ya no está abierto', status: 409 }
    const { data: cash } = await supabase.rpc('session_cash', { p_session: s.id })
    if (Number(cash) < total) return { error: `No hay suficiente efectivo en la caja ${s.number} (disponible: ${money(cash)})` }
    return { session: s }
  }
  if (pay.method === 'cuenta') {
    const v = await accountVault(pay.account)
    if (!v) return { error: 'La cuenta de Finanzas no existe', status: 404 }
    if (!v.active) return { error: 'La subcuenta está inactiva', status: 409 }
    if (Number(v.balance) < total) {
      const name = v.kind === 'subcuenta' ? `La subcuenta ${v.name}` : v.site_id ? 'El fondo de la sucursal' : 'El fondo general'
      return { error: `${name} no tiene suficiente dinero para esta compra de ${money(total)} (disponible: ${money(v.balance)}). Ingresa dinero en Finanzas, elige otra cuenta o regístrala a crédito.` }
    }
    return { vault: v }
  }
  if (pay.method === 'credito') {
    const { data: sp } = await supabase.from('suppliers').select('id, name, payment_terms').eq('id', pay.supplierId).maybeSingle()
    if (!sp) return { error: 'El proveedor no existe', status: 400 }
    return { supplier: sp }
  }
  return {}
}

// Registra el pago una vez creada la entrada: gasto de caja o de cuenta, o la cuenta por pagar.
// Devuelve { expense } | { payable } | {} ; si falla, { error }.
const settle = async ({ pay, check, total, ref, items, supplier, invoice, userId }) => {
  const description = `Compra ${ref}: ${items.map((i) => i.name).join(', ')}`.slice(0, 200)
  if (pay.method === 'caja' || pay.method === 'cuenta') {
    const p = {
      org_id: currentOrg(), user_id: userId, category: 'compras', description, supplier: supplier?.name ?? null, invoice_ref: invoice, amount: total,
      source: pay.method === 'caja' ? 'caja' : 'fondo',
      session_id: pay.method === 'caja' ? check.session.id : null,
      vault_id: pay.method === 'cuenta' ? check.vault.id : null,
      site_id: pay.method === 'cuenta' ? check.vault.site_id : null
    }
    const { data: eid, error } = await supabase.rpc('finance_expense', { p })
    if (error) return { error: error.message }
    if (supplier?.id) await supabase.from('expenses').update({ supplier_id: supplier.id }).eq('id', eid)
    const { data: ex } = await supabase.from('expenses').select('number').eq('id', eid).single()
    return { expense: { id: eid, number: ex?.number, amount: total, source: p.source, session: check.session?.number ?? null, account: check.vault ? (check.vault.kind === 'subcuenta' ? check.vault.name : check.vault.site_id ? 'Fondo de la sucursal' : 'Fondo general') : null } }
  }
  if (pay.method === 'credito') {
    const sp = check.supplier
    const { data: number, error: e1 } = await supabase.rpc('next_consecutive', { p_org: currentOrg(), p_kind: 'por_pagar', p_site: 0, p_prefix: 'CP-' })
    if (e1) return { error: e1.message }
    const due = new Date(Date.now() - 5 * 3600e3 + Number(sp.payment_terms || 0) * 86400e3).toISOString().slice(0, 10)
    const { data, error } = await supabase.from('supplier_payables').insert({
      supplier_id: sp.id, number, movement_ref: ref, invoice_ref: invoice, description, amount: total, due_on: due, created_by: userId
    }).select('id, number, due_on').single()
    if (error) return { error: error.message }
    return { payable: { id: data.id, number: data.number, amount: total, dueOn: data.due_on, supplier: sp.name } }
  }
  return {}
}

module.exports = { PAYMENT_LABELS, parsePayment, checkPayment, settle }
