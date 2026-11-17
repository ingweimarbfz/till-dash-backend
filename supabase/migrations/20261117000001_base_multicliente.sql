-- =====================================================================
-- TD-001 · Base multi-cliente de TillDash+
-- Cada establecimiento que contrata TillDash+ es una organización (org_id). Todas las tablas del
-- negocio llevan org_id. El backend usa la clave secreta; el navegador nunca toca la base
-- directamente, por eso RLS queda activado sin políticas: anon y authenticated no ven nada.
-- =====================================================================

-- ---------- Organizaciones (establecimientos que contratan) ----------
create table public.organizations (
  id bigint generated always as identity primary key,
  name text not null,
  business_type text not null default 'restaurante'
    check (business_type in ('restaurante', 'bar', 'market', 'social_bar', 'discoteca', 'cafeteria', 'otro')),
  nit text,
  phone text,
  email text,
  address text,
  city text,
  status text not null default 'prueba' check (status in ('activa', 'prueba', 'suspendida', 'cancelada')),
  created_at timestamptz not null default now()
);

-- ---------- Sucursales ----------
create table public.sites (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  city text,
  address text,
  phone text,
  is_main boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint sites_org_name_key unique (org_id, name)
);
create unique index sites_one_main_idx on public.sites (org_id) where is_main;

-- ---------- Bodegas: una principal por establecimiento y las que se quieran por sucursal ----------
create table public.warehouses (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete restrict,
  name text not null,
  description text,
  responsible text,
  is_main boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint warehouses_org_name_key unique (org_id, name),
  -- La bodega principal es del establecimiento; las demás pertenecen a una sucursal.
  constraint warehouses_site_chk check (is_main or site_id is not null)
);
create unique index warehouses_one_main_idx on public.warehouses (org_id) where is_main;
create index warehouses_site_idx on public.warehouses (site_id);

-- ---------- Usuarios ----------
-- role es el perfil principal; extra_roles, perfiles adicionales del mismo usuario.
-- · superadmin: todo el sistema, incluida la apariencia del sitio (colores, logo, fuente).
-- · admin: todo menos la apariencia del sitio.
-- · empleado: según sus cargos (positions): mesero, cajero, cocina, bartender, etc.
-- · cliente: consulta su mesa, la carta y sus pedidos.
create table public.users (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete set null,
  identification text not null,
  name text not null,
  last_name text not null default '',
  username text not null,
  email text,
  phone text,
  role text not null check (role in ('superadmin', 'admin', 'empleado', 'cliente')),
  extra_roles text[] not null default '{}',
  positions text[] not null default '{}',
  password_hash text not null,
  avatar_url text,
  signature_url text,
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_username_key unique (username),
  constraint users_org_identification_key unique (org_id, identification),
  constraint users_extra_roles_chk check (extra_roles <@ array['admin', 'empleado']::text[] and not (role = any(extra_roles))),
  constraint users_positions_chk check (positions <@ array['mesero', 'cajero', 'cocina', 'bartender', 'barista', 'domiciliario', 'host', 'bodega']::text[])
);
create index users_org_role_idx on public.users (org_id, role);
create index users_site_idx on public.users (site_id);

-- ---------- Configuración del establecimiento (una fila por organización) ----------
create table public.app_settings (
  org_id bigint primary key references public.organizations(id) on delete cascade,
  business_name text not null,
  short_name text,
  slogan text,
  logo_url text,
  favicon_url text,
  -- Apariencia (solo superadmin). Colores en #RRGGBB.
  color_primary text not null default '#E4572E',
  color_secondary text not null default '#1F2933',
  color_accent text not null default '#F2A541',
  font_family text not null default 'Outfit',
  theme_mode text not null default 'claro' check (theme_mode in ('claro', 'oscuro', 'sistema')),
  -- Operación
  currency text not null default 'COP',
  timezone text not null default 'America/Bogota',
  tip_percent numeric(5,2) not null default 10 check (tip_percent between 0 and 100),
  tip_suggested boolean not null default true,
  receipt_footer text,
  social jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint app_settings_colors_chk check (
    color_primary ~ '^#[0-9A-Fa-f]{6}$' and color_secondary ~ '^#[0-9A-Fa-f]{6}$' and color_accent ~ '^#[0-9A-Fa-f]{6}$'
  )
);

-- ---------- Bitácora del sistema: quién hizo qué y cuándo ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  user_id bigint references public.users(id) on delete set null,
  site_id bigint references public.sites(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_log_org_created_idx on public.audit_log (org_id, created_at desc);
create index audit_log_org_user_created_idx on public.audit_log (org_id, user_id, created_at desc);
create index audit_log_org_entity_idx on public.audit_log (org_id, entity, entity_id);

-- ---------- Consecutivos (órdenes, facturas, traslados, cierres de caja…) ----------
-- Un contador por organización, sucursal y tipo de documento. next_consecutive() bloquea la fila,
-- así dos cajas no pueden sacar el mismo número.
create table public.doc_sequences (
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null default 0,
  kind text not null,
  prefix text not null default '',
  last_number bigint not null default 0,
  primary key (org_id, site_id, kind)
);

create or replace function public.next_consecutive(p_org bigint, p_kind text, p_site bigint default 0, p_prefix text default '')
returns text language plpgsql set search_path = '' as $$
declare n bigint; pre text;
begin
  insert into public.doc_sequences (org_id, site_id, kind, prefix) values (p_org, coalesce(p_site, 0), p_kind, coalesce(p_prefix, ''))
    on conflict (org_id, site_id, kind) do nothing;
  update public.doc_sequences set last_number = last_number + 1
    where org_id = p_org and site_id = coalesce(p_site, 0) and kind = p_kind
    returning last_number, prefix into n, pre;
  return pre || lpad(n::text, 5, '0');
end $$;

-- ---------- Utilidades ----------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end $$;
create trigger users_touch before update on public.users for each row execute function public.touch_updated_at();
create trigger app_settings_touch before update on public.app_settings for each row execute function public.touch_updated_at();

-- Al crear una organización: configuración, sucursal principal y bodega principal.
create or replace function public.bootstrap_organization() returns trigger
language plpgsql set search_path = '' as $$
begin
  insert into public.app_settings (org_id, business_name) values (new.id, new.name);
  insert into public.sites (org_id, name, city, address, phone, is_main) values (new.id, 'Sede principal', new.city, new.address, new.phone, true);
  insert into public.warehouses (org_id, site_id, name, is_main) values (new.id, null, 'Bodega principal', true);
  return new;
end $$;
create trigger organizations_bootstrap after insert on public.organizations for each row execute function public.bootstrap_organization();

-- ---------- Seguridad: solo el backend (clave secreta) accede ----------
alter table public.organizations enable row level security;
alter table public.sites enable row level security;
alter table public.warehouses enable row level security;
alter table public.users enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log enable row level security;
alter table public.doc_sequences enable row level security;
revoke all on public.organizations, public.sites, public.warehouses, public.users, public.app_settings, public.audit_log, public.doc_sequences from anon, authenticated;
revoke execute on function public.next_consecutive(bigint, text, bigint, text) from public, anon, authenticated;
grant execute on function public.next_consecutive(bigint, text, bigint, text) to service_role;
