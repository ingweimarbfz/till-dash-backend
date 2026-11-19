const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { courierFrom, courierDTO, vehicleLabel } = require('../src/courier')
const { courierPatch } = require('../src/routes/users')
const { quickCourierErrors } = require('../src/routes/deliveries')

test('moto y carro llevan placa; bicicleta y patineta no', () => {
  assert.throws(() => courierFrom({ vehicleType: 'moto' }), /placa de la moto/)
  assert.throws(() => courierFrom({ vehicleType: 'carro', vehiclePlate: 'A*1' }), /solo admite/)
  assert.deepEqual(courierFrom({ vehicleType: 'moto', vehiclePlate: 'abc 12d', vehicleHasPlate: false }), { courier_float: 'empresa', courier_external: false, vehicle_type: 'moto', vehicle_has_plate: true, vehicle_plate: 'ABC12D' })
  const bici = courierFrom({ vehicleType: 'bicicleta', vehicleHasPlate: true, vehiclePlate: 'XYZ123' })
  assert.equal(bici.vehicle_has_plate, false); assert.equal(bici.vehicle_plate, null)
  assert.equal(courierFrom({ vehicleType: 'patineta' }).vehicle_has_plate, false)
  assert.equal(courierFrom({ vehicleType: 'otro', vehicleHasPlate: true, vehiclePlate: 'ab-123' }).vehicle_plate, 'AB123')
  assert.throws(() => courierFrom({ vehicleType: 'avion' }), /no válido/)
})

test('base: de la empresa por defecto, propia para el externo', () => {
  assert.equal(courierFrom({}).courier_float, 'empresa')
  assert.equal(courierFrom({ courierFloat: 'propia' }).courier_float, 'propia')
  assert.equal(courierFrom({}, { external: true }).courier_float, 'propia')
  assert.equal(courierFrom({ courierFloat: 'empresa' }, { external: true }).courier_float, 'empresa')
})

test('al dejar de ser domiciliario se limpian sus datos', () => {
  assert.deepEqual(courierPatch({ vehicleType: 'moto', vehiclePlate: 'ABC12D' }, ['mesero']), { courier_float: 'empresa', courier_external: false, vehicle_type: null, vehicle_has_plate: false, vehicle_plate: null })
  assert.equal(courierPatch({ vehicleType: 'moto', vehiclePlate: 'ABC12D' }, ['domiciliario']).vehicle_plate, 'ABC12D')
})

test('etiqueta del vehículo y DTO', () => {
  assert.equal(vehicleLabel({ vehicle_type: 'moto', vehicle_has_plate: true, vehicle_plate: 'ABC12D' }), 'Moto ABC12D')
  assert.equal(vehicleLabel({ vehicle_type: 'patineta' }), 'Patineta eléctrica')
  assert.equal(vehicleLabel({}), null)
  assert.deepEqual(courierDTO({ courier_float: 'propia', courier_external: true, vehicle_type: 'bicicleta' }), { courierFloat: 'propia', courierExternal: true, vehicleType: 'bicicleta', vehicleHasPlate: false, vehiclePlate: null, vehicle: 'Bicicleta' })
})

test('registro rápido: nombre y celular', () => {
  assert.deepEqual(quickCourierErrors({ name: 'Pedro', phone: '3001234567' }), [])
  assert.deepEqual(quickCourierErrors({}), ['Escribe el nombre', 'Escribe el celular'])
  assert.equal(quickCourierErrors({ name: 'P3dro', phone: '12', identification: '1' }).length, 3)
})
