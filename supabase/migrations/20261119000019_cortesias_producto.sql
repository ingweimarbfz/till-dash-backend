-- =====================================================================
-- TD-013 · Productos de cortesía
-- · products.courtesy_allowed: el producto se puede marcar como cortesía al agregarlo al pedido
--   (ej. el agua que se regala con una botella de licor). El mesero lo marca en "Por enviar".
-- · La cortesía no se cobra, pero sí sale del inventario (trigger order_item_stock, sin cambios),
--   y el valor que asume el establecimiento se ve en el turno de caja, el cuadre y los reportes.
-- =====================================================================
alter table public.products add column if not exists courtesy_allowed boolean not null default false;
comment on column public.products.courtesy_allowed is 'Se puede dar como cortesía al agregarlo al pedido (TD-013)';
