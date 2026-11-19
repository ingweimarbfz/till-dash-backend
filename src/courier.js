// =====================================================================
// Datos del domiciliario (TD-022): con qué base trabaja, si es externo y su vehículo.
// · Base de la empresa: la caja le entrega base de cambio y la liquida al final.
// · Base propia: trabaja con su dinero; no se le da base (el externo trabaja así por defecto).
// · Moto y carro llevan placa; bicicleta, patineta eléctrica y a pie no. "Otro" puede llevarla o no.
// =====================================================================
const { HttpError } = require('./http')

const VEHICLES = { moto: 'Moto', carro: 'Carro', bicicleta: 'Bicicleta', patineta: 'Patineta eléctrica', a_pie: 'A pie', otro: 'Otro' }
const WITH_PLATE = ['moto', 'carro']
const NO_PLATE = ['bicicleta', 'patineta', 'a_pie']
const PLATE_RE = /^[A-Z0-9]{4,8}$/
const COURIER_COLUMNS = 'courier_float, courier_external, vehicle_type, vehicle_has_plate, vehicle_plate'

const normPlate = (v) => String(v || '').toUpperCase().replace(/[\s.-]/g, '')

// Cuerpo de la petición → columnas. `external` fuerza si es externo (registro rápido).
const courierFrom = (b, { external } = {}) => {
  const type = b.vehicleType ? String(b.vehicleType) : null
  if (type && !VEHICLES[type]) throw new HttpError('Tipo de vehículo no válido')
  const hasPlate = WITH_PLATE.includes(type) ? true : NO_PLATE.includes(type) || !type ? false : Boolean(b.vehicleHasPlate)
  const plate = hasPlate ? normPlate(b.vehiclePlate) : ''
  if (hasPlate && !plate) throw new HttpError(`Escribe la placa ${type === 'moto' ? 'de la moto' : type === 'carro' ? 'del carro' : 'del vehículo'}`)
  if (hasPlate && !PLATE_RE.test(plate)) throw new HttpError('La placa solo admite letras y números (4 a 8), por ejemplo ABC123 o ABC12D')
  const isExternal = external ?? Boolean(b.courierExternal)
  const float = b.courierFloat === 'propia' || b.courierFloat === 'empresa' ? b.courierFloat : isExternal ? 'propia' : 'empresa'
  return { courier_float: float, courier_external: isExternal, vehicle_type: type, vehicle_has_plate: hasPlate, vehicle_plate: plate || null }
}
// Columnas que se limpian cuando el usuario deja de ser domiciliario.
const NOT_COURIER = { courier_float: 'empresa', courier_external: false, vehicle_type: null, vehicle_has_plate: false, vehicle_plate: null }

const vehicleLabel = (u) => (u?.vehicle_type ? `${VEHICLES[u.vehicle_type] || u.vehicle_type}${u.vehicle_has_plate && u.vehicle_plate ? ` ${u.vehicle_plate}` : ''}` : null)
const courierDTO = (u) => ({
  courierFloat: u.courier_float || 'empresa', courierExternal: Boolean(u.courier_external),
  vehicleType: u.vehicle_type || null, vehicleHasPlate: Boolean(u.vehicle_has_plate), vehiclePlate: u.vehicle_plate || null, vehicle: vehicleLabel(u)
})

module.exports = { VEHICLES, WITH_PLATE, NO_PLATE, COURIER_COLUMNS, courierFrom, NOT_COURIER, courierDTO, vehicleLabel, normPlate }
