-- =====================================================================
-- TD-024 · Catálogo por sucursal
-- Lo general sigue siendo compartido: un producto, categoría, promoción o descuento sin sucursales
-- elegidas (site_ids vacío) aplica en todas. Cada uno se puede limitar a una o varias sucursales,
-- y cada producto puede tener un precio distinto en una sucursal (product_site_prices).
-- · Producto disponible en una sucursal = el producto y su categoría aplican en ella.
-- · Precio en la sucursal = el de product_site_prices si existe; si no, products.price.
-- · Las promociones de la sucursal se calculan sobre ese precio.
-- =====================================================================
alter table public.product_categories add column if not exists site_ids bigint[] not null default '{}';
alter table public.products add column if not exists site_ids bigint[] not null default '{}';
alter table public.promotions add column if not exists site_ids bigint[] not null default '{}';
alter table public.discounts add column if not exists site_ids bigint[] not null default '{}';

create table if not exists public.product_site_prices (
  product_id bigint not null references public.products(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  org_id bigint not null references public.organizations(id) on delete cascade,
  price numeric(14, 2) not null check (price >= 0),
  updated_at timestamptz not null default now(),
  primary key (product_id, site_id)
);
create index if not exists product_site_prices_site_idx on public.product_site_prices (org_id, site_id);

alter table public.product_site_prices enable row level security;
revoke all on public.product_site_prices from anon, authenticated;
