const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { profilesFrom, positionsFrom } = require('../src/routes/users')
const { profilesOf } = require('../src/auth')

test('perfil principal por precedencia y adicionales', () => {
  assert.deepEqual(profilesFrom({ profiles: ['empleado', 'admin'] }), { role: 'admin', extra: ['empleado'] })
  assert.deepEqual(profilesFrom({ role: 'cliente' }), { role: 'cliente', extra: [] })
  assert.throws(() => profilesFrom({ profiles: [] }))
})

test('el empleado necesita al menos un cargo', () => {
  assert.throws(() => positionsFrom({ positions: [] }, 'empleado', []))
  assert.deepEqual(positionsFrom({ positions: ['mesero', 'cajero', 'mesero', 'otro'] }, 'empleado', []), ['mesero', 'cajero'])
  assert.deepEqual(positionsFrom({ positions: ['mesero'] }, 'admin', []), [])
  assert.deepEqual(positionsFrom({ positions: ['cajero'] }, 'admin', ['empleado']), ['cajero'])
})

test('perfiles con los que puede entrar', () => {
  assert.deepEqual(profilesOf({ role: 'admin', extra_roles: ['empleado'] }), ['admin', 'empleado'])
  assert.deepEqual(profilesOf({ role: 'cliente', extra_roles: ['admin'] }), ['cliente'])
})
