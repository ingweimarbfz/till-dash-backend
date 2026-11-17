const jwt = require('jsonwebtoken')
const supabase = require('./db')
const tenant = require('./tenant')
const { JWT_SECRET, SESSION_HOURS } = require('./config')
const { fail } = require('./http')

// Roles de TillDash+:
// · superadmin: dueño del establecimiento; todo el sistema, incluida la apariencia del sitio.
// · admin: administra la operación; todo menos la apariencia del sitio (colores, logo, fuente).
// · empleado: mesero, cajero, cocina, bartender… (cargos en positions); ve lo de su sucursal.
// · cliente: entra a su mesa por QR, ve la carta y sus pedidos.
const ROLES = ['superadmin', 'admin', 'empleado', 'cliente']
const ROLE_LABELS = { superadmin: 'Super administrador', admin: 'Administrador', empleado: 'Empleado', cliente: 'Cliente' }
const POSITIONS = ['mesero', 'cajero', 'cocina', 'bartender', 'barista', 'domiciliario', 'host', 'bodega']
const POSITION_LABELS = { mesero: 'Mesero', cajero: 'Cajero', cocina: 'Cocina', bartender: 'Bartender', barista: 'Barista', domiciliario: 'Domiciliario', host: 'Anfitrión', bodega: 'Bodega' }
const OWNER = ['superadmin']
const ADMIN = ['superadmin', 'admin']
const STAFF = ['superadmin', 'admin', 'empleado']
const ALL = ROLES

const USER_COLUMNS = 'id, org_id, site_id, identification, name, last_name, username, email, phone, role, extra_roles, positions, avatar_url, active, last_login_at, created_at, site:sites(id, name, city)'

// Perfiles con los que puede entrar un usuario: el principal y los adicionales (como en QuontUp360).
const PROFILE_ORDER = ['superadmin', 'admin', 'empleado']
const profilesOf = (u) => {
  const base = u.primary_role || u.role
  if (base === 'cliente') return ['cliente']
  const set = new Set([base, ...(u.extra_roles || [])])
  return PROFILE_ORDER.filter((r) => set.has(r))
}

const toUserDTO = (u) => ({
  id: u.id,
  orgId: u.org_id,
  identification: u.identification,
  name: u.name,
  lastName: u.last_name,
  fullName: `${u.name} ${u.last_name || ''}`.trim(),
  username: u.username,
  email: u.email,
  phone: u.phone,
  role: u.role,
  roleLabel: ROLE_LABELS[u.role],
  primaryRole: u.primary_role || u.role,
  extraRoles: u.extra_roles || [],
  positions: u.positions || [],
  profiles: profilesOf(u),
  avatarUrl: u.avatar_url,
  active: u.active,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
  siteId: u.site_id ?? null,
  site: u.site ? { id: u.site.id, name: u.site.name, city: u.site.city } : null
})

// El token lleva el perfil con el que entró.
const signToken = (user, role = user.role) => jwt.sign({ sub: String(user.id), org: user.org_id, role }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` })

// Sucursal de trabajo: el admin puede elegir una con ?sede= (o ninguna = todas). El empleado queda en la suya.
const loadSite = (req) => {
  const chosen = Number(req.query?.sede) || null
  req.siteId = ADMIN.includes(req.user.role) ? chosen : (req.user.site_id ?? null)
}

// Valida el token y vuelve a leer el usuario: un cambio de rol o una desactivación aplican de inmediato.
// El resto de la petición corre en el contexto de la organización del usuario.
const auth = (roles = ALL) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return fail(res, 'Debes iniciar sesión', 401)
    let payload
    try { payload = jwt.verify(token, JWT_SECRET) } catch { return fail(res, 'Tu sesión expiró. Inicia sesión de nuevo.', 401) }

    const { data: user, error } = await supabase.from('users')
      .select(`${USER_COLUMNS}, org:organizations(id, status)`).eq('id', Number(payload.sub)).maybeSingle()
    if (error) throw error
    if (!user || !user.active) return fail(res, 'Usuario inactivo o inexistente', 401)
    if (['suspendida', 'cancelada'].includes(user.org?.status)) return fail(res, 'El servicio de tu establecimiento está suspendido. Contacta a TillDash+.', 401)
    user.primary_role = user.role
    if (payload.role && payload.role !== user.role && profilesOf(user).includes(payload.role)) user.role = payload.role
    if (!roles.includes(user.role)) return fail(res, 'No tienes permiso para esta acción', 403)
    req.user = user
    return tenant.runAsOrg(user.org_id, () => { loadSite(req); return next() })
  } catch (e) {
    fail(res, e)
  }
}

module.exports = { ROLES, ROLE_LABELS, POSITIONS, POSITION_LABELS, PROFILE_ORDER, OWNER, ADMIN, STAFF, ALL, USER_COLUMNS, profilesOf, toUserDTO, signToken, auth }
