-- =====================================================================
-- TD-004 · Planes, países y monedas (como en QuontUp360)
-- · countries: países donde se ofrece TillDash+ (Panamá y Suramérica).
-- · plan_features: módulos que un plan puede incluir (cada uno habilita rutas y menús del sistema).
-- · plans: límites de sucursales, administradores, empleados, mesas y productos, y los módulos incluidos.
-- · plan_prices: precio mensual de cada plan en cada país, en la moneda de ese país.
-- · organizations: país, plan, ciclo de pago y fechas del servicio de cada establecimiento.
-- · plan_requests: solicitudes de cambio de plan que hace el administrador desde "Mi plan".
-- · users.platform_admin: quién entra a la plataforma de planes (/plataforma).
-- =====================================================================

create table if not exists public.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  currency_name text not null,
  locale text not null,
  timezone text not null,
  phone_prefix text not null,
  active boolean not null default true,
  sort_order int not null default 0
);

insert into public.countries (code, name, currency, currency_name, locale, timezone, phone_prefix, sort_order) values
  ('CO', 'Colombia', 'COP', 'Peso colombiano', 'es-CO', 'America/Bogota', '+57', 1),
  ('PA', 'Panamá', 'USD', 'Dólar estadounidense', 'es-PA', 'America/Panama', '+507', 2),
  ('VE', 'Venezuela', 'USD', 'Dólar estadounidense', 'es-VE', 'America/Caracas', '+58', 3),
  ('EC', 'Ecuador', 'USD', 'Dólar estadounidense', 'es-EC', 'America/Guayaquil', '+593', 4),
  ('PE', 'Perú', 'PEN', 'Sol peruano', 'es-PE', 'America/Lima', '+51', 5),
  ('BO', 'Bolivia', 'BOB', 'Boliviano', 'es-BO', 'America/La_Paz', '+591', 6),
  ('BR', 'Brasil', 'BRL', 'Real brasileño', 'pt-BR', 'America/Sao_Paulo', '+55', 7),
  ('PY', 'Paraguay', 'PYG', 'Guaraní', 'es-PY', 'America/Asuncion', '+595', 8),
  ('CL', 'Chile', 'CLP', 'Peso chileno', 'es-CL', 'America/Santiago', '+56', 9),
  ('AR', 'Argentina', 'ARS', 'Peso argentino', 'es-AR', 'America/Argentina/Buenos_Aires', '+54', 10),
  ('UY', 'Uruguay', 'UYU', 'Peso uruguayo', 'es-UY', 'America/Montevideo', '+598', 11)
on conflict (code) do nothing;

create table if not exists public.plan_features (
  key text primary key,
  label text not null,
  grp text not null,
  description text,
  core boolean not null default false,   -- viene en todos los planes
  sort_order int not null default 0
);

insert into public.plan_features (key, label, grp, description, core, sort_order) values
  ('mesas', 'Mesas, pedidos y traslados', 'operacion', 'Abre mesas, toma pedidos con propina, cortesías y traslados entre mesas.', true, 1),
  ('caja', 'Caja, cobro y propinas', 'operacion', 'Apertura con base, pagos mixtos, cierre con arqueo y reparto de propinas.', true, 2),
  ('productos', 'Carta, categorías e inventario', 'catalogo', 'Productos con foto, categorías, bodegas por sucursal y alertas de stock.', true, 3),
  ('comandas', 'Comandas de cocina y bar', 'operacion', 'Pantalla de cocina y bar con tiempos de preparación.', false, 4),
  ('carta_qr', 'Carta por QR y llamado al mesero', 'clientes', 'El cliente escanea el QR de su mesa, ve la carta, llama al mesero o hace su pedido.', false, 10),
  ('cuentas_por_cobrar', 'Cuentas por cobrar', 'operacion', 'Lo que no se cobra en el turno queda como cuenta por cobrar con abonos.', false, 11),
  ('promociones', 'Promociones y descuentos', 'catalogo', 'Horas felices, combos y descuentos por fechas y horarios.', false, 12),
  ('incidentes', 'Incidentes y pérdidas', 'control', 'Roturas, faltantes y devoluciones con su responsable.', false, 20),
  ('reportes', 'Reportes de ventas, productos y meseros', 'control', 'Ventas por día, semana o rango; productos, meseros, propinas y uso de mesas.', false, 21),
  ('finanzas', 'Finanzas, bóveda y socios', 'control', 'Fondos por sucursal, gastos, aportes, utilidades y retiros de socios.', false, 22),
  ('bitacora', 'Bitácora del sistema', 'control', 'Quién hizo qué y cuándo dentro del sistema.', false, 23),
  ('telegram', 'Avisos por Telegram', 'control', 'Grupos por sucursal para ventas, caja, stock y llamados.', false, 24),
  ('marca', 'Colores, logo y fuente propios', 'marca', 'El sistema y la carta con la imagen de tu establecimiento.', false, 30)
on conflict (key) do nothing;

create table if not exists public.plans (
  id bigint generated always as identity primary key,
  code text not null unique,
  name text not null,
  tagline text,
  max_sites int check (max_sites is null or max_sites > 0),
  max_admins int check (max_admins is null or max_admins > 0),
  max_employees int check (max_employees is null or max_employees >= 0),
  max_tables int check (max_tables is null or max_tables >= 0),
  max_products int check (max_products is null or max_products >= 0),
  support text,
  highlight boolean not null default false,
  badge text,
  bullets text[] not null default '{}',
  features text[] not null default '{}',
  annual_discount numeric(5,2) not null default 16.7 check (annual_discount >= 0 and annual_discount <= 90),
  trial_days int not null default 15 check (trial_days >= 0),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.plan_prices (
  plan_id bigint not null references public.plans(id) on delete cascade,
  country_code text not null references public.countries(code),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  price_month numeric(14,2) not null check (price_month >= 0),
  primary key (plan_id, country_code)
);

-- Planes iniciales (null = ilimitado). Los precios se ajustan desde la plataforma.
insert into public.plans (code, name, tagline, max_sites, max_admins, max_employees, max_tables, max_products, support, highlight, badge, bullets, features, sort_order) values
  ('esencial', 'Esencial', 'Para el café, el bar o el restaurante que empieza a ordenar su operación.', 1, 1, 5, 15, 150, 'WhatsApp en horario hábil', false, null,
    array['1 sucursal y 5 empleados', 'Hasta 15 mesas', 'Pedidos, caja y propinas', 'Carta, categorías e inventario'],
    array['mesas', 'caja', 'productos', 'comandas', 'cuentas_por_cobrar'], 1),
  ('profesional', 'Profesional', 'Para el establecimiento con buen movimiento que quiere vender más y controlar todo.', 3, 3, 25, 60, 600, 'WhatsApp y llamada', true, 'Más elegido',
    array['3 sucursales y 25 empleados', 'Hasta 60 mesas', 'Carta por QR con pedido desde la mesa', 'Reportes, promociones e incidentes'],
    array['mesas', 'caja', 'productos', 'comandas', 'carta_qr', 'cuentas_por_cobrar', 'promociones', 'incidentes', 'reportes', 'telegram'], 2),
  ('premium', 'Premium', 'Para grupos, discotecas y cadenas con varias sucursales y socios.', null, 10, null, null, null, 'Prioritario con acompañamiento', false, null,
    array['Sucursales, mesas y empleados ilimitados', 'Finanzas, bóveda y socios', 'Bitácora y avisos por Telegram', 'Tu marca: colores, logo y fuente'],
    array['mesas', 'caja', 'productos', 'comandas', 'carta_qr', 'cuentas_por_cobrar', 'promociones', 'incidentes', 'reportes', 'finanzas', 'bitacora', 'telegram', 'marca'], 3)
on conflict (code) do nothing;

insert into public.plan_prices (plan_id, country_code, currency, price_month)
select p.id, v.country, v.currency, case p.code when 'esencial' then v.p1 when 'profesional' then v.p2 else v.p3 end
from public.plans p
cross join (values
  ('CO', 'COP', 79900, 159900, 299900),
  ('PA', 'USD', 22, 42, 79),
  ('VE', 'USD', 18, 35, 65),
  ('EC', 'USD', 22, 42, 79),
  ('PE', 'PEN', 79, 155, 289),
  ('BO', 'BOB', 149, 289, 539),
  ('BR', 'BRL', 109, 215, 399),
  ('PY', 'PYG', 159000, 309000, 579000),
  ('CL', 'CLP', 19900, 38900, 72900),
  ('AR', 'ARS', 22900, 44900, 84900),
  ('UY', 'UYU', 890, 1690, 3190)
) as v(country, currency, p1, p2, p3)
where p.code in ('esencial', 'profesional', 'premium')
on conflict do nothing;

-- Datos comerciales de cada establecimiento.
alter table public.organizations add column if not exists country_code text not null default 'CO' references public.countries(code);
alter table public.organizations add column if not exists plan_id bigint references public.plans(id);
alter table public.organizations add column if not exists billing_cycle text not null default 'mensual' check (billing_cycle in ('mensual', 'anual'));
alter table public.organizations add column if not exists start_date date;
alter table public.organizations add column if not exists renewal_date date;
alter table public.organizations add column if not exists contact_name text;
alter table public.organizations add column if not exists extra_features text[] not null default '{}';
alter table public.organizations add column if not exists notes text;
alter table public.organizations add column if not exists updated_at timestamptz not null default now();

-- El establecimiento de prueba queda en Premium (todo habilitado).
update public.organizations set plan_id = (select id from public.plans where code = 'premium'), status = 'activa',
  start_date = coalesce(start_date, created_at::date), renewal_date = coalesce(renewal_date, (created_at + interval '1 year')::date)
where id = (select min(id) from public.organizations) and plan_id is null;

create table if not exists public.plan_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  from_plan_id bigint references public.plans(id),
  to_plan_id bigint not null references public.plans(id),
  billing_cycle text not null default 'mensual' check (billing_cycle in ('mensual', 'anual')),
  message text,
  contact_phone text,
  requested_by bigint references public.users(id),
  status text not null default 'pendiente' check (status in ('pendiente', 'contactado', 'aplicada', 'rechazada')),
  response text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plan_requests_org_idx on public.plan_requests (org_id, created_at desc);

alter table public.users add column if not exists platform_admin boolean not null default false;
-- El super administrador del establecimiento de prueba administra la plataforma de planes.
update public.users set platform_admin = true
where org_id = (select min(id) from public.organizations) and role = 'superadmin';

alter table public.countries enable row level security;
alter table public.plan_features enable row level security;
alter table public.plans enable row level security;
alter table public.plan_prices enable row level security;
alter table public.plan_requests enable row level security;
