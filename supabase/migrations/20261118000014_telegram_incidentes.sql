-- =====================================================================
-- TD-005 · Fix: la sección "incidentes" de Telegram no estaba permitida en notification_channels
-- (la restricción venía de TD-002 y no se actualizó al agregar incidentes en TD-003).
-- =====================================================================
alter table public.notification_channels drop constraint if exists notification_channels_section_check;
alter table public.notification_channels add constraint notification_channels_section_check
  check (section in ('inventario', 'pedidos', 'caja', 'mesas', 'incidentes', 'resumen'));
