-- =====================================================================
-- TD-002 · Catálogo e inventario
-- · Categorías de la carta (bebidas, comida rápida, postres…) con emoji, color y área de preparación
--   (cocina, bar o barista: en la etapa 3 decide a qué pantalla va cada pedido).
-- · Productos con unidad de medida. Los que manejan inventario llevan existencias por bodega
--   (warehouse_stock); products.stock es el total de todas las bodegas.
-- · Movimientos: entrada (compra), ajuste (+/-), baja (daño o pérdida), traslados entre bodegas
--   y, desde la etapa 3, venta y devolución. Ninguna bodega puede quedar en negativo.
-- · Descuentos (se aplican a un pedido) y promociones (precio especial por producto, categoría o
--   toda la carta, por fechas, franja horaria y días de la semana).
-- · Notificaciones por Telegram: el bot del establecimiento y los grupos que reciben cada sección
--   (inventario ahora; pedidos, caja y mesas en la etapa 3), por sucursal o para todas.
-- =====================================================================

-- ---------- Categorías ----------
create table public.product_categories (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  emoji text,
  color text not null default '#E4572E' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  area text not null default 'cocina' check (area in ('cocina', 'bar', 'barista', 'ninguna')),
  sort_order int not null default 0,
  show_in_menu boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint product_categories_org_name_key unique (org_id, name)
);
create index product_categories_org_idx on public.product_categories (org_id, sort_order, name);

-- ---------- Productos ----------
create table public.products (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  sku text,
  name text not null,
  category_id bigint references public.product_categories(id) on delete set null,
  description text,
  unit text not null default 'und' check (unit in ('und', 'porcion', 'botella', 'g', 'kg', 'ml', 'l')),
  cost numeric(14, 2) not null default 0 check (cost >= 0),
  price numeric(14, 2) not null default 0 check (price >= 0),
  -- false: se vende sin controlar existencias (p. ej. un plato preparado al momento).
  track_stock boolean not null default true,
  stock numeric(14, 3) not null default 0 check (stock >= 0),
  min_stock numeric(14, 3) not null default 0 check (min_stock >= 0),
  photo_url text,
  gallery text[] not null default '{}',
  show_in_menu boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_org_sku_key unique (org_id, sku),
  constraint products_gallery_max check (coalesce(array_length(gallery, 1), 0) <= 3)
);
create index products_org_name_idx on public.products (org_id, name);
create index products_category_idx on public.products (category_id);
create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();

-- ---------- Existencias por bodega ----------
-- low_alerted: ya se avisó que esta bodega quedó en el mínimo o por debajo; vuelve a false al reponer.
create table public.warehouse_stock (
  org_id bigint not null references public.organizations(id) on delete cascade,
  warehouse_id bigint not null references public.warehouses(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  stock numeric(14, 3) not null default 0 check (stock >= 0),
  low_alerted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (warehouse_id, product_id)
);
create index warehouse_stock_org_idx on public.warehouse_stock (org_id);
create index warehouse_stock_product_idx on public.warehouse_stock (product_id);

-- ---------- Movimientos ----------
create table public.inventory_movements (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  warehouse_id bigint not null references public.warehouses(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  type text not null check (type in ('entrada', 'ajuste', 'baja', 'traslado_salida', 'traslado_entrada', 'venta', 'devolucion')),
  quantity numeric(14, 3) not null check (quantity <> 0),  -- con signo: positivo entra, negativo sale
  unit_cost numeric(14, 2),
  stock_after numeric(14, 3),                               -- existencias de la bodega después del movimiento
  ref text,                                                 -- consecutivo que agrupa (EN-00001, TR-00001…)
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index inventory_movements_org_idx on public.inventory_movements (org_id, created_at desc);
create index inventory_movements_product_idx on public.inventory_movements (product_id, created_at desc);
create index inventory_movements_warehouse_idx on public.inventory_movements (warehouse_id, created_at desc);
create index inventory_movements_ref_idx on public.inventory_movements (org_id, ref);

-- Cada movimiento mueve las existencias de su bodega y el total del producto, y guarda cómo quedó la bodega.
-- Si una bodega quedara en negativo, se cancela toda la operación (también los traslados de varios productos).
create or replace function public.apply_inventory_movement() returns trigger
language plpgsql set search_path = '' as $$
declare p record; w text; s numeric;
begin
  select name, track_stock into p from public.products where id = new.product_id and org_id = new.org_id for update;
  if p.name is null then raise exception 'Producto no encontrado' using errcode = 'P0001'; end if;
  if not p.track_stock then raise exception '"%" no maneja inventario', p.name using errcode = 'P0001'; end if;
  select name into w from public.warehouses where id = new.warehouse_id and org_id = new.org_id;
  if w is null then raise exception 'Bodega no encontrada' using errcode = 'P0001'; end if;
  insert into public.warehouse_stock (org_id, warehouse_id, product_id) values (new.org_id, new.warehouse_id, new.product_id)
    on conflict (warehouse_id, product_id) do nothing;
  select stock into s from public.warehouse_stock where warehouse_id = new.warehouse_id and product_id = new.product_id for update;
  if s + new.quantity < 0 then
    raise exception 'No hay suficiente "%" en % (disponible: %)', p.name, w, trim(trailing '.' from trim(trailing '0' from s::text)) using errcode = 'P0001';
  end if;
  update public.warehouse_stock set stock = stock + new.quantity, updated_at = now()
    where warehouse_id = new.warehouse_id and product_id = new.product_id;
  update public.products set stock = stock + new.quantity where id = new.product_id;
  if new.type = 'entrada' and new.unit_cost is not null then
    update public.products set cost = new.unit_cost where id = new.product_id;
  end if;
  new.stock_after := s + new.quantity;
  return new;
end $$;
create trigger inventory_movements_apply before insert on public.inventory_movements for each row execute function public.apply_inventory_movement();

-- Traslado entre bodegas: una salida y una entrada por producto, con el mismo consecutivo TR-00001.
create or replace function public.transfer_stock(p jsonb) returns text
language plpgsql set search_path = '' as $$
declare
  v_org bigint := (p->>'org_id')::bigint;
  v_from bigint := (p->>'from_warehouse_id')::bigint;
  v_to bigint := (p->>'to_warehouse_id')::bigint;
  v_user bigint := nullif(p->>'user_id', '')::bigint;
  v_ref text;
  r jsonb;
begin
  if v_from = v_to then raise exception 'La bodega de origen y la de destino son la misma' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.warehouses where id = v_from and org_id = v_org) then raise exception 'Bodega de origen no encontrada' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.warehouses where id = v_to and org_id = v_org and active) then raise exception 'La bodega de destino no existe o está inactiva' using errcode = 'P0001'; end if;
  v_ref := public.next_consecutive(v_org, 'traslado', 0, 'TR-');
  for r in select * from jsonb_array_elements(p->'items') loop
    if coalesce((r->>'quantity')::numeric, 0) <= 0 then raise exception 'Cantidad inválida en el traslado' using errcode = 'P0001'; end if;
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, ref, note, user_id)
      values (v_org, v_from, (r->>'product_id')::bigint, 'traslado_salida', -(r->>'quantity')::numeric, v_ref, p->>'note', v_user);
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, ref, note, user_id)
      values (v_org, v_to, (r->>'product_id')::bigint, 'traslado_entrada', (r->>'quantity')::numeric, v_ref, p->>'note', v_user);
  end loop;
  return v_ref;
end $$;

-- ---------- Descuentos (sobre el total de un pedido) ----------
create table public.discounts (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  type text not null check (type in ('porcentaje', 'valor')),
  value numeric(14, 2) not null check (value > 0),
  icon text not null default 'tag',
  color text not null default '#E4572E' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  description text,
  -- Si se exige, quien lo aplica debe escribir el motivo (queda en la bitácora del pedido).
  requires_reason boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint discounts_org_name_key unique (org_id, name),
  constraint discounts_pct_check check (type <> 'porcentaje' or value <= 100)
);

-- ---------- Promociones (precio especial por producto) ----------
create table public.promotions (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null,
  tag text,
  emoji text,
  color text not null default '#E4572E' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  description text,
  type text not null check (type in ('porcentaje', 'valor')),
  value numeric(14, 2) not null check (value > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  time_from time,
  time_to time,
  weekdays smallint[] not null default '{}',
  scope text not null default 'todos' check (scope in ('todos', 'categorias', 'productos')),
  category_ids bigint[] not null default '{}',
  product_ids bigint[] not null default '{}',
  active boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type <> 'porcentaje' or value <= 100),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check ((time_from is null) = (time_to is null))
);
create index promotions_org_idx on public.promotions (org_id, active);

-- ---------- Notificaciones por Telegram ----------
create table public.notification_settings (
  org_id bigint primary key references public.organizations(id) on delete cascade,
  bot_token text,
  bot_username text,
  bot_name text,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.notification_channels (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  section text not null check (section in ('inventario', 'pedidos', 'caja', 'mesas', 'resumen')),
  site_id bigint references public.sites(id) on delete cascade,
  chat_id text not null,
  title text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index notification_channels_unique_idx on public.notification_channels (org_id, section, coalesce(site_id, 0), chat_id);

create table public.notification_log (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  section text not null,
  site_id bigint,
  chat_id text,
  status text not null check (status in ('enviado', 'error')),
  detail text,
  created_at timestamptz not null default now()
);
create index notification_log_org_idx on public.notification_log (org_id, created_at desc);

-- ---------- Seguridad: solo el backend (clave secreta) accede ----------
alter table public.product_categories enable row level security;
alter table public.products enable row level security;
alter table public.warehouse_stock enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.discounts enable row level security;
alter table public.promotions enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notification_channels enable row level security;
alter table public.notification_log enable row level security;
revoke all on public.product_categories, public.products, public.warehouse_stock, public.inventory_movements, public.discounts,
  public.promotions, public.notification_settings, public.notification_channels, public.notification_log from anon, authenticated;
revoke execute on function public.apply_inventory_movement() from public, anon, authenticated;
revoke execute on function public.transfer_stock(jsonb) from public, anon, authenticated;
grant execute on function public.transfer_stock(jsonb) to service_role;
