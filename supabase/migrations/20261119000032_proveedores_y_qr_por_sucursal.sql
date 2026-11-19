-- =====================================================================
-- TD-025 · Proveedores y opciones del QR por sucursal
-- · suppliers.site_ids: vacío = el proveedor sirve a todas las sucursales; con sucursales, solo a ellas.
-- · sites.qr_options: null = la sucursal usa las opciones generales del QR (app_settings.qr_*).
--   Con valor, la sucursal tiene las suyas: { callWaiter, requestBill, billView, orderConfirm,
--   orderDirect, directCategories }.
-- =====================================================================
alter table public.suppliers add column if not exists site_ids bigint[] not null default '{}';
alter table public.sites add column if not exists qr_options jsonb;
