// =====================================================================
// Plataforma de planes (TD-004, como en QuontUp360)
// · /plataforma/*: panel de TillDash+ para administrar países, planes, precios por país, establecimientos y solicitudes.
//   Entra un usuario con users.platform_admin; su token lleva plt:true y no sirve para la app.
// · /publico/*: precios para los sitios web (sin sesión).
// · /plan/*: "Mi plan" dentro de la app del establecimiento (uso, límites y solicitud de cambio).
// =====================================================================
const express = require('express')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const supabase = require('../db')
const plan = require('../plan')
const { JWT_SECRET } = require('../config')
const { h, fail, clean, EMAIL_RE, PHONE_RE, DOC_RE, HttpError } = require('../http')
const BUSINESS_TYPES = ['restaurante', 'bar', 'market', 'social_bar', 'discoteca', 'cafeteria', 'otro']
const { auth, OWNER, ALL } = require('../auth')
const { currentOrg, runAsOrg } = require('../tenant')
const { audit } = require('../audit')

const router = express.Router()
const PLAN_COLS = 'id, code, name, tagline, max_sites, max_admins, max_employees, max_tables, max_products, support, highlight, badge, bullets, features, annual_discount, trial_days, sort_order, active, created_at, updated_at'
const ORG_COLS = 'id, name, business_type, nit, phone, email, address, city, status, created_at, country_code, plan_id, billing_cycle, start_date, renewal_date, contact_name, extra_features, notes, updated_at'

// ---------- utilidades ----------
const must = ({ data, error }) => { if (error) throw error; return data }
const intOrNull = (v, min, label) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min) throw new HttpError(`${label}: escribe un número entero desde ${min} o déjalo vacío para ilimitado`)
  return n
}
const countryDTO = (c) => ({ code: c.code, name: c.name, currency: c.currency, currencyName: c.currency_name, locale: c.locale, timezone: c.timezone, phonePrefix: c.phone_prefix, active: c.active, sortOrder: c.sort_order })
const featureDTO = (f) => ({ key: f.key, label: f.label, group: f.grp, description: f.description, core: f.core, sortOrder: f.sort_order })
const planDTO = (p, prices = []) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  tagline: p.tagline,
  limits: plan.limitsDTO(p),
  support: p.support,
  highlight: p.highlight,
  badge: p.badge,
  bullets: p.bullets || [],
  features: p.features || [],
  annualDiscount: Number(p.annual_discount),
  trialDays: p.trial_days,
  sortOrder: p.sort_order,
  active: p.active,
  prices: prices.filter((x) => x.plan_id === p.id).map((x) => ({ country: x.country_code, currency: x.currency, month: Number(x.price_month), year: plan.annual(x.price_month, p.annual_discount) }))
})
const orgDTO = (o, plans = [], countries = []) => {
  const p = plans.find((x) => x.id === o.plan_id)
  const c = countries.find((x) => x.code === o.country_code)
  return {
    id: o.id,
    name: o.name,
    businessType: o.business_type,
    nit: o.nit,
    phone: o.phone,
    email: o.email,
    address: o.address,
    city: o.city,
    status: o.status,
    createdAt: o.created_at,
    countryCode: o.country_code,
    country: c ? countryDTO(c) : null,
    planId: o.plan_id,
    planName: p?.name || null,
    billingCycle: o.billing_cycle,
    startDate: o.start_date,
    renewalDate: o.renewal_date,
    contactName: o.contact_name,
    extraFeatures: o.extra_features || [],
    notes: o.notes
  }
}
const catalog = async () => {
  const [countries, features, plans, prices] = await Promise.all([
    supabase.from('countries').select('*').order('sort_order'),
    supabase.from('plan_features').select('*').order('sort_order'),
    supabase.from('plans').select(PLAN_COLS).order('sort_order'),
    supabase.from('plan_prices').select('*')
  ])
  return { countries: must(countries), features: must(features), plans: must(plans), prices: must(prices) }
}
// Precio del plan en un país (o null si no se vende allí).
const priceIn = (prices, planId, country) => prices.find((x) => x.plan_id === planId && x.country_code === country) || null
const monthlyValue = (p, price, cycle) => (cycle === 'anual' ? plan.annual(price.price_month, p.annual_discount) / 12 : Number(price.price_month))

// ---------- sesión de la plataforma ----------
const attempts = new Map()
router.post('/plataforma/login', h(async (req, res) => {
  const { username, password } = req.body || {}
  const key = String(clean(username) || '').toLowerCase()
  if (!key || !password) return fail(res, 'Usuario y contraseña requeridos', 400)
  const a = attempts.get(key)
  if (a && a.count >= 5 && Date.now() - a.first < 15 * 60000) return fail(res, 'Demasiados intentos. Espera unos minutos.', 429)
  const { data: u } = await supabase.from('users').select('id, org_id, name, last_name, username, email, active, platform_admin, password_hash').eq('username', key).maybeSingle()
  const ok = u && u.active && u.platform_admin && (await bcrypt.compare(password, u.password_hash))
  if (!ok) {
    if (!a || Date.now() - a.first > 15 * 60000) attempts.set(key, { count: 1, first: Date.now() }); else a.count++
    return fail(res, 'Usuario o contraseña incorrectos, o sin acceso a la plataforma.', 401)
  }
  attempts.delete(key)
  const token = jwt.sign({ sub: String(u.id), plt: true }, JWT_SECRET, { expiresIn: '12h' })
  res.send({ token, user: { id: u.id, name: `${u.name} ${u.last_name || ''}`.trim(), username: u.username, email: u.email } })
}))

const pauth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return fail(res, 'Inicia sesión en la plataforma', 401)
    let payload
    try { payload = jwt.verify(token, JWT_SECRET) } catch { return fail(res, 'Tu sesión expiró. Inicia sesión de nuevo.', 401) }
    if (!payload.plt) return fail(res, 'Este acceso es solo para la plataforma de TillDash+', 403)
    const { data: u } = await supabase.from('users').select('id, org_id, name, last_name, username, email, active, platform_admin').eq('id', Number(payload.sub)).maybeSingle()
    if (!u || !u.active || !u.platform_admin) return fail(res, 'Sin acceso a la plataforma', 403)
    req.user = u
    next()
  } catch (e) { fail(res, e) }
}
// Auditoría de la plataforma: queda en el establecimiento del usuario de plataforma.
const paudit = (req, action, entity, id, detail) => runAsOrg(req.user.org_id, () => audit(req, action, entity, id, detail))

router.get('/plataforma/me', pauth, (req, res) => res.send({ id: req.user.id, name: `${req.user.name} ${req.user.last_name || ''}`.trim(), username: req.user.username, email: req.user.email }))

// ---------- catálogo: países y funcionalidades ----------
router.get('/plataforma/catalogo', pauth, h(async (req, res) => {
  const c = await catalog()
  res.send({ countries: c.countries.map(countryDTO), features: c.features.map(featureDTO) })
}))

router.put('/plataforma/paises/:code', pauth, h(async (req, res) => {
  const b = req.body || {}
  const patch = {}
  if ('active' in b) patch.active = !!b.active
  if ('currency' in b) {
    if (!/^[A-Z]{3}$/.test(String(b.currency || ''))) return fail(res, 'La moneda es un código ISO de 3 letras (ej. COP, USD)', 400)
    patch.currency = b.currency
  }
  if ('currencyName' in b) patch.currency_name = clean(b.currencyName) || patch.currency || 'Moneda'
  if ('sortOrder' in b) patch.sort_order = Number(b.sortOrder) || 0
  const data = must(await supabase.from('countries').update(patch).eq('code', req.params.code).select('*').maybeSingle())
  if (!data) return fail(res, 'País no encontrado', 404)
  // Si cambia la moneda, los precios de ese país pasan a la nueva moneda (hay que revisarlos).
  if (patch.currency) must(await supabase.from('plan_prices').update({ currency: patch.currency }).eq('country_code', data.code))
  await paudit(req, 'editar', 'pais', data.code, patch)
  await plan.refresh()
  res.send(countryDTO(data))
}))

router.put('/plataforma/funcionalidades/:key', pauth, h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.label)) return fail(res, 'El nombre es requerido', 400)
  const data = must(await supabase.from('plan_features').update({ label: clean(b.label), description: clean(b.description), sort_order: Number(b.sortOrder) || 0 }).eq('key', req.params.key).select('*').maybeSingle())
  if (!data) return fail(res, 'Funcionalidad no encontrada', 404)
  await paudit(req, 'editar', 'funcionalidad', data.key)
  res.send(featureDTO(data))
}))

// ---------- planes con precios por país ----------
router.get('/plataforma/planes', pauth, h(async (req, res) => {
  const c = await catalog()
  const orgs = must(await supabase.from('organizations').select('id, plan_id, status'))
  res.send(c.plans.map((p) => ({ ...planDTO(p, c.prices), organizations: orgs.filter((o) => o.plan_id === p.id && ['activa', 'prueba'].includes(o.status)).length })))
}))

const planRow = (b, features, countries) => {
  const code = String(clean(b.code) || '').toLowerCase()
  if (!/^[a-z0-9_-]{3,30}$/.test(code)) throw new HttpError('El código del plan va en minúsculas, sin espacios (3 a 30 caracteres)')
  if (!clean(b.name)) throw new HttpError('El nombre del plan es requerido')
  const l = b.limits || {}
  const keys = new Set(features.map((f) => f.key))
  const chosen = [...new Set([...(b.features || []).filter((k) => keys.has(k)), ...features.filter((f) => f.core).map((f) => f.key)])]
  const discount = Number(b.annualDiscount ?? 16.7)
  if (!(discount >= 0 && discount <= 90)) throw new HttpError('El descuento anual va de 0 a 90 %')
  const row = {
    code,
    name: clean(b.name),
    tagline: clean(b.tagline),
    max_sites: intOrNull(l.sites, 1, 'Sedes'),
    max_admins: intOrNull(l.admins, 1, 'Administradores'),
    max_employees: intOrNull(l.employees, 0, 'Empleados'),
    max_tables: intOrNull(l.tables, 0, 'Mesas'),
    max_products: intOrNull(l.products, 0, 'Productos'),
    support: clean(b.support),
    highlight: !!b.highlight,
    badge: clean(b.badge),
    bullets: (b.bullets || []).map(clean).filter(Boolean).slice(0, 8),
    features: chosen,
    annual_discount: discount,
    trial_days: intOrNull(b.trialDays, 0, 'Días de prueba') ?? 0,
    sort_order: Number(b.sortOrder) || 0,
    active: b.active !== false,
    updated_at: new Date().toISOString()
  }
  // Precios: un precio mensual por país, en la moneda del país.
  const prices = []
  for (const x of b.prices || []) {
    if (x.month === '' || x.month === null || x.month === undefined) continue
    const c = countries.find((k) => k.code === x.country)
    if (!c) throw new HttpError(`País no válido: ${x.country}`)
    const m = Number(x.month)
    if (!(m >= 0)) throw new HttpError(`Precio no válido para ${c.name}`)
    prices.push({ country_code: c.code, currency: c.currency, price_month: m })
  }
  if (!prices.length) throw new HttpError('Asigna el precio del plan en al menos un país')
  return { row, prices }
}
const savePrices = async (planId, prices) => {
  must(await supabase.from('plan_prices').delete().eq('plan_id', planId))
  must(await supabase.from('plan_prices').insert(prices.map((p) => ({ ...p, plan_id: planId }))))
}
const dupPlan = (e) => (e?.code === '23505' ? 'Ya existe un plan con ese código' : null)

router.post('/plataforma/planes', pauth, h(async (req, res) => {
  const c = await catalog()
  const { row, prices } = planRow(req.body || {}, c.features, c.countries)
  const { data, error } = await supabase.from('plans').insert(row).select(PLAN_COLS).single()
  if (error) return dupPlan(error) ? fail(res, dupPlan(error), 409) : fail(res, error)
  await savePrices(data.id, prices)
  await paudit(req, 'crear', 'plan', data.id, { code: data.code })
  res.status(201).send(planDTO(data, prices.map((p) => ({ ...p, plan_id: data.id }))))
}))

router.put('/plataforma/planes/:id', pauth, h(async (req, res) => {
  const id = Number(req.params.id)
  const c = await catalog()
  const { row, prices } = planRow(req.body || {}, c.features, c.countries)
  const { data, error } = await supabase.from('plans').update(row).eq('id', id).select(PLAN_COLS).maybeSingle()
  if (error) return dupPlan(error) ? fail(res, dupPlan(error), 409) : fail(res, error)
  if (!data) return fail(res, 'Plan no encontrado', 404)
  await savePrices(id, prices)
  await paudit(req, 'editar', 'plan', id, { code: data.code })
  await plan.refresh()
  res.send(planDTO(data, prices.map((p) => ({ ...p, plan_id: id }))))
}))

// Un plan con establecimientos no se borra: se desactiva (deja de ofrecerse).
router.delete('/plataforma/planes/:id', pauth, h(async (req, res) => {
  const id = Number(req.params.id)
  const { count } = await supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('plan_id', id)
  const { count: reqs } = await supabase.from('plan_requests').select('id', { count: 'exact', head: true }).or(`to_plan_id.eq.${id},from_plan_id.eq.${id}`)
  if (count || reqs) {
    must(await supabase.from('plans').update({ active: false }).eq('id', id))
    await paudit(req, 'desactivar', 'plan', id)
    return res.send({ deleted: false, deactivated: true, message: 'El plan tiene establecimientos o solicitudes: quedó inactivo y ya no se ofrece.' })
  }
  must(await supabase.from('plans').delete().eq('id', id))
  await paudit(req, 'eliminar', 'plan', id)
  res.send({ deleted: true })
}))

// ---------- establecimientos (organizaciones) ----------
const usageOf = (orgId) => runAsOrg(orgId, () => plan.usage())

router.get('/plataforma/organizaciones', pauth, h(async (req, res) => {
  const c = await catalog()
  const orgs = must(await supabase.from('organizations').select(ORG_COLS).order('id'))
  const usage = await Promise.all(orgs.map((o) => usageOf(o.id)))
  res.send(orgs.map((o, i) => {
    const p = c.plans.find((x) => x.id === o.plan_id)
    const price = p && priceIn(c.prices, p.id, o.country_code)
    return { ...orgDTO(o, c.plans, c.countries), usage: usage[i], limits: p ? plan.limitsDTO(p) : null, currency: price?.currency || null, monthly: price ? Math.round(monthlyValue(p, price, o.billing_cycle)) : null }
  }))
}))

const orgRow = (b, countries, plans) => {
  if (!clean(b.name)) throw new HttpError('El nombre del establecimiento es requerido')
  if (b.businessType && !BUSINESS_TYPES.includes(b.businessType)) throw new HttpError('Tipo de establecimiento no válido')
  if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) throw new HttpError('Correo no válido')
  const country = countries.find((c) => c.code === b.countryCode)
  if (!country) throw new HttpError('Selecciona el país del establecimiento')
  const p = b.planId ? plans.find((x) => x.id === Number(b.planId)) : null
  if (b.planId && !p) throw new HttpError('Selecciona un plan válido')
  if (!['activa', 'prueba', 'suspendida', 'cancelada'].includes(b.status || 'prueba')) throw new HttpError('Estado no válido')
  return {
    row: {
      name: clean(b.name),
      business_type: b.businessType || 'restaurante',
      nit: clean(b.nit),
      phone: clean(b.phone),
      email: clean(b.email),
      address: clean(b.address),
      city: clean(b.city),
      status: b.status || 'prueba',
      country_code: country.code,
      plan_id: p?.id || null,
      billing_cycle: b.billingCycle === 'anual' ? 'anual' : 'mensual',
      start_date: clean(b.startDate),
      renewal_date: clean(b.renewalDate),
      contact_name: clean(b.contactName),
      extra_features: (b.extraFeatures || []).filter((k) => typeof k === 'string'),
      notes: clean(b.notes),
      updated_at: new Date().toISOString()
    },
    country,
    plan: p
  }
}

// Datos del super administrador (crear o editar). Devuelve la lista de errores.
const adminErrors = (a) => {
  const errs = []
  if (!DOC_RE.test(String(clean(a.identification) || ''))) errs.push('Documento del administrador no válido')
  if (!clean(a.name)) errs.push('Nombre del administrador requerido')
  if (!/^[a-z0-9._-]{3,30}$/.test(String(clean(a.username) || '').toLowerCase())) errs.push('Usuario del administrador: 3 a 30 letras, números, punto o guion')
  if (clean(a.email) && !EMAIL_RE.test(clean(a.email))) errs.push('Correo del administrador no válido')
  if (clean(a.phone) && !PHONE_RE.test(clean(a.phone))) errs.push('Teléfono del administrador no válido (7 a 10 dígitos)')
  if (a.newPassword && String(a.newPassword).length < 6) errs.push('La nueva contraseña debe tener al menos 6 caracteres')
  return errs
}
// Super administrador principal del establecimiento: el primero que se creó.
const mainAdmin = async (orgId) => must(await supabase.from('users').select('id, identification, name, last_name, username, email, phone, active, last_login_at, created_at')
  .eq('org_id', orgId).eq('role', 'superadmin').order('id').limit(1).maybeSingle())
const adminDTO = (u) => (u ? { id: u.id, identification: u.identification, name: u.name, lastName: u.last_name || '', username: u.username, email: u.email || '', phone: u.phone || '', active: u.active, lastLoginAt: u.last_login_at, createdAt: u.created_at } : null)

router.get('/plataforma/organizaciones/:id/admin', pauth, h(async (req, res) => {
  res.send({ admin: adminDTO(await mainAdmin(Number(req.params.id))) })
}))

// Crea el establecimiento (el trigger crea su configuración, sede y bodega principal) y su super administrador (contraseña = documento).
router.post('/plataforma/organizaciones', pauth, h(async (req, res) => {
  const b = req.body || {}
  const c = await catalog()
  const { row, country, plan: p } = orgRow(b, c.countries, c.plans)
  const a = b.admin || {}
  const errs = adminErrors(a)
  if (errs.length) return fail(res, errs.join('. '), 400)
  const username = clean(a.username).toLowerCase()
  const { data: taken } = await supabase.from('users').select('id').eq('username', username).maybeSingle()
  if (taken) return fail(res, 'Ese usuario ya existe en TillDash+; elige otro', 409)
  if (!row.start_date) row.start_date = new Date().toISOString().slice(0, 10)
  if (!row.renewal_date) {
    const d = new Date(`${row.start_date}T12:00:00Z`)
    if (row.status === 'prueba') d.setUTCDate(d.getUTCDate() + (p?.trial_days || 15))
    else if (row.billing_cycle === 'anual') d.setUTCFullYear(d.getUTCFullYear() + 1)
    else d.setUTCMonth(d.getUTCMonth() + 1)
    row.renewal_date = d.toISOString().slice(0, 10)
  }
  const org = must(await supabase.from('organizations').insert(row).select(ORG_COLS).single())
  try {
    must(await supabase.from('app_settings').update({ short_name: org.name.slice(0, 20), currency: country.currency, timezone: country.timezone }).eq('org_id', org.id))
    must(await supabase.from('users').insert({
      org_id: org.id,
      identification: clean(a.identification),
      name: clean(a.name),
      last_name: clean(a.lastName) || '',
      username,
      email: clean(a.email),
      phone: clean(a.phone),
      role: 'superadmin',
      password_hash: await bcrypt.hash(String(clean(a.identification)), 10),
      active: true
    }))
  } catch (e) {
    await supabase.from('organizations').delete().eq('id', org.id)
    throw e
  }
  await paudit(req, 'crear', 'establecimiento', org.id, { name: org.name, country: org.country_code, plan: p?.code })
  res.status(201).send({ ...orgDTO(org, c.plans, c.countries), admin: { username, password: 'Su número de documento' } })
}))

router.put('/plataforma/organizaciones/:id', pauth, h(async (req, res) => {
  const id = Number(req.params.id)
  const c = await catalog()
  const { row, country } = orgRow(req.body || {}, c.countries, c.plans)
  // Super administrador: se validan sus datos antes de tocar el establecimiento.
  const a = req.body?.admin
  let cur = null
  if (a) {
    const errs = adminErrors(a)
    if (errs.length) return fail(res, errs.join('. '), 400)
    cur = await mainAdmin(id)
    const username = clean(a.username).toLowerCase()
    const { data: taken } = await supabase.from('users').select('id').eq('username', username).maybeSingle()
    if (taken && taken.id !== cur?.id) return fail(res, 'Ese usuario ya existe en TillDash+; elige otro', 409)
  }
  const data = must(await supabase.from('organizations').update(row).eq('id', id).select(ORG_COLS).maybeSingle())
  if (!data) return fail(res, 'Negocio no encontrado', 404)
  // La moneda y la zona horaria de la app siguen al país del establecimiento.
  must(await supabase.from('app_settings').update({ currency: country.currency, timezone: country.timezone }).eq('org_id', id))
  let adminInfo = null
  if (a) {
    const fields = { identification: clean(a.identification), name: clean(a.name), last_name: clean(a.lastName) || '', username: clean(a.username).toLowerCase(), email: clean(a.email), phone: clean(a.phone) }
    // Contraseña: una nueva, o volver a dejar el documento.
    const password = a.newPassword ? String(a.newPassword) : a.resetPassword ? String(fields.identification) : null
    if (password) fields.password_hash = await bcrypt.hash(password, 10)
    if (cur) {
      if (a.active !== undefined) fields.active = a.active !== false
      must(await supabase.from('users').update(fields).eq('id', cur.id).eq('org_id', id))
    } else {
      if (!fields.password_hash) fields.password_hash = await bcrypt.hash(String(fields.identification), 10)
      must(await supabase.from('users').insert({ ...fields, org_id: id, role: 'superadmin', active: true }))
    }
    await paudit(req, cur ? 'editar_admin' : 'crear_admin', 'establecimiento', id, { username: fields.username, password: password ? (a.newPassword ? 'nueva' : 'documento') : null })
    adminInfo = { ...adminDTO(await mainAdmin(id)), passwordChanged: Boolean(password) || !cur, password: a.newPassword ? 'La nueva que escribiste' : (a.resetPassword || !cur) ? 'Su número de documento' : null }
  }
  await paudit(req, 'editar', 'establecimiento', id, { status: data.status, plan: data.plan_id, country: data.country_code })
  await plan.refresh(id)
  res.send({ ...orgDTO(data, c.plans, c.countries), admin: adminInfo })
}))

// ---------- resumen ----------
router.get('/plataforma/resumen', pauth, h(async (req, res) => {
  const c = await catalog()
  const orgs = must(await supabase.from('organizations').select(ORG_COLS))
  const { count: pending } = await supabase.from('plan_requests').select('id', { count: 'exact', head: true }).eq('status', 'pendiente')
  const byStatus = {}
  const byCountry = {}
  const byPlan = {}
  const mrr = {}
  for (const o of orgs) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1
    const live = ['activa', 'prueba'].includes(o.status)
    if (!live) continue
    byCountry[o.country_code] = (byCountry[o.country_code] || 0) + 1
    const p = c.plans.find((x) => x.id === o.plan_id)
    const key = p?.name || 'Sin plan'
    byPlan[key] = (byPlan[key] || 0) + 1
    // Ingreso mensual recurrente: solo establecimientos activos (los de prueba aún no pagan).
    const price = p && priceIn(c.prices, p.id, o.country_code)
    if (o.status === 'activa' && price) mrr[price.currency] = (mrr[price.currency] || 0) + monthlyValue(p, price, o.billing_cycle)
  }
  const soon = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10)
  res.send({
    organizations: orgs.length,
    byStatus,
    byCountry: Object.entries(byCountry).map(([code, n]) => ({ ...countryDTO(c.countries.find((x) => x.code === code) || { code, name: code }), organizations: n })).sort((a, b) => b.organizations - a.organizations),
    byPlan: Object.entries(byPlan).map(([name, n]) => ({ name, organizations: n })),
    mrr: Object.entries(mrr).map(([currency, value]) => ({ currency, value: Math.round(value) })),
    pendingRequests: pending || 0,
    renewals: orgs.filter((o) => ['activa', 'prueba'].includes(o.status) && o.renewal_date && o.renewal_date <= soon).map((o) => orgDTO(o, c.plans, c.countries)).sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)),
    plans: c.plans.filter((p) => p.active).length,
    countries: c.countries.filter((x) => x.active).length
  })
}))

// ---------- solicitudes de cambio de plan ----------
const requestDTO = (r, orgs, plans) => ({
  id: r.id,
  orgId: r.org_id,
  orgName: orgs.find((o) => o.id === r.org_id)?.name || `Establecimiento ${r.org_id}`,
  countryCode: orgs.find((o) => o.id === r.org_id)?.country_code || null,
  fromPlan: plans.find((p) => p.id === r.from_plan_id)?.name || null,
  toPlanId: r.to_plan_id,
  toPlan: plans.find((p) => p.id === r.to_plan_id)?.name || null,
  billingCycle: r.billing_cycle,
  message: r.message,
  contactPhone: r.contact_phone,
  status: r.status,
  response: r.response,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

router.get('/plataforma/solicitudes', pauth, h(async (req, res) => {
  let q = supabase.from('plan_requests').select('*').order('created_at', { ascending: false }).limit(300)
  if (req.query.estado) q = q.eq('status', req.query.estado)
  const [rows, orgs, plans] = await Promise.all([q, supabase.from('organizations').select('id, name, country_code'), supabase.from('plans').select('id, name')])
  res.send(must(rows).map((r) => requestDTO(r, must(orgs), must(plans))))
}))

router.put('/plataforma/solicitudes/:id', pauth, h(async (req, res) => {
  const id = Number(req.params.id)
  const b = req.body || {}
  if (!['pendiente', 'contactado', 'aplicada', 'rechazada'].includes(b.status)) return fail(res, 'Estado no válido', 400)
  const r = must(await supabase.from('plan_requests').select('*').eq('id', id).maybeSingle())
  if (!r) return fail(res, 'Solicitud no encontrada', 404)
  // Aplicar: el establecimiento pasa al plan y ciclo pedidos, y queda activo.
  if (b.status === 'aplicada' && r.status !== 'aplicada') {
    must(await supabase.from('organizations').update({ plan_id: r.to_plan_id, billing_cycle: r.billing_cycle, status: 'activa', updated_at: new Date().toISOString() }).eq('id', r.org_id))
    await plan.refresh(r.org_id)
  }
  const data = must(await supabase.from('plan_requests').update({ status: b.status, response: clean(b.response), updated_at: new Date().toISOString() }).eq('id', id).select('*').single())
  await paudit(req, b.status === 'aplicada' ? 'aplicar' : 'editar', 'solicitud_plan', id, { status: b.status })
  const [orgs, plans] = await Promise.all([supabase.from('organizations').select('id, name, country_code'), supabase.from('plans').select('id, name')])
  res.send(requestDTO(data, must(orgs), must(plans)))
}))

// ---------- público: precios para los sitios web ----------
const publicPlans = (c, country) => c.plans.filter((p) => p.active).map((p) => {
  const dto = planDTO(p, c.prices)
  const price = dto.prices.find((x) => x.country === country.code)
  if (!price) return null
  delete dto.prices
  return { ...dto, currency: price.currency, priceMonth: price.month, priceYear: price.year }
}).filter(Boolean)

router.get('/publico/precios', h(async (req, res) => {
  const c = await catalog()
  const active = c.countries.filter((x) => x.active)
  const country = active.find((x) => x.code === String(req.query.pais || '').toUpperCase()) || active.find((x) => x.code === 'CO') || active[0]
  res.set('Cache-Control', 'public, max-age=300')
  res.send({
    country: countryDTO(country),
    countries: active.map(countryDTO),
    features: c.features.map(featureDTO),
    plans: publicPlans(c, country)
  })
}))

// Todo el catálogo de una vez (lo usa el sitio para Google al compilar una página por país).
router.get('/publico/catalogo', h(async (req, res) => {
  const c = await catalog()
  const active = c.countries.filter((x) => x.active)
  res.set('Cache-Control', 'public, max-age=300')
  res.send({ countries: active.map(countryDTO), features: c.features.map(featureDTO), byCountry: Object.fromEntries(active.map((x) => [x.code, publicPlans(c, x)])) })
}))

// ---------- Mi plan (dentro de la app) ----------
// Módulos del establecimiento para mostrar u ocultar el menú (null = todas).
router.get('/plan/modulos', auth(ALL), h(async (req, res) => {
  const st = await plan.ensure(currentOrg())
  res.send({ features: st.features, mode: plan.modeOf(st), plan: st.plan ? { id: st.plan.id, name: st.plan.name, code: st.plan.code } : null, country: st.country, status: st.org?.status || null, renewalDate: st.org?.renewalDate || null })
}))

router.get('/plan/actual', auth(OWNER), h(async (req, res) => {
  const org = currentOrg()
  await plan.refresh(org)
  const st = await plan.ensure(org)
  const c = await catalog()
  const usage = await plan.usage()
  const price = st.plan && priceIn(c.prices, st.plan.id, st.country?.code)
  const { data: last } = await supabase.from('plan_requests').select('*').eq('org_id', org).order('created_at', { ascending: false }).limit(1).maybeSingle()
  res.send({
    org: st.org,
    country: st.country,
    plan: st.plan ? { ...planDTO(st.plan), prices: undefined } : null,
    price: price ? { currency: price.currency, month: Number(price.price_month), year: plan.annual(price.price_month, st.plan.annual_discount) } : null,
    features: c.features.map((f) => ({ ...featureDTO(f), included: plan.has(st, f.key) })),
    limits: st.plan ? plan.limitsDTO(st.plan) : null,
    usage,
    lastRequest: last ? requestDTO(last, [{ id: org, name: st.org?.name }], c.plans) : null
  })
}))

router.get('/plan/opciones', auth(OWNER), h(async (req, res) => {
  const st = await plan.ensure(currentOrg())
  const c = await catalog()
  const country = c.countries.find((x) => x.code === (st.country?.code || 'CO'))
  res.send({ country: countryDTO(country), currentPlanId: st.plan?.id || null, plans: publicPlans(c, country) })
}))

router.post('/plan/solicitud', auth(OWNER), h(async (req, res) => {
  const b = req.body || {}
  const org = currentOrg()
  const st = await plan.ensure(org)
  const { data: target } = await supabase.from('plans').select('id, name, active').eq('id', Number(b.planId)).maybeSingle()
  if (!target || !target.active) return fail(res, 'Selecciona un plan disponible', 400)
  if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) return fail(res, 'Teléfono no válido (7 a 10 dígitos)', 400)
  const { data: open } = await supabase.from('plan_requests').select('id').eq('org_id', org).in('status', ['pendiente', 'contactado']).limit(1).maybeSingle()
  if (open) return fail(res, 'Ya tienes una solicitud en curso. TillDash+ te contactará pronto.', 409)
  const data = must(await supabase.from('plan_requests').insert({
    org_id: org,
    from_plan_id: st.plan?.id || null,
    to_plan_id: target.id,
    billing_cycle: b.billingCycle === 'anual' ? 'anual' : 'mensual',
    message: clean(b.message),
    contact_phone: clean(b.phone) || req.user.phone,
    requested_by: req.user.id
  }).select('*').single())
  await audit(req, 'solicitar', 'plan', data.id, { to: target.name })
  res.status(201).send(requestDTO(data, [{ id: org, name: st.org?.name }], [st.plan, target].filter(Boolean)))
}))

module.exports = router
module.exports.pauth = pauth
module.exports.paudit = paudit
