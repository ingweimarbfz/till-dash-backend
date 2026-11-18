// =====================================================================
// Configuración de las notificaciones por Telegram (TD-002, modelo de QuontUp360)
// · El administrador conecta el bot del establecimiento (token de @BotFather).
// · Agrega el bot a sus grupos de Telegram y elige qué sección recibe cada grupo, para una sucursal o todas.
// · Puede enviar un mensaje de prueba y ver el historial de envíos.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, ADMIN } = require('../auth')
const { audit } = require('../audit')
const { SECTIONS, tg, esc, loadSettings } = require('../notify')

const router = express.Router()
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/
const mask = (t) => (t ? `${t.split(':')[0]}:••••••${t.slice(-4)}` : null)

const channelDTO = (c, sites) => ({
  id: c.id, section: c.section, sectionLabel: SECTIONS[c.section]?.label, siteId: c.site_id,
  siteName: c.site_id ? sites.find((s) => s.id === c.site_id)?.name || 'Sucursal' : 'Todas las sucursales',
  chatId: c.chat_id, title: c.title, enabled: c.enabled, createdAt: c.created_at
})
const settingsDTO = (st) => ({
  configured: Boolean(st?.bot_token), enabled: Boolean(st?.enabled), token: mask(st?.bot_token),
  username: st?.bot_username || null, name: st?.bot_name || null
})
const needBot = async () => {
  const st = await loadSettings()
  if (!st?.bot_token) throw Object.assign(new Error('Primero conecta el bot de Telegram'), { status: 400 })
  return st
}
const sitesList = async () => (await supabase.from('sites').select('id, name, city').eq('active', true).order('is_main', { ascending: false }).order('name')).data || []

router.get('/notificaciones', auth(ADMIN), h(async (req, res) => {
  const [st, sites, { data: chans }, { data: log }] = await Promise.all([
    loadSettings(), sitesList(),
    supabase.from('notification_channels').select('*').order('section').order('id'),
    supabase.from('notification_log').select('*').order('id', { ascending: false }).limit(40)
  ])
  res.send({
    bot: settingsDTO(st), sites,
    sections: Object.entries(SECTIONS).map(([key, s]) => ({ key, ...s })),
    channels: (chans || []).map((c) => channelDTO(c, sites)),
    log: (log || []).map((l) => ({
      id: l.id, section: l.section, sectionLabel: SECTIONS[l.section]?.label || l.section, status: l.status, detail: l.detail, createdAt: l.created_at,
      siteName: l.site_id ? sites.find((s) => s.id === l.site_id)?.name : null,
      chatTitle: (chans || []).find((c) => c.chat_id === l.chat_id)?.title || l.chat_id
    }))
  })
}))

// Conecta el bot (valida el token con getMe) o lo activa y desactiva.
router.put('/notificaciones/bot', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const st = await loadSettings()
  const row = {}
  if (b.token !== undefined && b.token !== '') {
    const token = String(b.token).trim()
    if (!TOKEN_RE.test(token)) return fail(res, 'El token no tiene el formato de @BotFather (número:clave)', 400)
    let me
    try { me = await tg(token, 'getMe') } catch (e) { return fail(res, 'Telegram no reconoce ese token. Cópialo de nuevo desde @BotFather', 400) }
    Object.assign(row, { bot_token: token, bot_username: me.username, bot_name: me.first_name, enabled: b.enabled ?? true })
  } else if (!st?.bot_token) return fail(res, 'Pega el token del bot que te dio @BotFather', 400)
  if (typeof b.enabled === 'boolean') row.enabled = b.enabled
  row.updated_at = new Date().toISOString()
  const { error } = st ? await supabase.from('notification_settings').update(row).not('org_id', 'is', null) : await supabase.from('notification_settings').insert(row)
  if (error) throw error
  await audit(req, row.bot_token ? 'conectar' : 'editar', 'telegram', null, { enabled: row.enabled ?? st?.enabled, bot: row.bot_username || st?.bot_username })
  res.send(settingsDTO(await loadSettings()))
}))

router.delete('/notificaciones/bot', auth(ADMIN), h(async (req, res) => {
  await supabase.from('notification_settings').update({ bot_token: null, bot_username: null, bot_name: null, enabled: false, updated_at: new Date().toISOString() }).not('org_id', 'is', null)
  await audit(req, 'desconectar', 'telegram')
  res.send(settingsDTO(await loadSettings()))
}))

// Grupos donde está el bot: lee los mensajes recientes (hay que escribir algo en el grupo después de agregarlo).
router.post('/notificaciones/buscar-grupos', auth(ADMIN), h(async (req, res) => {
  const st = await needBot()
  const updates = await tg(st.bot_token, 'getUpdates', { limit: 100, allowed_updates: ['message', 'my_chat_member', 'channel_post'] })
  const found = new Map()
  // Cuando Telegram convierte un grupo en supergrupo, el grupo cambia de id y el viejo sigue en el historial:
  // por eso aparecía dos veces. Se descarta el id viejo y se actualizan los grupos ya conectados.
  const migrated = new Map()
  for (const u of updates || []) {
    const m = u.message
    if (m?.migrate_to_chat_id) migrated.set(String(m.chat.id), String(m.migrate_to_chat_id))
    if (m?.migrate_from_chat_id) migrated.set(String(m.migrate_from_chat_id), String(m.chat.id))
  }
  for (const u of updates || []) {
    const chat = u.message?.chat || u.my_chat_member?.chat || u.channel_post?.chat
    if (!chat || chat.type === 'private') continue
    const id = String(chat.id)
    if (migrated.has(id)) continue
    if (u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status)) { found.delete(id); continue }
    found.set(id, { chatId: id, title: chat.title || 'Grupo', type: chat.type })
  }
  for (const [from, to] of migrated) await supabase.from('notification_channels').update({ chat_id: to }).eq('chat_id', from)
  // Qué secciones recibe ya cada grupo, para no confundirlos.
  const { data: chans } = await supabase.from('notification_channels').select('chat_id, section')
  const rows = [...found.values()].map((g) => ({ ...g, sections: (chans || []).filter((c) => c.chat_id === g.chatId).map((c) => SECTIONS[c.section]?.label || c.section) }))
  // Si dos grupos distintos se llaman igual, se distinguen por el final de su id.
  const names = rows.reduce((m, g) => { m[g.title] = (m[g.title] || 0) + 1; return m }, {})
  res.send(rows.map((g) => ({ ...g, sameName: names[g.title] > 1 })))
}))

router.post('/notificaciones/canales', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  if (!SECTIONS[b.section]) return fail(res, 'Elige la sección', 400)
  const chatId = clean(String(b.chatId ?? ''))
  if (!chatId || !/^-?\d{5,20}$/.test(chatId)) return fail(res, 'Elige el grupo de Telegram', 400)
  const siteId = Number(b.siteId) || null
  if (siteId && !(await supabase.from('sites').select('id').eq('id', siteId).maybeSingle()).data) return fail(res, 'Sucursal no encontrada', 404)
  const { data: dup } = await supabase.from('notification_channels').select('site_id').eq('section', b.section).eq('chat_id', chatId)
  if ((dup || []).some((d) => (d.site_id ?? null) === siteId)) return fail(res, 'Ese grupo ya recibe esa sección para esa sucursal', 400)
  const { data, error } = await supabase.from('notification_channels').insert({ section: b.section, chat_id: chatId, site_id: siteId, title: clean(b.title) || 'Grupo', enabled: true }).select('*').single()
  if (error) {
    if (error.code === '23514') return fail(res, 'Esa sección todavía no está habilitada en la base de datos. Ejecuta la migración td005-telegram-incidentes.sql.', 400)
    if (error.code === '23505') return fail(res, 'Ese grupo ya recibe esa sección para esa sucursal', 400)
    throw error
  }
  await audit(req, 'crear', 'grupo_telegram', data.id, { section: data.section, title: data.title, site: siteId })
  res.status(201).send(channelDTO(data, await sitesList()))
}))

router.put('/notificaciones/canales/:id', auth(ADMIN), h(async (req, res) => {
  const { data, error } = await supabase.from('notification_channels').update({ enabled: Boolean(req.body?.enabled) }).eq('id', Number(req.params.id)).select('*').maybeSingle()
  if (error) throw error
  if (!data) return fail(res, 'Grupo no encontrado', 404)
  res.send(channelDTO(data, await sitesList()))
}))

router.delete('/notificaciones/canales/:id', auth(ADMIN), h(async (req, res) => {
  const { data } = await supabase.from('notification_channels').delete().eq('id', Number(req.params.id)).select('id, title, section').maybeSingle()
  if (data) await audit(req, 'eliminar', 'grupo_telegram', data.id, { section: data.section, title: data.title })
  res.status(204).end()
}))

router.post('/notificaciones/canales/:id/prueba', auth(ADMIN), h(async (req, res) => {
  const st = await needBot()
  const { data: c } = await supabase.from('notification_channels').select('*').eq('id', Number(req.params.id)).maybeSingle()
  if (!c) return fail(res, 'Grupo no encontrado', 404)
  const site = c.site_id ? (await supabase.from('sites').select('name').eq('id', c.site_id).maybeSingle()).data?.name : null
  const html = `✅ <b>TillDash+ conectado</b>\n━━━━━━━━━━━━━━━\nEste grupo recibirá: <b>${esc(SECTIONS[c.section].label)}</b>\n📍 ${esc(site || 'Todas las sucursales')}\nℹ️ ${esc(SECTIONS[c.section].hint)}`
  let status = 'enviado'; let detail = null
  try { await tg(st.bot_token, 'sendMessage', { chat_id: c.chat_id, text: html, parse_mode: 'HTML' }) } catch (e) { status = 'error'; detail = e.message }
  await supabase.from('notification_log').insert({ section: c.section, chat_id: c.chat_id, site_id: c.site_id, status, detail })
  if (status === 'error') return fail(res, detail, 400)
  res.send({ ok: true })
}))

module.exports = router
