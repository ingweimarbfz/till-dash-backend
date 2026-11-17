// =====================================================================
// Documentos legales y firma digital (como en Integra IPS)
// · El super administrador firma el contrato y el acuerdo de datos con su firma de "Mi perfil" antes de usar el sistema.
// · Cada usuario acepta los términos y condiciones vigentes una vez.
// · La plataforma edita los datos del proveedor y contrafirma como proveedor.
// =====================================================================
const express = require('express')
const supabase = require('../db')
const { h, fail, clean } = require('../http')
const { auth, OWNER, ALL } = require('../auth')
const { currentOrg } = require('../tenant')
const { audit } = require('../audit')
const { pauth, paudit } = require('./platform')
const { BRAND, VERSIONS, CODES, TITLES, EFFECTIVE, RENDER } = require('../legal')

const router = express.Router()
const SIGNABLE = ['contrato', 'datos']
const PROVIDER_FIELDS = ['legal_name', 'nit', 'legal_rep', 'legal_rep_id', 'city', 'address', 'email', 'phone', 'support_hours', 'privacy_email', 'hosting']
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
const uaOf = (req) => String(req.headers['user-agent'] || '').slice(0, 300)
const must = ({ data, error }) => { if (error) throw error; return data }

const loadProvider = async () => must(await supabase.from('provider_info').select('*').eq('id', 1).maybeSingle()) || {}
const loadOrg = async (id) => must(await supabase.from('organizations')
  .select('id, name, nit, city, address, status, country_code, billing_cycle, start_date, renewal_date, extra_features, plan:plans(*), country:countries(*)')
  .eq('id', id).maybeSingle())
const loadFeatures = async () => must(await supabase.from('plan_features').select('key, label, core, sort_order').order('sort_order')) || []
const loadPrice = async (org) => {
  if (!org?.plan || !org.country_code) return null
  const p = must(await supabase.from('plan_prices').select('currency, price_month').eq('plan_id', org.plan.id).eq('country_code', org.country_code).maybeSingle())
  if (!p) return null
  const { annual } = require('../plan')
  return { currency: p.currency, month: Number(p.price_month), year: annual(p.price_month, org.plan.annual_discount) }
}

const render = async (kind, org) => {
  if (!RENDER[kind]) return null
  const [provider, features, price] = await Promise.all([loadProvider(), loadFeatures(), loadPrice(org)])
  const body = RENDER[kind]({ org: org || {}, plan: org?.plan, price, country: org?.country, provider, features: features.filter((f) => !f.core) })
  return {
    kind, code: CODES[kind], version: VERSIONS[kind], title: TITLES[kind], effectiveDate: EFFECTIVE, brand: BRAND,
    organization: org ? { id: org.id, name: org.name, nit: org.nit, city: org.city, planName: org.plan?.name ?? null, billingCycle: org.billing_cycle } : null,
    provider: { legalName: provider.legal_name, nit: provider.nit, legalRep: provider.legal_rep, legalRepId: provider.legal_rep_id, city: provider.city, email: provider.email },
    ...body
  }
}
const sigDTO = (s) => ({ id: s.id, party: s.party, signerName: s.signer_name, signerId: s.signer_id, signerRole: s.signer_role, signatureUrl: s.signature_url, signedAt: s.signed_at, ip: s.ip, version: s.version })
const signaturesOf = async (orgId, kind) => (must(await supabase.from('legal_signatures').select('*').eq('org_id', orgId).eq('kind', kind).eq('version', VERSIONS[kind]).order('signed_at')) || []).map(sigDTO)
const docsOf = (orgId) => Promise.all(SIGNABLE.map(async (k) => ({ kind: k, title: TITLES[k], code: CODES[k], version: VERSIONS[k], signatures: await signaturesOf(orgId, k) })))
const signedByClient = (docs) => docs.every((d) => d.signatures.some((s) => s.party === 'cliente'))

// ---------------------------------------------------------------- Sistema (usuarios del establecimiento)
router.get('/legal/estado', auth(ALL), h(async (req, res) => {
  const orgId = currentOrg()
  const [org, docs, t] = await Promise.all([
    loadOrg(orgId), docsOf(orgId),
    supabase.from('terms_acceptances').select('accepted_at').eq('user_id', req.user.id).eq('version', VERSIONS.terminos).maybeSingle().then(must)
  ])
  res.send({
    activationPending: !signedByClient(docs),
    organization: org ? { name: org.name, planName: org.plan?.name ?? null } : null,
    documents: docs,
    terms: { version: VERSIONS.terminos, acceptedAt: t?.accepted_at ?? null }
  })
}))

router.get('/legal/documento/:kind', auth(ALL), h(async (req, res) => {
  const kind = req.params.kind
  const orgId = currentOrg()
  // Si el establecimiento ya firmó, se muestra el texto exactamente como lo firmó.
  const signed = SIGNABLE.includes(kind)
    ? must(await supabase.from('legal_signatures').select('snapshot').eq('org_id', orgId).eq('kind', kind).eq('party', 'cliente').eq('version', VERSIONS[kind]).maybeSingle())
    : null
  const doc = signed?.snapshot || await render(kind, await loadOrg(orgId))
  if (!doc) return fail(res, 'Documento no encontrado', 404)
  res.send({ ...doc, signatures: SIGNABLE.includes(kind) ? await signaturesOf(orgId, kind) : [] })
}))

// Firma del establecimiento: solo el super administrador (representante legal o su delegado).
router.post('/legal/firmar/:kind', auth(OWNER), h(async (req, res) => {
  const kind = req.params.kind
  if (!SIGNABLE.includes(kind)) return fail(res, 'Documento inválido', 400)
  const orgId = currentOrg()
  const me = must(await supabase.from('users').select('signature_url').eq('id', req.user.id).single())
  if (!me.signature_url) return fail(res, 'Primero crea tu firma digital.', 400)
  const b = req.body || {}
  if (!clean(b.signerName) || !clean(b.signerId) || !clean(b.signerRole)) return fail(res, 'Indica nombre, documento y cargo de quien firma', 400)
  if (b.accept !== true) return fail(res, 'Debes declarar que leíste y aceptas el documento', 400)
  const snapshot = await render(kind, await loadOrg(orgId))
  const { error } = await supabase.from('legal_signatures').insert({
    org_id: orgId, kind, version: VERSIONS[kind], party: 'cliente', user_id: req.user.id,
    signer_name: clean(b.signerName), signer_id: clean(b.signerId), signer_role: clean(b.signerRole),
    signature_url: me.signature_url, snapshot, ip: ipOf(req), user_agent: uaOf(req)
  })
  if (error) { if (error.code === '23505') return fail(res, 'Este documento ya está firmado', 409); throw error }
  await audit(req, 'firmar', 'documento_legal', null, { kind, version: VERSIONS[kind], signer: clean(b.signerName) })
  res.status(201).send({ ok: true, activationPending: !signedByClient(await docsOf(orgId)) })
}))

router.post('/legal/terminos/aceptar', auth(ALL), h(async (req, res) => {
  if (req.body?.accept !== true) return fail(res, 'Debes aceptar los términos y condiciones', 400)
  const { error } = await supabase.from('terms_acceptances').insert({ org_id: currentOrg(), user_id: req.user.id, version: VERSIONS.terminos, ip: ipOf(req), user_agent: uaOf(req) })
  if (error && error.code !== '23505') throw error
  res.send({ ok: true })
}))

// Público: términos y condiciones (sitio web y página de precios).
router.get('/legal/publico/terminos', h(async (req, res) => res.send(await render('terminos', null))))

// ---------------------------------------------------------------- Plataforma (proveedor)
router.get('/plataforma/proveedor', pauth, h(async (req, res) => res.send(await loadProvider())))
router.put('/plataforma/proveedor', pauth, h(async (req, res) => {
  const b = req.body || {}
  if (!clean(b.legal_name)) return fail(res, 'La razón social es requerida', 400)
  const row = Object.fromEntries(PROVIDER_FIELDS.map((k) => [k, clean(b[k]) || null]))
  must(await supabase.from('provider_info').update({ ...row, updated_at: new Date().toISOString() }).eq('id', 1))
  await paudit(req, 'actualizar', 'proveedor', 1, { legal_name: row.legal_name })
  res.send(await loadProvider())
}))
router.get('/plataforma/organizaciones/:id/legal', pauth, h(async (req, res) => {
  const org = await loadOrg(Number(req.params.id))
  if (!org) return fail(res, 'Establecimiento no encontrado', 404)
  res.send(await docsOf(org.id))
}))
router.get('/plataforma/organizaciones/:id/legal/:kind', pauth, h(async (req, res) => {
  const kind = req.params.kind
  const org = await loadOrg(Number(req.params.id))
  if (!org) return fail(res, 'Establecimiento no encontrado', 404)
  const signed = SIGNABLE.includes(kind)
    ? must(await supabase.from('legal_signatures').select('snapshot').eq('org_id', org.id).eq('kind', kind).eq('party', 'cliente').eq('version', VERSIONS[kind]).maybeSingle())
    : null
  const doc = signed?.snapshot || await render(kind, org)
  if (!doc) return fail(res, 'Documento no encontrado', 404)
  res.send({ ...doc, signatures: SIGNABLE.includes(kind) ? await signaturesOf(org.id, kind) : [] })
}))
router.post('/plataforma/organizaciones/:id/legal/:kind/firmar', pauth, h(async (req, res) => {
  const kind = req.params.kind
  if (!SIGNABLE.includes(kind)) return fail(res, 'Documento inválido', 400)
  const org = await loadOrg(Number(req.params.id))
  if (!org) return fail(res, 'Establecimiento no encontrado', 404)
  const u = must(await supabase.from('users').select('id, name, last_name, identification, signature_url').eq('id', req.user.id).single())
  if (!u.signature_url) return fail(res, 'Tu usuario no tiene firma digital. Créala en TillDash+ (Mi perfil → Firma digital).', 400)
  const provider = await loadProvider()
  const { error } = await supabase.from('legal_signatures').insert({
    org_id: org.id, kind, version: VERSIONS[kind], party: 'proveedor', user_id: u.id,
    signer_name: provider.legal_rep || `${u.name} ${u.last_name || ''}`.trim(),
    signer_id: provider.legal_rep_id || u.identification,
    signer_role: `Representante legal · ${provider.legal_name || BRAND}`,
    signature_url: u.signature_url, snapshot: await render(kind, org), ip: ipOf(req), user_agent: uaOf(req)
  })
  if (error) { if (error.code === '23505') return fail(res, 'Ya está firmado por el proveedor', 409); throw error }
  await paudit(req, 'contrafirmar', 'documento_legal', org.id, { kind, org: org.name })
  res.status(201).send({ ok: true })
}))

module.exports = router
