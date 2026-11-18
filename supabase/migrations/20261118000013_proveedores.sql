-- =====================================================================
-- TD-005 · Proveedores
-- · suppliers: datos principales del proveedor (identificación, contacto, condiciones de pago y cuenta bancaria).
-- · Se asigna en: productos (proveedor habitual), entradas de inventario (compras), gastos de Finanzas y gastos de caja.
-- =====================================================================

create table if not exists public.suppliers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),       -- nombre comercial
  legal_name text,                                                      -- razón social
  doc_type text not null default 'NIT' check (doc_type in ('NIT', 'CC', 'CE', 'RUT', 'Otro')),
  doc_number text,
  category text not null default 'otro' check (category in ('bebidas', 'alimentos', 'licores', 'insumos', 'aseo', 'servicios', 'mantenimiento', 'tecnologia', 'publicidad', 'otro')),
  contact_name text,
  phone text,
  whatsapp text,
  email text,
  address text,
  city text,
  payment_terms smallint not null default 0 check (payment_terms between 0 and 365), -- días de crédito (0: contado)
  bank_name text,
  bank_account_type text check (bank_account_type in ('ahorros', 'corriente')),
  bank_account text,
  delivery_days smallint[] not null default '{}',                       -- días de visita o entrega (0 domingo … 6 sábado)
  notes text,
  active boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists suppliers_name_key on public.suppliers (org_id, lower(name));
create unique index if not exists suppliers_doc_key on public.suppliers (org_id, doc_number) where doc_number is not null;
create index if not exists suppliers_org_idx on public.suppliers (org_id, active, name);
alter table public.suppliers enable row level security;
revoke all on public.suppliers from anon, authenticated;

-- Proveedor habitual del producto.
alter table public.products add column if not exists supplier_id bigint references public.suppliers(id) on delete set null;
create index if not exists products_supplier_idx on public.products (supplier_id) where supplier_id is not null;

-- Compras: cada entrada de inventario guarda su proveedor y la factura.
alter table public.inventory_movements add column if not exists supplier_id bigint references public.suppliers(id) on delete set null;
alter table public.inventory_movements add column if not exists invoice_ref text;
create index if not exists inventory_movements_supplier_idx on public.inventory_movements (supplier_id, created_at desc) where supplier_id is not null;

-- Gastos pagados a un proveedor (Finanzas y caja). supplier (texto) sigue guardando el nombre.
alter table public.expenses add column if not exists supplier_id bigint references public.suppliers(id) on delete set null;
create index if not exists expenses_supplier_idx on public.expenses (supplier_id, paid_on desc) where supplier_id is not null;
