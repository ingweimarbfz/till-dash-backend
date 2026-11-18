// Proveedores: catálogo y resolución del proveedor que llega en un formulario.
const supabase = require('./db')
const { clean } = require('./http')

const SUPPLIER_CATEGORIES = {
  bebidas: 'Bebidas', alimentos: 'Alimentos', licores: 'Licores', insumos: 'Insumos y desechables', aseo: 'Aseo y limpieza',
  servicios: 'Servicios públicos', mantenimiento: 'Mantenimiento', tecnologia: 'Tecnología', publicidad: 'Publicidad', otro: 'Otro'
}

// Desde un formulario llega supplierId (proveedor registrado) o supplier (texto libre, ej. "tienda de la esquina").
// Devuelve { id, name } o { error }.
const resolveSupplier = async (b) => {
  const id = Number(b?.supplierId)
  if (id) {
    const { data } = await supabase.from('suppliers').select('id, name, active').eq('id', id).maybeSingle()
    if (!data) return { error: 'El proveedor no existe' }
    if (!data.active) return { error: `El proveedor ${data.name} está inactivo` }
    return { id: data.id, name: data.name }
  }
  return { id: null, name: clean(b?.supplier)?.slice(0, 120) ?? null }
}

module.exports = { SUPPLIER_CATEGORIES, resolveSupplier }
