const test = require('node:test')
const assert = require('node:assert')
process.env.SUPABASE_URL ||= 'http://x'; process.env.SUPABASE_SECRET_KEY ||= 'x'; process.env.JWT_SECRET ||= 'x'
const { fold, safe } = require('../src/routes/search')
const { dayStart, nextDay } = require('../src/routes/logbook')
const { COLOR_RE, FONTS } = require('../src/routes/settings')

test('buscador ignora tildes y limpia caracteres de filtro', () => {
  assert.equal(fold('  Bodéga Ñ '), 'bodega n')
  assert.equal(safe('a,b(c)%'), 'a b c')
})

test('días de Colombia en UTC', () => {
  assert.equal(dayStart('2026-11-17'), '2026-11-17T05:00:00.000Z')
  assert.equal(nextDay('2026-11-17'), '2026-11-18T05:00:00.000Z')
})

test('colores y fuentes de la apariencia', () => {
  assert.ok(COLOR_RE.test('#E4572E'))
  assert.ok(!COLOR_RE.test('E4572E'))
  assert.ok(FONTS.includes('Outfit'))
})
