// =====================================================================
// Utilidades de la operación (TD-003): permisos por cargo, sucursal de trabajo y errores de la base.
// =====================================================================
const supabase = require('./db')
const { ADMIN } = require('./auth')
const { HttpError, fail } = require('./http')

// El administrador puede todo; el empleado, lo de sus cargos.
const can = (user, ...positions) => ADMIN.includes(user.role) || (user.role === 'empleado' && positions.some((p) => (user.positions || []).includes(p)))
const guard = (...positions) => (req, res, next) => (can(req.user, ...positions) ? next() : fail(res, 'Tu cargo no permite esta acción', 403))

// Sucursal en la que se trabaja: la del empleado, la elegida por el admin (?sede= o siteId) o la principal.
const workSite = async (req, wanted) => {
  if (!ADMIN.includes(req.user.role)) {
    if (!req.user.site_id) throw new HttpError('Tu usuario no tiene sucursal asignada. Pide al administrador que te asigne una.', 400)
    return req.user.site_id
  }
  const id = Number(wanted) || req.siteId
  if (id) {
    const { data } = await supabase.from('sites').select('id').eq('id', id).maybeSingle()
    if (!data) throw new HttpError('Sucursal no encontrada', 404)
    return data.id
  }
  const { data } = await supabase.from('sites').select('id').eq('is_main', true).maybeSingle()
  return data?.id
}

// El empleado solo toca lo de su sucursal.
const sameSite = (req, siteId) => ADMIN.includes(req.user.role) || Number(req.user.site_id) === Number(siteId)

// Errores de las funciones de la base (P0001) llegan como mensaje para el usuario.
const dbError = (res, error) => (error.code === 'P0001' ? fail(res, error.message, 400) : fail(res, error))

const money = (v) => Math.round(Number(v || 0))
const isMoney = (v) => v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0

const PAY_METHODS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', nequi: 'Nequi', daviplata: 'Daviplata', cuenta_por_cobrar: 'Cuenta por cobrar', otro: 'Otro' }
const fullName = (u) => (u ? `${u.name} ${u.last_name || ''}`.trim() : null)

module.exports = { can, guard, workSite, sameSite, dbError, money, isMoney, PAY_METHODS, fullName }
