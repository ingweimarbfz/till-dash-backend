-- =====================================================================
-- TD-010 · Plan Distribuidora: negocios que venden y llevan a domicilio sin mesas
-- (distribuidoras de cerveza, licores, bebidas, víveres…).
-- · "mesas" deja de ser del núcleo: un plan puede no incluirla. Sin "mesas" el sistema trabaja sin salón:
--   no hay mesas, zonas, QR de mesa ni pedidos en mesa o barra; se vende a domicilio y para recoger.
-- · Módulos nuevos: "domicilios" (pedidos a domicilio, domiciliarios y sus bases) y "clientes"
--   (directorio de clientes con dirección, zona de reparto, historial y saldo por cobrar).
--   Los planes actuales quedan con domicilios; Profesional y Premium también con clientes.
-- · customers: clientes frecuentes del establecimiento. orders.customer_id liga el pedido a su cliente.
-- · organizations.business_type admite 'distribuidora'.
-- Se puede correr más de una vez.
-- =====================================================================

update public.plan_features set core = false where key = 'mesas';

insert into public.plan_features (key, label, grp, description, core, sort_order) values
  ('domicilios', 'Domicilios y domiciliarios', 'operacion', 'Pedidos a domicilio con forma de pago, domiciliario asignado, ruta, base de cambio y su liquidación.', false, 5),
  ('clientes', 'Clientes y zonas de reparto', 'clientes', 'Directorio de clientes con dirección, zona, historial de compras y saldo por cobrar.', false, 9)
on conflict (key) do nothing;

-- Los planes que ya existen conservan lo que tenían (los domicilios ya estaban en todos).
update public.plans set features = array_append(features, 'domicilios')
  where code in ('esencial', 'profesional', 'premium') and not ('domicilios' = any(features));
update public.plans set features = array_append(features, 'clientes')
  where code in ('profesional', 'premium') and not ('clientes' = any(features));

insert into public.plans (code, name, tagline, max_sites, max_admins, max_employees, max_tables, max_products, support, highlight, badge, bullets, features, sort_order) values
  ('distribuidora', 'Distribuidora', 'Para distribuidoras de cerveza, licores y bebidas que venden y llevan el pedido hasta su cliente.', 3, 3, 25, 0, 1500, 'WhatsApp y llamada', false, 'Sin mesas',
    array['Domicilios con domiciliarios y bases de cambio', 'Clientes con dirección, zona e historial', 'Ventas a crédito y cuentas por cobrar', 'Inventario por bodega, reportes y finanzas'],
    array['caja', 'productos', 'domicilios', 'clientes', 'cuentas_por_cobrar', 'promociones', 'incidentes', 'reportes', 'finanzas', 'bitacora', 'telegram'], 4)
on conflict (code) do nothing;

insert into public.plan_prices (plan_id, country_code, currency, price_month)
select p.id, v.country, v.currency, v.price
from public.plans p
cross join (values
  ('CO', 'COP', 149900), ('PA', 'USD', 39), ('VE', 'USD', 32), ('EC', 'USD', 39), ('PE', 'PEN', 145), ('BO', 'BOB', 269),
  ('BR', 'BRL', 199), ('PY', 'PYG', 289000), ('CL', 'CLP', 36900), ('AR', 'ARS', 41900), ('UY', 'UYU', 1590)
) as v(country, currency, price)
where p.code = 'distribuidora'
on conflict do nothing;

alter table public.organizations drop constraint if exists organizations_business_type_check;
alter table public.organizations add constraint organizations_business_type_check
  check (business_type in ('restaurante', 'bar', 'market', 'social_bar', 'discoteca', 'cafeteria', 'distribuidora', 'otro'));

create table if not exists public.customers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete set null,   -- sucursal que lo atiende (null = todas)
  name text not null,
  kind text not null default 'persona' check (kind in ('persona', 'tienda', 'licorera', 'bar', 'restaurante', 'minimercado', 'empresa', 'otro')),
  doc text,                                -- cédula o NIT
  contact text,                            -- persona de contacto
  phone text,
  phone2 text,
  address text,
  neighborhood text,
  city text,
  zone text,                               -- zona o ruta de reparto
  delivery_fee numeric(14,2) check (delivery_fee is null or delivery_fee >= 0),   -- valor del domicilio para este cliente
  pay_method text check (pay_method in ('efectivo', 'tarjeta', 'transferencia', 'nequi', 'daviplata', 'otro')),
  credit_days int check (credit_days is null or credit_days between 0 and 365), -- plazo de sus cuentas por cobrar
  notes text,
  active boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_org_name_idx on public.customers (org_id, lower(name));
create index if not exists customers_org_phone_idx on public.customers (org_id, phone) where phone is not null;
create index if not exists customers_org_zone_idx on public.customers (org_id, zone) where zone is not null;
alter table public.customers enable row level security;
revoke all on public.customers from anon, authenticated;

alter table public.orders add column if not exists customer_id bigint references public.customers(id) on delete set null;
create index if not exists orders_customer_idx on public.orders (customer_id, opened_at desc) where customer_id is not null;
