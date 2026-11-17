require('dotenv').config()

const {
  SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET,
  PORT = 4000, CORS_ORIGIN = 'http://localhost:3000', SESSION_HOURS = 12
} = process.env

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !JWT_SECRET) {
  console.error('Faltan SUPABASE_URL, SUPABASE_SECRET_KEY o JWT_SECRET en el archivo .env (ver .env.example)')
  process.exit(1)
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  JWT_SECRET,
  PORT: Number(PORT),
  CORS_ORIGINS: CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean),
  SESSION_HOURS: Number(SESSION_HOURS),
  TZ: 'America/Bogota'
}
