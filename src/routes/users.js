// =====================================================================
// Usuarios del establecimiento
// · Un usuario puede tener varios perfiles: role (principal) + extra_roles (como en QuontUp360).
// · El empleado tiene uno o varios cargos (mesero, cajero, cocina…), que definen su dashboard y,
//   más adelante, el reparto de propinas.
// · Solo el superadmin crea o edita superadmins; siempre debe quedar uno activo.
// · La contraseña inicial es el número de identificación.
// · La forma de pago solo la ve y cambia quien tiene el permiso de pagos (superadmin o admin asignado).
// =====================================================================
const express = require('express')
const bcrypt = require('bcryptjs')
const supabase = require('../db')
const { h, fail, clean, EMAIL_RE, PHONE_RE, DOC_RE, NAME_RE, imageError, HttpError } = require('../http')
const { auth, ADMIN, ROLES, POSITIONS, PROFILE_ORDER, USER_COLUMNS, toUserDTO, canManagePay } = require('../auth')
const { audit } = require('../audit')
const plan = require('../plan')
const { COURIER_COLUMNS, courierFrom, NOT_COURIER, courierDTO } = require('../courier')

const router = express.Router()

const validate = (b) => {
  const errors = []
  for (const [k, label] of [['identification', 'Identificación'], ['name', 'Nombre'], ['username', 'Usuario']]) {
    if (!clean(b[k])) errors.push(`${label} es requerido`)
  }
  if (clean(b.identification) && !DOC_RE.test(clean(b.identification))) errors.push('Identificación no válida')
  if (clean(b.name) && !NAME_RE.test(clean(b.name))) errors.push('Los nombres solo admiten letras')
  if (clean(b.lastName) && !NAME_RE.test(clean(b.lastName))) errors.push('Los apellidos solo admiten letras')
  if (clean(b.username) && !/^[a-z0-9._-]{3,30}$/i.test(clean(b.username))) errors.push('El usuario solo admite letras, números, punto, guion y guion bajo (3 a 30)')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) errors.push('Correo no válido')
  if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) errors.push('Teléfono no válido (7 a 10 dígitos)')
  if (b.password && String(b.password).length < 8) errors.push('La contraseña debe tener al menos 8 caracteres')
  const e = imageError(b.avatarUrl, 300)
  if (e) errors.push(e)
  return errors
}

// Perfiles pedidos → perfil principal y adicionales. Precedencia: superadmin > admin > empleado.
const profilesFrom = (b) => {
  const list = Array.isArray(b.profiles) && b.profiles.length ? b.profiles : [b.role]
  if (list.includes('cliente')) return { role: 'cliente', extra: [] }
  const set = PROFILE_ORDER.filter((r) => list.includes(r))
  if (!set.length) throw new HttpError('Elige al menos un perfil: superadmin, admin o empleado')
  return { role: set[0], extra: set.slice(1).filter((r) => r !== 'superadmin') }
}
const positionsFrom = (b, role, extra) => {
  const isEmployee = role === 'empleado' || extra.includes('empleado')
  const list = (Array.isArray(b.positions) ? b.positions : []).filter((p) => POSITIONS.includes(p))
  if (isEmployee && !list.length) throw new HttpError('Elige al menos un cargo para el perfil de empleado (mesero, cajero, cocina…)')
  return isEmployee ? [...new Set(list)] : []
}

// Forma de pago (TD-020): por turno (horas × valor de la hora), nómina (salario quincenal o mensual) o ninguna.
const PAY_MODES = ['ninguno', 'turno', 'nomina']
const PAY_COLUMNS = `${USER_COLUMNS}, pay_mode, hour_rate, overtime_rate, salary, pay_period, courier_pay, ${COURIER_COLUMNS}`
// Los datos de pago solo los ve quien tiene el permiso de pagos (TD-021).
const withPay = (u, show = true) => (!show ? { ...toUserDTO(u), ...courierDTO(u) } : { ...toUserDTO(u), ...courierDTO(u), payMode: u.pay_mode || 'ninguno', hourRate: Number(u.hour_rate || 0), overtimeRate: Number(u.overtime_rate || 0), salary: Number(u.salary || 0), payPeriod: u.pay_period || 'mensual', courierPay: u.courier_pay || 'domicilios' })
// Permiso de pagos: solo el super administrador lo da, y solo a administradores.
const payPermission = (req, b, role) => (req.user.role === 'superadmin' && b.canManagePay !== undefined ? { can_manage_pay: role === 'admin' && Boolean(b.canManagePay) } : {})
const payFrom = (b) => {
  const mode = PAY_MODES.includes(b.payMode) ? b.payMode : 'ninguno'
  const hourRate = Math.round(Number(b.hourRate) || 0)
  const overtimeRate = Math.round(Number(b.overtimeRate) || 0)
  const salary = Math.round(Number(b.salary) || 0)
  if (hourRate < 0 || overtimeRate < 0 || salary < 0) throw new HttpError('Los valores de pago no pueden ser negativos')
  if (mode === 'turno' && !hourRate) throw new HttpError('Escribe el valor de la hora para pagarle por turnos')
  if (mode === 'nomina' && !salary) throw new HttpError('Escribe el salario de la quincena o del mes')
  // Domiciliario por jornada (TD-021): se le paga como empleado, así que necesita turno o nómina.
  const courierPay = b.courierPay === 'jornada' ? 'jornada' : 'domicilios'
  if (courierPay === 'jornada' && (b.positions || []).includes('domiciliario') && mode === 'ninguno') throw new HttpError('Al domiciliario por jornada elígele pago por turno o por nómina')
  return { courier_pay: courierPay, pay_mode: mode, hour_rate: mode === 'turno' ? hourRate : 0, overtime_rate: mode === 'turno' ? overtimeRate : 0, salary: mode === 'nomina' ? salary : 0, pay_period: b.payPeriod === 'quincenal' ? 'quincenal' : 'mensual' }
}

// TD-026: el domiciliario externo no trabaja para la empresa. Solo se le paga por domicilios (su parte del
// valor de cada uno); nunca por jornada, turno ni nómina. Se aplica después de payFrom y sin importar el permiso.
const externalPay = (courier) => (courier?.courier_external ? { courier_pay: 'domicilios', pay_mode: 'ninguno', hour_rate: 0, overtime_rate: 0, salary: 0 } : {})

// Base y vehículo del domiciliario (TD-022): lo edita cualquier administrador; no depende del permiso de pagos.
const courierPatch = (b, positions) => (positions.includes('domiciliario') ? courierFrom(b) : NOT_COURIER)

const dupMessage = (e) => (e?.code === '23505'
  ? (String(e.message).includes('username') ? 'Ese nombre de usuario ya existe' : 'Ya existe un usuario con esa identificación')
  : null)

const activeOwners = async (excludeId) => {
  const { count, error } = await supabase.from('users').select('id', { count: 'exact', head: true })
    .eq('role', 'superadmin').eq('active', true).neq('id', excludeId)
  if (error) throw error
  return count
}

router.get('/usuarios', auth(ADMIN), h(async (req, res) => {
  let q = supabase.from('users').select(PAY_COLUMNS).is('deleted_at', null).order('name')
  if (req.siteId) q = q.or(`site_id.eq.${req.siteId},role.in.(superadmin,admin)`)
  const { data, error } = await q
  if (error) throw error
  const rol = ROLES.includes(req.query.rol) ? req.query.rol : null
  const cargo = POSITIONS.includes(req.query.cargo) ? req.query.cargo : null
  res.send(data
    .filter((u) => !rol || u.role === rol || (u.extra_roles || []).includes(rol))
    .filter((u) => !cargo || (u.positions || []).includes(cargo))
    .map((u) => withPay(u, canManagePay(req.user))))
}))

router.post('/usuarios', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const { role, extra } = profilesFrom(b)
  if (role === 'superadmin' && req.user.role !== 'superadmin') return fail(res, 'Solo un super administrador puede crear otro', 403)
  const positions = positionsFrom(b, role, extra)
  const errors = validate(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  if (plan.roleLimit[role] && b.active !== false) await plan.checkLimit(req.user.org_id, plan.roleLimit[role])
  const { data, error } = await supabase.from('users').insert({
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName) || '',
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    role,
    extra_roles: extra,
    positions,
    site_id: Number(b.siteId) || null,
    avatar_url: clean(b.avatarUrl),
    password_hash: await bcrypt.hash(String(b.password || clean(b.identification)), 10),
    active: b.active !== false,
    ...courierPatch(b, positions),
    ...(b.payMode !== undefined && canManagePay(req.user) ? payFrom({ ...b, ...(courierPatch(b, positions).courier_external ? { courierPay: 'domicilios', payMode: 'ninguno' } : {}) }) : {}),
    ...externalPay(courierPatch(b, positions)),
    ...payPermission(req, b, role)
  }).select(PAY_COLUMNS).single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  await audit(req, 'crear', 'usuario', data.id, { role, extra, positions, username: data.username })
  res.status(201).send(withPay(data, canManagePay(req.user)))
}))

// ---------------------------------------------------------------- Eliminar (TD-029)
// El super administrador no se elimina, ni uno mismo. Solo un super administrador elimina administradores.
// Sin historial se borra de verdad. Con historial (pedidos, caja, pagos, bitácora…) se elimina en blando:
// deleted_at, inactivo y con usuario e identificación liberados; los reportes siguen mostrando su nombre.
const HISTORY = [
  ['orders', 'waiter_id'], ['orders', 'opened_by'], ['orders', 'cashier_id'], ['orders', 'courier_id'], ['order_items', 'user_id'],
  ['order_payments', 'user_id'], ['cash_sessions', 'opened_by'], ['cash_movements', 'user_id'], ['inventory_movements', 'user_id'],
  ['tip_payouts', 'user_id'], ['courier_payouts', 'user_id'], ['courier_floats', 'user_id'], ['staff_earnings', 'user_id'],
  ['expenses', 'created_by'], ['incidents', 'reported_by'], ['audit_log', 'user_id'], ['plan_requests', 'requested_by']
]
const hasHistory = async (id) => {
  const counts = await Promise.all(HISTORY.map(([t, c]) => supabase.from(t).select(c, { count: 'exact', head: true }).eq(c, id).then((r) => r.count || 0, () => 0)))
  return counts.some((n) => n > 0)
}
router.delete('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  if (id === req.user.id) return fail(res, 'No puedes eliminar tu propio usuario', 400)
  const { data: u } = await supabase.from('users').select('id, role, name, last_name, username, identification, deleted_at').eq('id', id).maybeSingle()
  if (!u || u.deleted_at) return fail(res, 'Usuario no encontrado', 404)
  if (u.role === 'superadmin') return fail(res, 'El super administrador no se puede eliminar', 403)
  if (u.role === 'admin' && req.user.role !== 'superadmin') return fail(res, 'Solo el super administrador puede eliminar administradores', 403)
  const name = `${u.name} ${u.last_name || ''}`.trim()
  if (!(await hasHistory(id))) {
    const { error } = await supabase.from('users').delete().eq('id', id)
    if (!error) {
      await audit(req, 'eliminar', 'usuario', id, { name, username: u.username, mode: 'definitivo' })
      return res.send({ ok: true, mode: 'definitivo' })
    }
    if (error.code !== '23503') throw error // con otra referencia: se elimina en blando
  }
  const tag = `eliminado-${id}`
  const { error } = await supabase.from('users').update({
    deleted_at: new Date().toISOString(), active: false, can_manage_pay: false,
    username: `${u.username}.${tag}`.slice(0, 80), identification: `${u.identification}-${tag}`.slice(0, 40)
  }).eq('id', id)
  if (error) throw error
  await audit(req, 'eliminar', 'usuario', id, { name, username: u.username, mode: 'historial' })
  res.send({ ok: true, mode: 'historial' })
}))

router.put('/usuarios/:id', auth(ADMIN), h(async (req, res) => {
  const id = Number(req.params.id)
  const b = req.body || {}
  const { role, extra } = profilesFrom(b)
  const positions = positionsFrom(b, role, extra)
  const errors = validate(b)
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { data: current } = await supabase.from('users').select('id, role, active').eq('id', id).maybeSingle()
  if (!current) return fail(res, 'Usuario no encontrado', 404)
  if ((current.role === 'superadmin' || role === 'superadmin') && req.user.role !== 'superadmin') return fail(res, 'Solo un super administrador puede editar a otro', 403)
  const losesOwner = current.role === 'superadmin' && current.active && (role !== 'superadmin' || b.active === false)
  if (losesOwner && (await activeOwners(id)) === 0) return fail(res, 'Debe quedar al menos un super administrador activo', 400)
  // Reactivar o pasar a otro grupo de roles cuenta contra el límite del plan.
  const kind = plan.roleLimit[role]
  if (kind && b.active !== false && (!current.active || plan.roleLimit[current.role] !== kind)) await plan.checkLimit(req.user.org_id, kind)
  const patch = {
    identification: clean(b.identification),
    name: clean(b.name),
    last_name: clean(b.lastName) || '',
    username: clean(b.username).toLowerCase(),
    email: clean(b.email),
    phone: clean(b.phone),
    role,
    extra_roles: extra,
    positions,
    site_id: Number(b.siteId) || null,
    active: b.active !== false
  }
  if (b.avatarUrl !== undefined) patch.avatar_url = clean(b.avatarUrl)
  const courier = courierPatch(b, positions)
  Object.assign(patch, courier)
  if (b.payMode !== undefined && canManagePay(req.user)) Object.assign(patch, payFrom(courier.courier_external ? { ...b, courierPay: 'domicilios', payMode: 'ninguno' } : b))
  Object.assign(patch, externalPay(courier))
  Object.assign(patch, payPermission(req, b, role))
  if (b.resetPassword) patch.password_hash = await bcrypt.hash(String(patch.identification), 10)
  else if (b.password) patch.password_hash = await bcrypt.hash(b.password, 10)
  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select(PAY_COLUMNS).single()
  if (error) return dupMessage(error) ? fail(res, dupMessage(error), 409) : fail(res, error)
  await audit(req, 'editar', 'usuario', id, { role, extra, positions, active: data.active, password: Boolean(b.resetPassword || b.password) })
  res.send(withPay(data, canManagePay(req.user)))
}))

module.exports = router
module.exports.profilesFrom = profilesFrom
module.exports.positionsFrom = positionsFrom
module.exports.payFrom = payFrom
module.exports.courierPatch = courierPatch
