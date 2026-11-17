// =====================================================================
// Notificaciones por Telegram (TD-002, modelo de QuontUp360 e integra-ips)
// · Cada establecimiento conecta su bot (token de @BotFather) y elige qué grupos reciben cada sección.
// · Un grupo pertenece a una sucursal (solo recibe lo de esa sucursal) o a todas.
// · El envío corre en segundo plano y nunca hace fallar la petición que lo origina.
// · Secciones: inventario (stock bajo, entradas, bajas y traslados). Pedidos, caja y mesas llegan
//   en la etapa 3; se listan para que el establecimiento deje listos sus grupos.
// =====================================================================
const supabase = require('./db')

const SECTIONS = {
  inventario: { label: 'Inventario', hint: 'Productos que llegan al mínimo o se agotan, entradas, bajas y traslados entre bodegas' },
  pedidos: { label: 'Pedidos', hint: 'Pedidos nuevos, cortesías y anulaciones (etapa 3)', soon: true },
  caja: { label: 'Caja y bóveda', hint: 'Apertura y cierre de caja, traslados a la bóveda (etapa 3)', soon: true },
  mesas: { label: 'Mesas', hint: 'Llamados de mesa desde el QR (etapa 3)', soon: true },
  resumen: { label: 'Resumen diario', hint: 'Ventas, órdenes y propinas del día (etapa 3)', soon: true }
}
const API = 'https://api.telegram.org'
const TZ = 'America/Bogota'
// Enlace a la app en cada aviso: PUBLIC_APP_URL o el primer origen permitido que no sea local.
const APP_URL = () => (process.env.PUBLIC_APP_URL || (process.env.CORS_ORIGIN || '').split(',').map((o) => o.trim()).find((o) => /^https:\/\//.test(o)) || '').replace(/\/$/, '')

const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const qty = (v) => Number(v || 0).toLocaleString('es-CO', { maximumFractionDigits: 3 })
const fullName = (x) => (x ? `${x.name} ${x.last_name || ''}`.trim() : '—')
const hour = (d = new Date()) => new Intl.DateTimeFormat('es-CO', { timeStyle: 'short', timeZone: TZ }).format(new Date(d))
const SEP = '━━━━━━━━━━━━━━━'

const tgError = (message, extra = {}) => Object.assign(new Error(message), { status: 400, ...extra })
const tg = async (token, method, body) => {
  const r = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) })
  const j = await r.json().catch(() => ({}))
  if (!j.ok) throw tgError(`Telegram: ${j.description || `error ${r.status}`}`, { migrateTo: j.parameters?.migrate_to_chat_id ? String(j.parameters.migrate_to_chat_id) : null })
  return j.result
}
// Si Telegram convierte el grupo en supergrupo, cambia su id: se actualiza y se reintenta.
const sendTo = async (token, chatId, html) => {
  const body = (id) => ({ chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
  try { await tg(token, 'sendMessage', body(chatId)); return String(chatId) } catch (e) {
    if (!e.migrateTo) throw e
    await supabase.from('notification_channels').update({ chat_id: e.migrateTo }).eq('chat_id', String(chatId))
    await tg(token, 'sendMessage', body(e.migrateTo))
    return e.migrateTo
  }
}
const loadSettings = async () => (await supabase.from('notification_settings').select('*').maybeSingle()).data
const withLink = (html, path) => (path && APP_URL() ? `${html}\n🔗 <a href="${APP_URL()}${path}">Abrir en TillDash+</a>` : html)

// Envía a los grupos de la sección: los de la sucursal del aviso y los de todas las sucursales.
// build() devuelve { html, siteId, path } o null.
const send = async (section, build) => {
  if (!SECTIONS[section]) return
  const st = await loadSettings()
  if (!st?.enabled || !st.bot_token) return
  const { data: chans } = await supabase.from('notification_channels').select('chat_id, site_id').eq('section', section).eq('enabled', true)
  if (!chans?.length) return
  const msg = await build()
  if (!msg) return
  const siteId = msg.siteId ?? null
  const targets = chans.filter((c) => c.site_id === null || (siteId && Number(c.site_id) === Number(siteId)))
  const html = withLink(msg.html, msg.path)
  for (const c of targets) {
    let status = 'enviado'; let detail = null; let sentTo = c.chat_id
    try { sentTo = await sendTo(st.bot_token, c.chat_id, html) } catch (e) { status = 'error'; detail = e.message.slice(0, 300) }
    await supabase.from('notification_log').insert({ section, chat_id: sentTo, status, detail, site_id: siteId })
  }
}
const notify = (section, build) => { send(section, build).catch((e) => console.error('Telegram:', e.message)) }

// ---------------------------------------------------------------------
// Mensajes de inventario
// ---------------------------------------------------------------------
const placeLine = (w) => `🏬 ${esc(w.name)}${w.site ? ` · 📍 ${esc(w.site)}` : w.isMain ? ' (principal)' : ''}`

// rows: [{ name, unit, stock, minStock, warehouse: { name, site, siteId, isMain } }] de una misma sucursal.
const lowStockMessage = (rows) => {
  const out = rows.filter((r) => Number(r.stock) <= 0)
  const low = rows.filter((r) => Number(r.stock) > 0)
  const w = rows[0].warehouse
  const line = (r) => `• <b>${esc(r.name)}</b>: ${qty(r.stock)} ${esc(r.unit)} (mínimo ${qty(r.minStock)})`
  return {
    siteId: w.siteId, path: '/inventario?tab=existencias',
    html: `${out.length && !low.length ? '⛔ <b>PRODUCTOS AGOTADOS</b>' : '⚠️ <b>STOCK BAJO</b>'}\n${SEP}\n${placeLine(w)}\n` +
      (out.length ? `\n⛔ Agotados:\n${out.map(line).join('\n')}\n` : '') +
      (low.length ? `\n⚠️ En el mínimo o por debajo:\n${low.map(line).join('\n')}\n` : '') +
      `\n🕒 ${hour()}`
  }
}

const MOVE_HEAD = { entrada: '📥 <b>ENTRADA DE INVENTARIO', ajuste: '🛠️ <b>AJUSTE DE INVENTARIO', baja: '🗑️ <b>BAJA DE INVENTARIO' }
// items: [{ name, unit, quantity }]
const movementMessage = ({ type, ref, warehouse, items, note, user }) => ({
  siteId: warehouse.siteId, path: '/inventario?tab=movimientos',
  html: `${MOVE_HEAD[type]} · ${esc(ref)}</b>\n${SEP}\n${placeLine(warehouse)}\n` +
    items.map((i) => `• ${esc(i.name)}: <b>${Number(i.quantity) > 0 ? '+' : ''}${qty(i.quantity)}</b> ${esc(i.unit)}`).join('\n') +
    (note ? `\n📝 ${esc(note)}` : '') + `\n🧑‍💼 ${esc(fullName(user))} · 🕒 ${hour()}`
})

const transferMessage = ({ ref, from, to, items, note, user }) => ({
  siteId: to.siteId ?? from.siteId, path: '/inventario?tab=movimientos',
  html: `🚚 <b>TRASLADO ENTRE BODEGAS · ${esc(ref)}</b>\n${SEP}\n📤 Sale de: ${placeLine(from).slice(3)}\n📥 Llega a: ${placeLine(to).slice(3)}\n` +
    items.map((i) => `• ${esc(i.name)}: <b>${qty(i.quantity)}</b> ${esc(i.unit)}`).join('\n') +
    (note ? `\n📝 ${esc(note)}` : '') + `\n🧑‍💼 ${esc(fullName(user))} · 🕒 ${hour()}`
})

module.exports = { SECTIONS, tg, esc, qty, loadSettings, notify, send, lowStockMessage, movementMessage, transferMessage }
