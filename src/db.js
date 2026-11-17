const { createClient } = require('@supabase/supabase-js')
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = require('./config')
const tenant = require('./tenant')

// Cada consulta tiene un tiempo límite; las lecturas se reintentan una vez si la red falla.
const TIMEOUT = { read: 15000, write: 60000 }
const fetchWithTimeout = async (url, opts = {}) => {
  const method = String(opts.method || 'GET').toUpperCase()
  const read = method === 'GET' || method === 'HEAD'
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('Tiempo de espera agotado con la base de datos')), read ? TIMEOUT.read : TIMEOUT.write)
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal })
    } catch (e) {
      if (!read || attempt >= 1) throw e
    } finally { clearTimeout(timer) }
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fetchWithTimeout }
})
tenant.scopeClient(supabase)

module.exports = supabase
