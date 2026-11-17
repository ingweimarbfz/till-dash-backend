const supabase = require('./db')

// Registra una acción en la bitácora. Nunca rompe la petición si falla.
// Los avisos por Telegram (etapa 2) se engancharán aquí, como en QuontUp360.
const audit = async (req, action, entity, entityId = null, detail = null) => {
  try {
    await supabase.from('audit_log').insert({
      user_id: req.user?.id ?? null,
      site_id: req.user?.site_id ?? null,
      action,
      entity,
      entity_id: entityId === null ? null : String(entityId),
      detail,
      ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null
    })
  } catch (e) {
    console.warn('[bitácora]', e.message)
  }
}

module.exports = { audit }
