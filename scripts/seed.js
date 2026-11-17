// Crea un establecimiento (organización) con su super administrador.
// La base crea sola la configuración, la "Sede principal" y la "Bodega principal".
// Uso: npm run seed -- "Nombre del establecimiento" usuario "Contraseña" [Nombre] [Apellido] [Identificación] [tipo]
require('dotenv').config()
const bcrypt = require('bcryptjs')
const supabase = require('../src/db')

const [name, username, password, first = 'Super', lastName = 'Administrador', identification = '0000000', type = 'restaurante'] = process.argv.slice(2)
if (!name || !username || !password) {
  console.error('Uso: npm run seed -- "Nombre del establecimiento" usuario "Contraseña" [Nombre] [Apellido] [Identificación] [tipo]')
  process.exit(1)
}

;(async () => {
  const { data: org, error } = await supabase.from('organizations').insert({ name, status: 'activa', business_type: type }).select().single()
  if (error) throw error
  const { data: site } = await supabase.from('sites').select('id').eq('org_id', org.id).eq('is_main', true).single()
  const { error: e2 } = await supabase.from('users').insert({
    org_id: org.id, site_id: site?.id ?? null, identification, name: first, last_name: lastName,
    username: username.toLowerCase(), role: 'superadmin', password_hash: await bcrypt.hash(password, 10)
  })
  if (e2) throw e2
  console.log(`Establecimiento "${name}" (id ${org.id}) creado con el super administrador ${username}`)
})().catch((e) => { console.error(e.message); process.exit(1) })
