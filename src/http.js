// Utilidades HTTP comunes.
class HttpError extends Error {
  constructor (message, status = 400) { super(message); this.status = status }
}

const fail = (res, error, status = 500) => {
  const code = error instanceof HttpError ? error.status : status
  if (code >= 500) console.error(error)
  res.status(code).send({ message: typeof error === 'string' || error instanceof HttpError ? String(error.message ?? error) : 'Error en el servidor' })
}

// Envuelve handlers async para no repetir try/catch.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => fail(res, e))

// '' → null y recorta texto.
const clean = (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v ?? null)

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i
const PHONE_RE = /^[0-9]{7,10}$/
const DOC_RE = /^[0-9A-Za-z-]{5,15}$/
// Nombres y apellidos: letras (con tildes y ñ), espacios, apóstrofo, punto y guion.
const NAME_RE = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ' .-]{2,60}$/

// Imagen en base64 (data URL) con tamaño máximo: fotos de perfil y logos.
const IMG_RE = /^data:image\/(png|jpe?g|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/
const imageError = (v, maxKb = 1500) => {
  if (v === null || v === undefined || v === '') return null
  if (/^https:\/\//.test(v)) return null
  if (!IMG_RE.test(v)) return 'La imagen debe ser PNG, JPG, WEBP o SVG'
  if ((v.length * 3) / 4 / 1024 > maxKb) return `La imagen supera ${maxKb} KB`
  return null
}

module.exports = { HttpError, fail, h, clean, EMAIL_RE, PHONE_RE, DOC_RE, NAME_RE, imageError }

// Fecha de hoy en Colombia (YYYY-MM-DD).
const todayBogota = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date())
module.exports.todayBogota = todayBogota

// Número con validación: devuelve null si viene vacío.
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
module.exports.num = num
