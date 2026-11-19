-- TD-014 · Dividir la cuenta al cobrar.
-- El cobro sigue siendo uno solo (charge_order no cambia); solo se guarda cómo se repartió:
-- · orders.split: { mode: 'iguales'|'valor'|'productos', label, total,
--                   persons: [{ name, amount, consumption?, items?: [{ itemId, quantity }] }] }
-- · order_payments.payer: nombre de la persona que hizo ese pago.
alter table public.orders add column if not exists split jsonb;
alter table public.order_payments add column if not exists payer text;
