// =====================================================================
// Multi-cliente: cada petición corre en el contexto de su organización (org_id).
// · El contexto viaja con AsyncLocalStorage desde el middleware de autenticación.
// · El cliente de Supabase filtra por org_id en select/update/delete y lo agrega en insert/upsert
//   de las tablas del negocio (TENANT_TABLES). Así ninguna consulta mezcla datos de dos negocios.
// · Sin contexto (login) las consultas no se filtran: esas rutas deben usar runAsOrg().
// =====================================================================
const { AsyncLocalStorage } = require('async_hooks')

const ctx = new AsyncLocalStorage()
const currentOrg = () => ctx.getStore()?.orgId ?? null
const runAsOrg = (orgId, fn) => ctx.run({ orgId: Number(orgId) }, fn)

// Tablas con org_id. Cada etapa agrega aquí sus tablas nuevas.
const TENANT_TABLES = new Set([
  'users', 'app_settings', 'audit_log', 'sites', 'warehouses', 'doc_sequences',
  // Etapa 2: catálogo, inventario, descuentos, promociones y Telegram
  'product_categories', 'products', 'warehouse_stock', 'inventory_movements', 'discounts', 'promotions',
  'notification_settings', 'notification_channels', 'notification_log',
  // Etapa 3: mesas, pedidos, caja, bóveda y cuentas por cobrar
  'dining_areas', 'dining_tables', 'cash_registers', 'cash_sessions', 'vaults', 'vault_movements', 'orders', 'order_items',
  'order_payments', 'receivables', 'receivable_payments', 'cash_movements', 'table_calls', 'tip_payouts', 'incidents',
  // Etapa 4: finanzas
  'partners', 'money_entries', 'fund_transfers', 'expenses', 'partner_withdrawals', 'cash_requests', 'menus', 'service_ratings', 'suppliers', 'cash_reopen_requests', 'courier_payouts', 'courier_floats',
  // TD-010: clientes (distribuidoras)
  'customers',
  // TD-011: cuentas por pagar a proveedores
  'supplier_payables'
])

const withOrg = (rows, org) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, org_id: org })) : { ...rows, org_id: org })

const scopeClient = (supabase) => {
  const rawFrom = supabase.from.bind(supabase)
  supabase.from = (table) => {
    const qb = rawFrom(table)
    const org = currentOrg()
    if (!org || !TENANT_TABLES.has(table)) return qb
    return new Proxy(qb, {
      get (target, prop) {
        const v = target[prop]
        if (typeof v !== 'function') return v
        if (prop === 'select' || prop === 'update' || prop === 'delete') return (...a) => v.apply(target, a).eq('org_id', org)
        if (prop === 'insert' || prop === 'upsert') return (rows, ...rest) => v.call(target, withOrg(rows, org), ...rest)
        return v.bind(target)
      }
    })
  }
  return supabase
}

// Ejecuta una tarea programada en el contexto de cada negocio activo.
const forEachOrg = async (supabase, fn) => {
  const { data } = await supabase.from('organizations').select('id').in('status', ['activa', 'prueba'])
  for (const { id } of data || []) {
    try { await runAsOrg(id, fn) } catch (e) { console.error(`Tarea del negocio ${id}:`, e.message) }
  }
}

module.exports = { ctx, currentOrg, runAsOrg, scopeClient, forEachOrg, TENANT_TABLES }
