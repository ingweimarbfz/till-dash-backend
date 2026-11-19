-- =====================================================================
-- TD-029 · Eliminar usuarios
-- Un usuario sin historial se borra de verdad. Uno con historial (pedidos, turnos, pagos, bitácora)
-- se elimina "en blando": queda deleted_at, inactivo y con su usuario e identificación liberados,
-- para que los reportes sigan mostrando su nombre y se pueda volver a crear alguien con esos datos.
-- =====================================================================
alter table public.users add column if not exists deleted_at timestamptz;
