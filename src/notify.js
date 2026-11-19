// =====================================================================
// Notificaciones por Telegram (TD-002, modelo de QuontUp360 e integra-ips)
// · Cada establecimiento conecta su bot (token de @BotFather) y elige qué grupos reciben cada sección.
// · Un grupo pertenece a una sucursal (solo recibe lo de esa sucursal) o a todas.
// · El envío corre en segundo plano y nunca hace fallar la petición que lo origina.
// · Secciones: inventario (stock bajo, entradas, bajas y traslados), pedidos (anulaciones y cortesías),
//   caja (apertura, cierre y bóveda) y mesas (llamados desde el QR). El resumen diario llega en la etapa 4.
// =====================================================================
const supabase = require('./db')

const SECTIONS = {
  inventario: { label: 'Inventario', hint: 'Productos que llegan al mínimo o se agotan, entradas, bajas y traslados entre bodegas' },
  pedidos: { label: 'Pedidos', hint: 'Cortesías, anulaciones de productos y de pedidos completos' },
  caja: { label: 'Caja y bóveda', hint: 'Apertura y cierre de turnos con el arqueo, retiros y consignaciones de la bóveda' },
  mesas: { label: 'Mesas', hint: 'Llamados al mesero y cuentas pedidas desde el QR de la mesa' },
  incidentes: { label: 'Incidentes', hint: 'Platos rotos, daños, faltantes y accidentes reportados por el equipo' },
  domicilios: { label: 'Domicilios', hint: 'El domiciliario avisa que recibió el dinero de un domicilio en efectivo, para cobrarlo en caja' },
  resumen: { label: 'Resumen diario', hint: 'Ventas, órdenes y propinas del día (etapa 4)', soon: true }
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

// ---------- Etapa 3: pedidos, caja y mesas ----------
const cop = (v) => `$${Math.round(Number(v || 0)).toLocaleString('es-CO')}`
const lines = (a) => a.filter(Boolean).join('\n')
const who = (user) => `👤 ${esc(fullName(user))} · ${hour()}`

const courtesyMessage = ({ order, item, reason, user, siteId, site }) => ({
  siteId, path: `/pedidos/${order.id}`,
  html: lines([`🎁 <b>CORTESÍA · ${esc(order.number)}</b>`, SEP, `${qty(item.quantity)} × ${esc(item.name)} · ${cop(item.quantity * item.unit_price)}`,
    `📝 ${esc(reason)}`, site ? `📍 ${esc(site)}` : null, who(user)])
})
const voidMessage = ({ order, items, reason, user, siteId, site, whole }) => ({
  siteId, path: `/pedidos/${order.id}`,
  html: lines([`🚫 <b>${whole ? 'PEDIDO ANULADO' : 'PRODUCTO ANULADO'} · ${esc(order.number)}</b>`, SEP,
    ...items.map((i) => `• ${qty(i.quantity)} × ${esc(i.name)} · ${cop(i.quantity * i.unit_price)}`),
    `📝 ${esc(reason)}`, site ? `📍 ${esc(site)}` : null, who(user)])
})
const cashOpenMessage = ({ number, register, site, siteId, amount, fromVault, user }) => ({
  siteId, path: '/caja',
  html: lines([`🔓 <b>APERTURA DE CAJA · ${esc(number)}</b>`, SEP, `💵 ${esc(register)} · base ${cop(amount)}${fromVault ? ' (desde la bóveda)' : ''}`,
    site ? `📍 ${esc(site)}` : null, who(user)])
})
const cashCloseMessage = ({ number, register, site, siteId, sales, byMethod, expected, counted, difference, toVault, tips, orders, user, tipsPaid = [], couriersPaid = [], nextFloat = 0, note }) => ({
  siteId, path: '/caja',
  html: lines([`🔒 <b>CIERRE DE CAJA · ${esc(number)}</b>`, SEP, `💵 ${esc(register)}${site ? ` · 📍 ${esc(site)}` : ''}`,
    `🧾 ${orders} pedido${orders === 1 ? '' : 's'} · ventas ${cop(sales)} · propinas ${cop(tips)}`,
    ...Object.entries(byMethod).map(([m, v]) => `   ${esc(m)}: ${cop(v)}`),
    `Efectivo esperado: ${cop(expected)}`, `Efectivo contado: ${cop(counted)}`,
    Number(difference) === 0 ? '✅ Cuadra exacto' : `${difference > 0 ? '⬆️ Sobrante' : '⚠️ Faltante'}: ${cop(Math.abs(difference))}`,
    tipsPaid.length ? `🤝 Propinas pagadas:` : null, ...tipsPaid.map((t) => `   ${esc(t.name)}: ${cop(t.amount)}`),
    couriersPaid.length ? `🛵 Domiciliarios:` : null, ...couriersPaid.map((t) => `   ${esc(t.name)}: ${cop(t.amount)} (${t.deliveries} domicilio${t.deliveries === 1 ? '' : 's'})`),
    nextFloat > 0 ? `🪙 Queda en caja para el próximo turno: ${cop(nextFloat)}` : null,
    toVault > 0 ? `🏦 A la bóveda: ${cop(toVault)}` : null, note ? `📝 ${esc(note)}` : null, who(user)])
})
const vaultMessage = ({ label, amount, balance, note, site, siteId, user }) => ({
  siteId, path: '/caja?tab=boveda',
  html: lines([`🏦 <b>BÓVEDA · ${esc(label.toUpperCase())}</b>`, SEP, `${amount > 0 ? '⬆️ Entra' : '⬇️ Sale'} ${cop(Math.abs(amount))} · saldo ${cop(balance)}`,
    note ? `📝 ${esc(note)}` : null, site ? `📍 ${esc(site)}` : null, who(user)])
})
const cashRequestMessage = ({ number, status, amount, reason, session, register, site, siteId, user }) => ({
  siteId, path: '/caja?tab=solicitudes',
  html: lines([status === 'pendiente' ? `🙏 <b>SOLICITUD DE RECURSOS · ${esc(number)}</b>` : status === 'aprobada' ? `✅ <b>RECURSOS APROBADOS · ${esc(number)}</b>` : `❌ <b>RECURSOS RECHAZADOS · ${esc(number)}</b>`, SEP,
    `💵 ${cop(amount)} para ${esc(register || 'la caja')}${session ? ` (${esc(session)})` : ''}`, reason ? `📝 ${esc(reason)}` : null, site ? `📍 ${esc(site)}` : null, who(user)])
})
const cashReopenMessage = ({ status, session, register, reason, note, site, siteId, user }) => ({
  siteId, path: '/caja?tab=reaperturas',
  html: lines([status === 'pendiente' ? `🔓 <b>SOLICITUD PARA REABRIR ${esc(session)}</b>` : status === 'aprobada' ? `🔓 <b>TURNO ${esc(session)} REABIERTO</b>` : `❌ <b>NO SE REABRE ${esc(session)}</b>`, SEP,
    `🏧 ${esc(register || 'Caja')}`, reason ? `📝 ${esc(reason)}` : null, note ? `💬 ${esc(note)}` : null, site ? `📍 ${esc(site)}` : null, who(user)])
})
const INCIDENT_EMOJI = { rotura: '🍽️', dano: '🛠️', faltante: '📦', accidente: '🚑', queja: '🗣️', otro: '⚠️' }
const incidentMessage = ({ number, type, typeLabel, title, cost, responsible, site, siteId, user }) => ({
  siteId, path: '/incidentes',
  html: lines([`${INCIDENT_EMOJI[type] || '⚠️'} <b>INCIDENTE · ${esc(number)}</b>`, SEP, `<b>${esc(typeLabel)}</b>: ${esc(title)}`, site ? `📍 ${esc(site)}` : null,
    Number(cost) > 0 ? `💸 Costo: ${cop(cost)}` : null, responsible ? `👤 Responsable: ${esc(responsible)}` : null, who(user)])
})
const callMessage = ({ table, kind, site, siteId, note, items }) => ({
  siteId, path: '/mesas',
  html: lines([kind === 'cuenta' ? `🧾 <b>${esc(table)} PIDE LA CUENTA</b>` : kind === 'pedido' ? `🛎️ <b>${esc(table)} HIZO UN PEDIDO</b>` : `🙋 <b>${esc(table)} LLAMA AL MESERO</b>`,
    ...(items || []).map((i) => `• ${qty(i.quantity)} × ${esc(i.name)}${i.note ? ` (${esc(i.note)})` : ''}`), note ? `📝 ${esc(note)}` : null,
    site ? `📍 ${esc(site)} · ${hour()}` : hour()])
})

// TD-015: el domiciliario recibió el efectivo del cliente; falta cobrarlo en caja.
const cashReceivedMessage = ({ order, amount, courier, site, siteId }) => ({
  siteId, path: `/pedidos/${order.id}`,
  html: lines([`💵 <b>DINERO RECIBIDO · ${esc(order.number)}</b>`, SEP, `🛵 ${esc(fullName(courier))} recibió ${cop(amount)} en efectivo`,
    order.customer_name ? `👤 Cliente: ${esc(order.customer_name)}` : null, order.customer_address ? `🏠 ${esc(order.customer_address)}` : null,
    '🧾 Cóbralo en caja cuando entregue el dinero.', site ? `📍 ${esc(site)} · ${hour()}` : hour()])
})

module.exports = { SECTIONS, cashReceivedMessage, tg, esc, qty, cop, loadSettings, notify, send, lowStockMessage, movementMessage, transferMessage, courtesyMessage, voidMessage, cashOpenMessage, cashCloseMessage, vaultMessage, callMessage, incidentMessage, cashRequestMessage, cashReopenMessage }
