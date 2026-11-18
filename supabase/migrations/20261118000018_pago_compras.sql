-- =====================================================================
-- TD-010 · Toda entrada de inventario dice de dónde se pagó.
-- · Con Finanzas: caja del turno, una cuenta o subcuenta, a crédito con el proveedor (cuenta por pagar)
--   o inventario inicial (mercancía que ya existía, solo el super administrador). Sin Finanzas: caja o pagado por fuera.
-- · payables: cuentas por pagar a proveedores que nacen de una compra a crédito. Se abonan con gastos de
--   Finanzas (categoría compras) que llevan expenses.payable_id; lo pagado es la suma de esos gastos activos.
-- Se puede correr más de una vez.
-- =====================================================================

create table if not exists public.payables (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete set null,      -- sucursal de la bodega que recibió (null = general)
  supplier_id bigint references public.suppliers(id) on delete set null,
  supplier text,                                                       -- nombre del proveedor (también si es texto libre)
  ref text not null,                                                   -- entrada de inventario EN-…
  invoice_ref text,
  description text,
  amount numeric(14,2) not null check (amount > 0),
  due_date date,
  status text not null default 'activa' check (status in ('activa', 'anulada')),
  void_reason text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists payables_ref_key on public.payables (org_id, ref);
create index if not exists payables_org_due_idx on public.payables (org_id, status, due_date);
create index if not exists payables_supplier_idx on public.payables (supplier_id) where supplier_id is not null;
alter table public.payables enable row level security;
revoke all on public.payables from anon, authenticated;

alter table public.expenses add column if not exists payable_id bigint references public.payables(id) on delete set null;
create index if not exists expenses_payable_idx on public.expenses (payable_id) where payable_id is not null;

-- Cómo se pagó cada entrada: caja | cuenta | credito | inicial | externo (null en las anteriores a este cambio).
alter table public.inventory_movements add column if not exists pay_source text
  check (pay_source is null or pay_source in ('caja', 'cuenta', 'credito', 'inicial', 'externo'));
alter table public.inventory_movements add column if not exists expense_id bigint references public.expenses(id) on delete set null;
