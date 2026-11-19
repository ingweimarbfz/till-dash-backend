-- TD-015 · El domiciliario avisa que recibió el dinero de un domicilio pagado en efectivo.
-- · orders.cash_received_at / cash_received_amount: cuándo lo marcó y cuánto recibió (el total del pedido).
--   El aviso le sale al personal hasta que el pedido se cobra en caja.
-- · notification_channels: nueva sección de Telegram "domicilios".
alter table public.orders add column if not exists cash_received_at timestamptz;
alter table public.orders add column if not exists cash_received_amount numeric(14,2);

alter table public.notification_channels drop constraint if exists notification_channels_section_check;
alter table public.notification_channels add constraint notification_channels_section_check
  check (section in ('inventario', 'pedidos', 'caja', 'mesas', 'incidentes', 'domicilios', 'resumen'));
