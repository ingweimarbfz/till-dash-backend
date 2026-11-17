// =====================================================================
// Plan de cada establecimiento: qué módulos tiene y cuántas sucursales, usuarios, mesas y productos puede crear.
// · Sin plan asignado el establecimiento no tiene restricciones (como antes de los planes).
// · El estado se guarda en memoria un minuto por establecimiento; la plataforma lo recarga al cambiar algo.
// =====================================================================
const supabase = require('./db')
const { HttpError } = require('./http')

// Ruta de la API → módulo que la habilita. Lo que no aparece aquí es del núcleo (siempre disponible).
const FEATURE_ROUTES = [
  ['/comandas', 'comandas'],
  ['/llamados', 'carta_qr'],
  ['/cuentas-por-cobrar', 'cuentas_por_cobrar'],
  ['/promociones', 'promociones'], ['/descuentos', 'promociones'],
  ['/incidentes', 'incidentes'],
  ['/reportes', 'reportes'],
  ['/finanzas', 'finanzas'],
  ['/bitacora', 'bitacora'],
  ['/notificaciones', 'telegram'],
  ['/configuracion/apariencia', 'marca']
]
const featureFor = (path) => {
  const hit = FEATURE_ROUTES.find(([p]) => path === p || path.startsWith(`${p}/`))
  return hit ? hit[1] : null
}
const LIMITS = {
  sites: ['max_sites', 'sucursales'],
  admins: ['max_admins', 'administradores'],
  employees: ['max_employees', 'empleados'],
  tables: ['max_tables', 'mesas'],
  products: ['max_products', 'productos']
}

const EMPTY = { plan: null, features: null, org: null, country: null, loadedAt: 0 }
const states = new Map()

const load = async (orgId) => {
  const { data: org } = await supabase.from('organizations').select('id, name, status, country_code, billing_cycle, start_date, renewal_date, extra_features, plan:plans(*), country:countries(*)').eq('id', orgId).maybeSingle()
  const st = { ...EMPTY, loadedAt: Date.now() }
  if (org) {
    st.org = { id: org.id, name: org.name, status: org.status, billingCycle: org.billing_cycle, startDate: org.start_date, renewalDate: org.renewal_date }
    st.country = org.country ? { code: org.country.code, name: org.country.name, currency: org.country.currency, locale: org.country.locale, timezone: org.country.timezone } : null
    if (org.plan) {
      st.plan = org.plan
      st.features = [...new Set([...(org.plan.features || []), ...(org.extra_features || [])])]
    }
  }
  states.set(Number(orgId), st)
  return st
}
const ensure = async (orgId) => {
  const s = states.get(Number(orgId))
  return s && Date.now() - s.loadedAt < 60000 ? s : load(orgId)
}
const refresh = async (orgId) => { if (orgId) states.delete(Number(orgId)); else states.clear() }
const has = (st, feature) => !st.features || st.features.includes(feature)
// ¿El establecimiento tiene el módulo? (para rutas públicas como la carta QR)
const orgHas = async (orgId, feature) => has(await ensure(orgId), feature)

const featureLabel = async (feature) => {
  const { data: f } = await supabase.from('plan_features').select('label').eq('key', feature).maybeSingle()
  return f?.label || feature
}

// ¿El plan permite esta ruta? Devuelve el mensaje de error o null.
const blockedFor = async (orgId, path) => {
  const feature = featureFor(path)
  if (!feature) return null
  const st = await ensure(orgId)
  if (has(st, feature)) return null
  return `Tu plan ${st.plan.name} no incluye "${await featureLabel(feature)}". El administrador puede pedir un cambio de plan en "Mi plan".`
}

// Uso actual de cada límite (en el contexto del establecimiento).
const usage = async () => {
  const count = async (table, f = (q) => q) => (await f(supabase.from(table).select('id', { count: 'exact', head: true }))).count || 0
  const [sites, admins, employees, tables, products] = await Promise.all([
    count('sites', (q) => q.eq('active', true)),
    count('users', (q) => q.in('role', ['superadmin', 'admin']).eq('active', true)),
    count('users', (q) => q.eq('role', 'empleado').eq('active', true)),
    count('dining_tables', (q) => q.eq('active', true)),
    count('products', (q) => q.eq('active', true))
  ])
  return { sites, admins, employees, tables, products }
}

// Lanza un error si crear `adding` más de `kind` supera el plan.
const checkLimit = async (orgId, kind, adding = 1) => {
  const st = await ensure(orgId)
  if (!st.plan) return
  const [col, label] = LIMITS[kind]
  const max = st.plan[col]
  if (max === null || max === undefined) return
  const used = (await usage())[kind]
  if (used + adding > max) {
    throw new HttpError(max === 0
      ? `Tu plan ${st.plan.name} no incluye ${label}. Pide un plan mayor en "Mi plan".`
      : `Tu plan ${st.plan.name} permite hasta ${max} ${label} y ya tienes ${used}. Pide un plan mayor en "Mi plan".`, 409)
  }
}
const roleLimit = { superadmin: 'admins', admin: 'admins', empleado: 'employees', cliente: null }

// Precio anual con descuento, redondeado a una cifra cómoda según el tamaño del precio.
const annual = (price, discount) => {
  const p = Number(price)
  const step = p >= 100000 ? 1000 : p >= 1000 ? 100 : 1
  return Math.round((p * 12 * (1 - Number(discount) / 100)) / step) * step
}
const limitsDTO = (p) => ({ sites: p.max_sites, admins: p.max_admins, employees: p.max_employees, tables: p.max_tables, products: p.max_products })

module.exports = { FEATURE_ROUTES, featureFor, LIMITS, load, ensure, refresh, has, orgHas, blockedFor, usage, checkLimit, roleLimit, annual, limitsDTO }
