-- =====================================================================
-- TD-004 · Pedido desde el QR de la mesa
-- · app_settings.qr_ordering: llamar (solo llamar al mesero), confirmar (el cliente arma el pedido y el
--   mesero lo acepta) o directo (el pedido entra a la cuenta y a las comandas sin confirmación).
-- · table_calls admite el tipo 'pedido' con sus productos.
-- =====================================================================
alter table public.app_settings add column if not exists qr_ordering text not null default 'llamar';
alter table public.app_settings drop constraint if exists app_settings_qr_ordering_check;
alter table public.app_settings add constraint app_settings_qr_ordering_check check (qr_ordering in ('llamar', 'confirmar', 'directo'));

alter table public.table_calls drop constraint if exists table_calls_kind_check;
alter table public.table_calls add constraint table_calls_kind_check check (kind in ('mesero', 'cuenta', 'pedido'));
alter table public.table_calls add column if not exists items jsonb;
alter table public.table_calls add column if not exists total numeric(14, 2);
alter table public.table_calls add column if not exists customer_name text;
alter table public.table_calls add column if not exists order_id bigint references public.orders(id) on delete set null;
alter table public.table_calls add column if not exists result text check (result in ('aceptado', 'rechazado', 'directo'));
