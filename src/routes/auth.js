const express = require('express')
const bcrypt = require('bcryptjs')
const supabase = require('../db')
const tenant = require('../tenant')
const { h, fail, clean, EMAIL_RE, PHONE_RE, imageError } = require('../http')
const { auth, signToken, toUserDTO, profilesOf, ROLE_LABELS, USER_COLUMNS } = require('../auth')
const { audit } = require('../audit')

const router = express.Router()

// Intentos fallidos por usuario: tras 5 en 15 minutos se bloquea el ingreso unos minutos.
const attempts = new Map()
const LOCK_MS = 15 * 60 * 1000
const tooMany = (key) => {
  const a = attempts.get(key)
  return a && a.count >= 5 && Date.now() - a.first < LOCK_MS
}
const registerFail = (key) => {
  const a = attempts.get(key)
  if (!a || Date.now() - a.first > LOCK_MS) attempts.set(key, { count: 1, first: Date.now() })
  else a.count++
}

router.post('/login', h(async (req, res) => {
  const { username, password, profile } = req.body || {}
  const key = String(clean(username) || '').toLowerCase()
  if (!key || !password) return fail(res, 'Usuario y contraseña requeridos', 400)
  if (tooMany(key)) return fail(res, 'Demasiados intentos. Espera unos minutos e intenta de nuevo.', 429)

  const { data: user, error } = await supabase.from('users')
    .select(`${USER_COLUMNS}, password_hash, org:organizations(id, status)`).eq('username', key).maybeSingle()
  if (error) throw error

  const ok = user && (await bcrypt.compare(password, user.password_hash))
  if (!ok) { registerFail(key); return fail(res, 'Usuario o contraseña incorrectos.', 401) }
  if (!user.active) return fail(res, 'Tu usuario está inactivo. Contacta al administrador.', 403)
  if (['suspendida', 'cancelada'].includes(user.org?.status)) return fail(res, 'El servicio de tu establecimiento está suspendido. Contacta a TillDash+.', 403)
  attempts.delete(key)

  // Con varios perfiles, elige con cuál entra. Sin perfil válido, se le pide que elija.
  const profiles = profilesOf(user)
  if (profiles.length > 1 && !profiles.includes(profile)) {
    return res.send({ chooseProfile: true, profiles: profiles.map((r) => ({ role: r, label: ROLE_LABELS[r] })), name: user.name })
  }
  const role = profiles.length > 1 ? profile : user.role

  await tenant.runAsOrg(user.org_id, async () => {
    await supabase.from('users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id)
    req.user = user
    await audit(req, 'login', 'usuario', user.id, role !== user.role ? { perfil: role } : undefined)
  })
  res.send({ token: signToken(user, role), user: toUserDTO({ ...user, primary_role: user.role, role }) })
}))

// Cambiar de perfil sin cerrar sesión.
router.post('/auth/perfil', auth(), h(async (req, res) => {
  const role = req.body?.role
  if (!profilesOf(req.user).includes(role)) return fail(res, 'No tienes ese perfil', 403)
  await audit(req, 'cambio_perfil', 'usuario', req.user.id, { perfil: role })
  res.send({ token: signToken(req.user, role), user: toUserDTO({ ...req.user, role }) })
}))

router.get('/auth/me', auth(), (req, res) => res.send(toUserDTO(req.user)))

// Mi perfil: datos de contacto, foto y contraseña.
router.put('/perfil', auth(), h(async (req, res) => {
  const b = req.body || {}
  const patch = {}
  if ('email' in b) {
    if (clean(b.email) && !EMAIL_RE.test(clean(b.email))) return fail(res, 'Correo no válido', 400)
    patch.email = clean(b.email)
  }
  if ('phone' in b) {
    if (clean(b.phone) && !PHONE_RE.test(clean(b.phone))) return fail(res, 'Teléfono no válido (7 a 10 dígitos)', 400)
    patch.phone = clean(b.phone)
  }
  if ('avatarUrl' in b) {
    const err = imageError(b.avatarUrl, 800)
    if (err) return fail(res, err, 400)
    patch.avatar_url = clean(b.avatarUrl)
  }
  if (b.newPassword) {
    if (String(b.newPassword).length < 8) return fail(res, 'La nueva contraseña debe tener al menos 8 caracteres', 400)
    const { data: cur } = await supabase.from('users').select('password_hash').eq('id', req.user.id).single()
    if (!b.currentPassword || !(await bcrypt.compare(b.currentPassword, cur.password_hash))) return fail(res, 'La contraseña actual no es correcta', 400)
    patch.password_hash = await bcrypt.hash(b.newPassword, 10)
  }
  if ('signatureUrl' in b) {
    const err = imageError(b.signatureUrl, 300)
    if (err) return fail(res, err, 400)
    patch.signature_url = clean(b.signatureUrl)
  }
  if (!Object.keys(patch).length) return res.send(toUserDTO(req.user))
  const { data, error } = await supabase.from('users').update(patch).eq('id', req.user.id).select(USER_COLUMNS).single()
  if (error) throw error
  await audit(req, b.newPassword ? 'cambio_contrasena' : 'editar', 'perfil', req.user.id)
  res.send(toUserDTO(data))
}))

// Firma digital del usuario (imagen dibujada en pantalla). Se usa en cierres de caja, actas y documentos.
router.get('/perfil/firma', auth(), h(async (req, res) => {
  const { data } = await supabase.from('users').select('signature_url').eq('id', req.user.id).single()
  res.send({ signatureUrl: data?.signature_url || null })
}))

module.exports = router
