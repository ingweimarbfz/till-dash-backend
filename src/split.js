// =====================================================================
// Cuenta dividida (TD-014): al cobrar, la cuenta se reparte entre varias personas y cada una paga lo suyo
// con sus propias formas de pago. Tres modos:
// · iguales: el total en partes iguales.
// · valor: el cajero escribe cuánto paga cada persona.
// · productos: cada producto (o unidad) se asigna a una persona o se comparte; descuento, propina y domicilio
//   se reparten en proporción a lo que consumió cada una.
// El cobro sigue siendo uno solo (charge_order): los pagos llevan el índice de la persona y el reparto queda
// guardado en orders.split; cada pago guarda su pagador en order_payments.payer.
// =====================================================================
const { clean } = require('./http')

const MODES = { iguales: 'Partes iguales', valor: 'Por valor', productos: 'Por productos' }
const MAX_PERSONS = 20

const round = (v) => Math.round(Number(v) || 0)

// Reparte un total entero según pesos, sin perder pesos por redondeo (método del mayor residuo).
const apportion = (total, weights) => {
  const t = round(total)
  const w = weights.map((x) => Math.max(0, Number(x) || 0))
  const sum = w.reduce((a, x) => a + x, 0)
  if (!w.length) return []
  const base = sum > 0 ? w : w.map(() => 1)
  const bsum = sum > 0 ? sum : w.length
  const raw = base.map((x) => (t * x) / bsum)
  const out = raw.map(Math.floor)
  let rest = t - out.reduce((a, x) => a + x, 0)
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k][1]] += 1
  return out
}

// Consumo de cada persona según los productos asignados: [{ itemId, quantity }] por persona.
// items: productos vivos del pedido (unit_price, quantity, courtesy). Devuelve { error } o { consumption: [...] }.
const consumptionByItems = (persons, items) => {
  const live = new Map(items.filter((i) => i.status !== 'anulado').map((i) => [Number(i.id), i]))
  const assigned = new Map()
  const consumption = persons.map(() => 0)
  for (let n = 0; n < persons.length; n++) {
    for (const a of Array.isArray(persons[n].items) ? persons[n].items : []) {
      const it = live.get(Number(a.itemId))
      const q = Number(a.quantity)
      if (!it) return { error: 'Uno de los productos repartidos no está en el pedido' }
      if (!(q > 0)) return { error: `La cantidad de ${it.name} asignada a ${persons[n].name} no es válida` }
      assigned.set(it.id, (assigned.get(it.id) || 0) + q)
      if (!it.courtesy) consumption[n] += q * Number(it.unit_price)
    }
  }
  for (const it of live.values()) {
    const got = assigned.get(Number(it.id)) || 0
    if (Math.abs(got - Number(it.quantity)) > 0.01) {
      return { error: got > Number(it.quantity) ? `Se repartió más ${it.name} del que hay en el pedido` : `Falta asignar ${it.name} a alguna persona` }
    }
  }
  return { consumption }
}

// Valida el reparto contra los pagos y el pedido. total: el total del cobro (consumo − descuento + propina + domicilio)
// calculado por el cajero; la base de datos vuelve a comprobar que los pagos lo sumen.
// Devuelve { error } o { split, payers } listo para guardar.
const validateSplit = (split, payments, order) => {
  if (!split || typeof split !== 'object') return { error: 'El reparto de la cuenta no es válido' }
  if (!MODES[split.mode]) return { error: 'Elige cómo dividir la cuenta' }
  const list = Array.isArray(split.persons) ? split.persons : []
  if (list.length < 2) return { error: 'Para dividir la cuenta se necesitan al menos 2 personas' }
  if (list.length > MAX_PERSONS) return { error: `Máximo ${MAX_PERSONS} personas por cuenta` }
  const persons = list.map((p, n) => ({ name: (clean(p?.name) || `Persona ${n + 1}`).slice(0, 40), amount: round(p?.amount), items: p?.items }))
  const names = new Set()
  for (const p of persons) {
    if (names.has(p.name.toLowerCase())) return { error: `Hay dos personas con el nombre "${p.name}"` }
    names.add(p.name.toLowerCase())
    if (!(p.amount > 0)) return { error: `${p.name} no tiene nada que pagar: quítala del reparto` }
  }
  const paid = persons.map(() => 0)
  for (const pay of payments) {
    const n = Number(pay.person)
    if (!Number.isInteger(n) || n < 0 || n >= persons.length) return { error: 'Cada pago debe indicar qué persona lo hace' }
    paid[n] += round(pay.amount)
  }
  for (let n = 0; n < persons.length; n++) {
    if (paid[n] !== persons[n].amount) {
      const d = persons[n].amount - paid[n]
      return { error: `Los pagos de ${persons[n].name} no suman su parte: ${d > 0 ? 'faltan' : 'sobran'} $${Math.abs(d).toLocaleString('es-CO')}` }
    }
  }
  const total = persons.reduce((a, p) => a + p.amount, 0)
  let detail = null
  if (split.mode === 'productos') {
    const r = consumptionByItems(persons, order.items || [])
    if (r.error) return { error: r.error }
    // Cada persona paga su consumo más su parte proporcional de descuento, propina y domicilio.
    const expected = apportion(total, r.consumption)
    const off = persons.findIndex((p, n) => Math.abs(p.amount - expected[n]) > 1)
    if (off >= 0) return { error: `La parte de ${persons[off].name} no corresponde a sus productos (${'$' + expected[off].toLocaleString('es-CO')})` }
    detail = persons.map((p, n) => ({ consumption: round(r.consumption[n]), items: p.items.map((a) => ({ itemId: Number(a.itemId), quantity: Number(a.quantity) })) }))
  }
  if (split.mode === 'iguales') {
    const expected = apportion(total, persons.map(() => 1))
    if (persons.some((p, n) => Math.abs(p.amount - expected[n]) > 1)) return { error: 'Las partes iguales no coinciden con el total' }
  }
  return {
    split: { mode: split.mode, label: MODES[split.mode], total, persons: persons.map((p, n) => ({ name: p.name, amount: p.amount, ...(detail ? detail[n] : {}) })) },
    payers: payments.map((pay) => persons[Number(pay.person)].name)
  }
}

module.exports = { validateSplit, apportion, consumptionByItems, MODES }
