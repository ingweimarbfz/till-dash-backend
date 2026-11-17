// =====================================================================
// Configuración del establecimiento
// · GET /configuracion/publica?org=<id>: nombre, logo y colores sin sesión (login, carta por QR).
// · GET /configuracion: todo, para cualquier usuario con sesión.
// · PUT /configuracion: datos del establecimiento y operación (superadmin y admin).
// · PUT /configuracion/apariencia: colores, logo, fuente y modo (solo superadmin).
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { currentOrg, runAsOrg } = require('../tenant')
const { h, fail, clean, imageError, EMAIL_RE, PHONE_RE } = require('../http')
const { auth, ADMIN, OWNER } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/
// Fuentes de Google Fonts que el frontend sabe cargar.
const FONTS = ['Outfit', 'Plus Jakarta Sans', 'Manrope', 'Poppins', 'Inter', 'Montserrat', 'Nunito', 'DM Sans', 'Raleway', 'Lora']
const BUSINESS_TYPES = ['restaurante', 'bar', 'market', 'social_bar', 'discoteca', 'cafeteria', 'otro']

const brandDTO = (s, o) => ({
  businessName: s?.business_name || o?.name || 'TillDash+',
  shortName: s?.short_name || null,
  slogan: s?.slogan || null,
  logoUrl: s?.logo_url || null,
  faviconUrl: s?.favicon_url || null,
  colors: { primary: s?.color_primary || '#E4572E', secondary: s?.color_secondary || '#1F2933', accent: s?.color_accent || '#F2A541' },
  fontFamily: s?.font_family || 'Outfit',
  themeMode: s?.theme_mode || 'claro'
})

const toDTO = (s, o) => ({
  ...brandDTO(s, o),
  businessType: o?.business_type || 'restaurante',
  currency: s?.currency || 'COP',
  timezone: s?.timezone || 'America/Bogota',
  tipPercent: Number(s?.tip_percent ?? 10),
  tipSuggested: s?.tip_suggested ?? true,
  receiptFooter: s?.receipt_footer || null,
  social: s?.social || {},
  nit: o?.nit || null,
  phone: o?.phone || null,
  email: o?.email || null,
  address: o?.address || null,
  city: o?.city || null,
  fonts: FONTS
})

const read = async (orgId) => {
  const [{ data: s }, { data: o }] = await Promise.all([
    supabase.from('app_settings').select('*').eq('org_id', orgId).maybeSingle(),
    supabase.from('organizations').select('*').eq('id', orgId).maybeSingle()
  ])
  return { s, o }
}

router.get('/configuracion/publica', h(async (req, res) => {
  const org = Number(req.query.org)
  if (!org) return res.send(brandDTO(null, null))
  const { s, o } = await runAsOrg(org, () => read(org))
  if (!o) return fail(res, 'Establecimiento no encontrado', 404)
  res.send(brandDTO(s, o))
}))

router.get('/configuracion', auth(), h(async (req, res) => {
  const { s, o } = await read(currentOrg())
  res.send(toDTO(s, o))
}))

router.put('/configuracion', auth(ADMIN), h(async (req, res) => {
  const b = req.body || {}
  const errors = []
  if (!clean(b.businessName)) errors.push('El nombre del establecimiento es requerido')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) errors.push('Correo no válido')
  if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) errors.push('Teléfono no válido (7 a 10 dígitos)')
  if (b.businessType && !BUSINESS_TYPES.includes(b.businessType)) errors.push('Tipo de establecimiento no válido')
  const tip = b.tipPercent === undefined ? 10 : Number(b.tipPercent)
  if (!Number.isFinite(tip) || tip < 0 || tip > 100) errors.push('La propina debe estar entre 0 % y 100 %')
  if (errors.length) return fail(res, errors.join('. '), 400)

  const { error } = await supabase.from('app_settings').update({
    business_name: clean(b.businessName),
    short_name: clean(b.shortName),
    slogan: clean(b.slogan),
    tip_percent: tip,
    tip_suggested: b.tipSuggested !== false,
    receipt_footer: clean(b.receiptFooter),
    social: typeof b.social === 'object' && b.social ? b.social : {}
  }).eq('org_id', currentOrg())
  if (error) throw error
  const { error: e2 } = await supabase.from('organizations').update({
    name: clean(b.businessName), business_type: b.businessType || 'restaurante',
    nit: clean(b.nit), phone: clean(b.phone), email: clean(b.email), address: clean(b.address), city: clean(b.city)
  }).eq('id', currentOrg())
  if (e2) throw e2
  await audit(req, 'editar', 'configuracion', currentOrg())
  const { s, o } = await read(currentOrg())
  res.send(toDTO(s, o))
}))

router.put('/configuracion/apariencia', auth(OWNER), h(async (req, res) => {
  const b = req.body || {}
  const c = b.colors || {}
  const errors = []
  for (const k of ['primary', 'secondary', 'accent']) if (!COLOR_RE.test(c[k] || '')) errors.push(`El color ${k} debe tener el formato #RRGGBB`)
  if (!FONTS.includes(b.fontFamily)) errors.push('Fuente no disponible')
  if (!['claro', 'oscuro', 'sistema'].includes(b.themeMode)) errors.push('Modo de tema no válido')
  for (const [k, kb] of [['logoUrl', 600], ['faviconUrl', 150]]) { const e = imageError(b[k], kb); if (e) errors.push(e) }
  if (errors.length) return fail(res, errors.join('. '), 400)
  const { error } = await supabase.from('app_settings').update({
    color_primary: c.primary.toUpperCase(), color_secondary: c.secondary.toUpperCase(), color_accent: c.accent.toUpperCase(),
    font_family: b.fontFamily, theme_mode: b.themeMode, logo_url: clean(b.logoUrl), favicon_url: clean(b.faviconUrl)
  }).eq('org_id', currentOrg())
  if (error) throw error
  await audit(req, 'editar', 'apariencia', currentOrg(), { colors: c, font: b.fontFamily, mode: b.themeMode })
  const { s, o } = await read(currentOrg())
  res.send(toDTO(s, o))
}))

module.exports = router
module.exports.FONTS = FONTS
module.exports.COLOR_RE = COLOR_RE
