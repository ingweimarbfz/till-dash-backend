// =====================================================================
// Pago de las compras de inventario (TD-010). Toda entrada dice de dónde se pagó:
// · caja     → efectivo de un turno de caja abierto (gasto del turno; valida que alcance).
// · cuenta   → una cuenta o subcuenta de Finanzas (gasto de Finanzas; valida el saldo).
// · credito  → a crédito con el proveedor: queda una cuenta por pagar.
// · inicial  → inventario inicial o que ya existía: no sale dinero. Solo el super administrador.
// · externo  → pagado por fuera del sistema. Solo en planes sin Finanzas (no hay cuentas que validar).
// El gasto se crea antes que la entrada: si el dinero no alcanza no entra nada.
// =====================================================================
const supabase = require('./db')
const plan = require('./plan')
const { currentOrg } = require('./tenant')

const PAY_SOURCES = {
  caja: 'Efectivo de la caja',
  cuenta: 'Cuenta de Finanzas',
  credito: 'A crédito con el proveedor',
  inicial: 'Inventario inicial (ya existía)',
  externo: 'Pagado por fuera del sistema'
}
const SUB_RE = /^v(\d+)$/
const money = (v) => `$${Math.round(Number(v) || 0).toLocaleString('es-CO')}`
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
const today = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10)
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

// Opciones de pago según el plan y el rol (cálculo puro).
const sourcesFor = ({ finance, role }) => {
  const out = ['caja']
  if (finance) out.push('cuenta', 'credito')
  else out.push('externo')
  if (role === 'superadmin') out.push('inicial')
  return out
}
const optionsFor = async (user) => {
  const finance = await plan.orgHas(user.org_id, 'finanzas')
  return { finance, sources: sourcesFor({ finance, role: user.role }) }
}

// Valida el pago sin escribir nada. b: { paidFrom, paySessionId, payFund, dueDate }.
// Devuelve { error, status } o { pay } listo para charge().
const checkPay = async (user, b, { total, sup }) => {
  const { finance, sources } = await optionsFor(user)
  // Compatibilidad: antes solo existía paySessionId.
  const src = b.paidFrom || (Number(b.paySessionId) ? 'caja' : null)
  if (!src) return { error: 'Elige de dónde se pagó la compra' }
  if (!PAY_SOURCES[src]) return { error: 'Forma de pago de la compra no válida' }
  if (!sources.includes(src)) {
    if (src === 'inicial') return { error: 'Solo el super administrador puede cargar inventario inicial sin pago', status: 403 }
    if (src === 'externo') return { error: 'Elige la caja, una cuenta de Finanzas o el crédito con el proveedor' }
    return { error: 'Tu plan no incluye Finanzas: paga con la caja o regístralo como pagado por fuera', status: 403 }
  }
  if (['caja', 'cuenta', 'credito'].includes(src) && !(total > 0)) return { error: 'Escribe el costo de los productos: con él se registra el pago' }
  if (src === 'caja') {
    const { data: ps } = await supabase.from('cash_sessions').select('id, number, status, site_id').eq('id', Number(b.paySessionId)).maybeSingle()
    if (!ps || ps.status !== 'abierta') return { error: 'Elige un turno de caja abierto', status: 409 }
    const { data: cash } = await supabase.rpc('session_cash', { p_session: ps.id })
    if (Number(cash) < total) return { error: `No hay suficiente efectivo en la caja ${ps.number} (disponible: ${money(cash)})` }
    return { pay: { src, session: ps } }
  }
  if (src === 'cuenta') {
    const key = String(b.payFund ?? '')
    if (!key) return { error: 'Elige la cuenta de la que sale el dinero' }
    const m = SUB_RE.exec(key)
    let q = supabase.from('vaults').select('id, site_id, kind, name, balance, active')
    if (m) q = q.eq('id', Number(m[1])).eq('kind', 'subcuenta')
    else {
      const site = key === 'general' ? null : Number(key) || null
      if (key !== 'general' && !site) return { error: 'Cuenta no válida' }
      await supabase.rpc('vault_of', { p_org: user.org_id, p_site: site })
      q = q.eq('kind', 'principal')
      q = site ? q.eq('site_id', site) : q.is('site_id', null)
    }
    const { data: v } = await q.maybeSingle()
    if (!v) return { error: 'Cuenta no encontrada', status: 404 }
    if (!v.active) return { error: 'La subcuenta está inactiva', status: 409 }
    const name = v.kind === 'subcuenta' ? `la subcuenta ${v.name}` : v.site_id ? 'el fondo de la sucursal' : 'el fondo general'
    if (Number(v.balance) < total) return { error: `No hay suficiente dinero en ${name} (disponible: ${money(v.balance)}). Ingresa dinero en Finanzas, elige otra cuenta o regístrala a crédito.` }
    return { pay: { src, vault: v } }
  }
  if (src === 'credito') {
    if (!sup?.name) return { error: 'Elige el proveedor que te dio el crédito' }
    let due = isDay(b.dueDate) ? b.dueDate : null
    if (!due && sup.id) {
      const { data: s } = await supabase.from('suppliers').select('payment_terms').eq('id', sup.id).maybeSingle()
      due = addDays(today(), Number(s?.payment_terms) || 0)
    }
    return { pay: { src, dueDate: due || today() } }
  }
  return { pay: { src } }
}

// Registra el gasto (caja o cuenta) antes de la entrada. Devuelve { expense } o lanza el error de la base.
const charge = async (user, pay, { ref, total, description, sup, invoice }) => {
  if (pay.src !== 'caja' && pay.src !== 'cuenta') return { expense: null }
  const p = {
    org_id: currentOrg(), user_id: user.id, category: 'compras', description: description.slice(0, 200),
    supplier: sup?.name || null, invoice_ref: invoice, amount: total
  }
  if (pay.src === 'caja') Object.assign(p, { source: 'caja', session_id: pay.session.id })
  else Object.assign(p, { source: 'fondo', vault_id: pay.vault.id, site_id: pay.vault.site_id })
  const { data: id, error } = await supabase.rpc('finance_expense', { p })
  if (error) throw error
  if (sup?.id) await supabase.from('expenses').update({ supplier_id: sup.id }).eq('id', id)
  const { data: ex } = await supabase.from('expenses').select('number').eq('id', id).single()
  return { expense: { id, number: ex?.number, amount: total, source: pay.src, session: pay.session?.number ?? null, account: pay.vault ? (pay.vault.kind === 'subcuenta' ? pay.vault.name : pay.vault.site_id ? 'Fondo de la sucursal' : 'Fondo general') : null } }
}

// Si la entrada falla después de cobrar, el gasto se anula y el dinero vuelve.
const undo = async (user, expense, ref) => {
  if (!expense) return
  await supabase.rpc('finance_void', { p: { org_id: currentOrg(), user_id: user.id, kind: 'expense', id: expense.id, reason: `La entrada ${ref} no se registró` } })
}

// Compra a crédito: cuenta por pagar al proveedor.
const createPayable = async (user, pay, { ref, total, description, sup, invoice, siteId }) => {
  if (pay.src !== 'credito') return null
  const { data, error } = await supabase.from('payables').insert({
    org_id: currentOrg(), site_id: siteId ?? null, supplier_id: sup?.id ?? null, supplier: sup?.name ?? null, ref, invoice_ref: invoice,
    description: description.slice(0, 200), amount: total, due_date: pay.dueDate, created_by: user.id
  }).select('id, due_date').single()
  if (error) throw error
  return { id: data.id, amount: total, dueDate: data.due_date }
}

module.exports = { PAY_SOURCES, sourcesFor, optionsFor, checkPay, charge, undo, createPayable, addDays }
