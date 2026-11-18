-- =====================================================================
-- TD-003 · Mesas, pedidos, cobro, caja, bóveda y cuentas por cobrar
-- · Zonas y mesas por sucursal. Cada mesa tiene un código QR (qr_token) para la carta y el llamado.
-- · Pedidos con consecutivo por sucursal (P-00001). Una mesa tiene a lo sumo un pedido abierto.
-- · Cada producto del pedido va a su área (cocina, bar, barista). Si maneja inventario, se descuenta
--   de la bodega de la sucursal al pedirlo y vuelve a la bodega si se anula.
-- · Cortesías por producto (con motivo), un descuento por pedido y propina al cobrar.
-- · Cobro en una o varias formas de pago dentro de un turno de caja abierto. "Cuenta por cobrar"
--   deja la deuda a nombre del cliente y se abona después.
-- · Caja: turnos con base inicial, ingresos, egresos y cierre con arqueo. El efectivo sobrante
--   pasa a la bóveda de la sucursal, que también entrega la base de la caja.
-- · Llamados de mesa desde la carta QR: llamar al mesero o pedir la cuenta.
-- =====================================================================

-- ---------- Zonas y mesas ----------
create table public.dining_areas (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint dining_areas_name_key unique (org_id, site_id, name)
);

create table public.dining_tables (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  area_id bigint references public.dining_areas(id) on delete set null,
  name text not null,
  seats integer not null default 4 check (seats between 1 and 50),
  shape text not null default 'cuadrada' check (shape in ('cuadrada', 'redonda', 'barra')),
  sort_order integer not null default 0,
  qr_token text not null default substr(replace(gen_random_uuid()::text, '-', ''), 1, 18),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint dining_tables_name_key unique (org_id, site_id, name),
  constraint dining_tables_qr_key unique (qr_token)
);
create index dining_tables_site_idx on public.dining_tables (site_id, sort_order);

-- ---------- Caja y bóveda ----------
create table public.cash_registers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint cash_registers_name_key unique (org_id, site_id, name)
);

create table public.cash_sessions (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  register_id bigint not null references public.cash_registers(id) on delete restrict,
  number text not null,
  status text not null default 'abierta' check (status in ('abierta', 'cerrada')),
  opening_amount numeric(14, 2) not null default 0 check (opening_amount >= 0),
  expected_cash numeric(14, 2),
  counted_cash numeric(14, 2),
  difference numeric(14, 2),
  to_vault numeric(14, 2) not null default 0,
  opened_by bigint references public.users(id) on delete set null,
  closed_by bigint references public.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  note text,
  close_note text
);
create unique index cash_sessions_open_idx on public.cash_sessions (register_id) where status = 'abierta';
create index cash_sessions_site_idx on public.cash_sessions (site_id, opened_at desc);

create table public.vaults (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  balance numeric(16, 2) not null default 0 check (balance >= 0),
  constraint vaults_site_key unique (site_id)
);

create table public.vault_movements (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  vault_id bigint not null references public.vaults(id) on delete restrict,
  type text not null check (type in ('deposito', 'retiro', 'cierre_caja', 'base_caja', 'consignacion', 'ajuste')),
  amount numeric(16, 2) not null check (amount <> 0),
  balance_after numeric(16, 2) not null default 0,
  session_id bigint references public.cash_sessions(id) on delete set null,
  ref text,
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index vault_movements_vault_idx on public.vault_movements (vault_id, created_at desc);

-- ---------- Pedidos ----------
create table public.orders (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete restrict,
  number text not null,
  type text not null default 'mesa' check (type in ('mesa', 'llevar', 'domicilio', 'barra')),
  status text not null default 'abierto' check (status in ('abierto', 'cobrado', 'anulado')),
  table_id bigint references public.dining_tables(id) on delete set null,
  guests integer check (guests between 1 and 100),
  customer_name text,
  customer_phone text,
  customer_address text,
  note text,
  waiter_id bigint references public.users(id) on delete set null,
  opened_by bigint references public.users(id) on delete set null,
  gross numeric(14, 2) not null default 0,          -- suma de los productos (con promoción), sin anulados
  courtesy_total numeric(14, 2) not null default 0, -- lo que se regaló
  subtotal numeric(14, 2) not null default 0,       -- gross − cortesías
  discount_id bigint references public.discounts(id) on delete set null,
  discount_name text,
  discount_type text check (discount_type in ('porcentaje', 'valor')),
  discount_value numeric(14, 2),
  discount_reason text,
  discount_total numeric(14, 2) not null default 0,
  tip numeric(14, 2) not null default 0 check (tip >= 0),
  total numeric(14, 2) not null default 0,
  paid numeric(14, 2) not null default 0,
  bill_requested_at timestamptz,
  session_id bigint references public.cash_sessions(id) on delete set null,
  cashier_id bigint references public.users(id) on delete set null,
  void_reason text,
  voided_by bigint references public.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint orders_number_key unique (org_id, site_id, number),
  constraint orders_table_chk check (type <> 'mesa' or table_id is not null or status <> 'abierto')
);
create unique index orders_open_table_idx on public.orders (table_id) where status = 'abierto' and table_id is not null;
create index orders_site_status_idx on public.orders (site_id, status, opened_at desc);
create index orders_org_closed_idx on public.orders (org_id, closed_at desc);
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();

create table public.order_items (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  order_id bigint not null references public.orders(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  name text not null,
  area text not null default 'ninguna' check (area in ('cocina', 'bar', 'barista', 'ninguna')),
  quantity numeric(12, 3) not null check (quantity > 0),
  list_price numeric(14, 2) not null default 0,
  unit_price numeric(14, 2) not null default 0,
  promotion_id bigint references public.promotions(id) on delete set null,
  promotion_name text,
  courtesy boolean not null default false,
  courtesy_reason text,
  courtesy_by bigint references public.users(id) on delete set null,
  note text,
  status text not null default 'pendiente' check (status in ('pendiente', 'preparando', 'listo', 'entregado', 'anulado')),
  void_reason text,
  warehouse_id bigint references public.warehouses(id) on delete set null,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ready_at timestamptz,
  delivered_at timestamptz,
  constraint order_items_courtesy_chk check (not courtesy or courtesy_reason is not null)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_kitchen_idx on public.order_items (org_id, area, status, created_at);

create table public.order_payments (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  order_id bigint not null references public.orders(id) on delete cascade,
  session_id bigint references public.cash_sessions(id) on delete set null,
  method text not null check (method in ('efectivo', 'tarjeta', 'transferencia', 'nequi', 'daviplata', 'cuenta_por_cobrar', 'otro')),
  amount numeric(14, 2) not null check (amount > 0),
  received numeric(14, 2),
  change numeric(14, 2),
  reference text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index order_payments_order_idx on public.order_payments (order_id);

-- ---------- Cuentas por cobrar ----------
create table public.receivables (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete restrict,
  order_id bigint references public.orders(id) on delete set null,
  number text not null,
  customer_name text not null,
  customer_doc text,
  customer_phone text,
  amount numeric(14, 2) not null check (amount > 0),
  paid numeric(14, 2) not null default 0 check (paid >= 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'pagada', 'anulada')),
  due_date date,
  note text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint receivables_paid_chk check (paid <= amount)
);
create index receivables_org_status_idx on public.receivables (org_id, status, created_at desc);

create table public.receivable_payments (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  receivable_id bigint not null references public.receivables(id) on delete cascade,
  session_id bigint references public.cash_sessions(id) on delete set null,
  method text not null check (method in ('efectivo', 'tarjeta', 'transferencia', 'nequi', 'daviplata', 'otro')),
  amount numeric(14, 2) not null check (amount > 0),
  reference text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Movimientos del turno de caja. amount con signo; method dice si es efectivo (cuenta para el arqueo).
create table public.cash_movements (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  type text not null check (type in ('apertura', 'venta', 'abono', 'ingreso', 'egreso', 'a_boveda', 'propina_pagada')),
  method text not null default 'efectivo' check (method in ('efectivo', 'tarjeta', 'transferencia', 'nequi', 'daviplata', 'otro')),
  amount numeric(14, 2) not null check (amount <> 0),
  order_id bigint references public.orders(id) on delete set null,
  receivable_id bigint references public.receivables(id) on delete set null,
  ref text,
  note text,
  user_id bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index cash_movements_session_idx on public.cash_movements (session_id, created_at);

-- ---------- Llamados de mesa (desde la carta QR) ----------
create table public.table_calls (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  table_id bigint not null references public.dining_tables(id) on delete cascade,
  kind text not null check (kind in ('mesero', 'cuenta')),
  status text not null default 'pendiente' check (status in ('pendiente', 'atendido')),
  note text,
  attended_by bigint references public.users(id) on delete set null,
  attended_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index table_calls_pending_idx on public.table_calls (table_id, kind) where status = 'pendiente';
create index table_calls_site_idx on public.table_calls (site_id, status, created_at desc);

-- =====================================================================
-- Funciones
-- =====================================================================

-- Dinero en formato colombiano para los mensajes de error: $50.000
create or replace function public.fmt_money(v numeric) returns text
language sql immutable set search_path = '' as $$ select '$' || replace(to_char(round(coalesce(v, 0)), 'FM999,999,999,990'), ',', '.') $$;

-- Bodega de la que vende una sucursal: la primera activa de la sucursal; si no tiene, la principal.
create or replace function public.sale_warehouse(p_site bigint) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(
    (select w.id from public.warehouses w where w.site_id = p_site and w.active order by w.id limit 1),
    (select w.id from public.warehouses w join public.sites s on s.org_id = w.org_id where s.id = p_site and w.is_main)
  )
$$;

-- Recalcula los totales de un pedido abierto. El descuento se aplica sobre el subtotal y nunca lo supera.
create or replace function public.recalc_order(p_order bigint) returns void
language plpgsql set search_path = '' as $$
declare v_gross numeric; v_court numeric; v_sub numeric; v_disc numeric; o record;
begin
  select * into o from public.orders where id = p_order;
  if o.id is null or o.status <> 'abierto' then return; end if;
  select coalesce(sum(round(quantity * unit_price)), 0), coalesce(sum(round(quantity * unit_price)) filter (where courtesy), 0)
    into v_gross, v_court from public.order_items where order_id = p_order and status <> 'anulado';
  v_sub := v_gross - v_court;
  v_disc := case when o.discount_type = 'porcentaje' then round(v_sub * o.discount_value / 100)
                 when o.discount_type = 'valor' then least(o.discount_value, v_sub) else 0 end;
  update public.orders set gross = v_gross, courtesy_total = v_court, subtotal = v_sub, discount_total = v_disc,
    total = v_sub - v_disc + tip where id = p_order;
end $$;

-- Al pedir un producto con inventario se descuenta de la bodega de la sucursal (sin stock, no se puede pedir).
create or replace function public.order_item_stock() returns trigger
language plpgsql set search_path = '' as $$
declare v_track boolean; v_site bigint; v_num text;
begin
  select track_stock into v_track from public.products where id = new.product_id;
  if tg_op = 'INSERT' then
    if v_track then
      select o.site_id, o.number into v_site, v_num from public.orders o where o.id = new.order_id;
      new.warehouse_id := coalesce(new.warehouse_id, public.sale_warehouse(v_site));
      insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, ref, note, user_id)
        values (new.org_id, new.warehouse_id, new.product_id, 'venta', -new.quantity, v_num, 'Pedido ' || v_num, new.user_id);
    end if;
  elsif new.status = 'anulado' and old.status <> 'anulado' and v_track and new.warehouse_id is not null then
    select o.number into v_num from public.orders o where o.id = new.order_id;
    insert into public.inventory_movements (org_id, warehouse_id, product_id, type, quantity, ref, note, user_id)
      values (new.org_id, new.warehouse_id, new.product_id, 'devolucion', new.quantity, v_num, 'Anulado del pedido ' || v_num || coalesce(': ' || new.void_reason, ''), new.user_id);
  end if;
  return new;
end $$;
create trigger order_items_stock_ins before insert on public.order_items for each row execute function public.order_item_stock();
create trigger order_items_stock_upd before update of status on public.order_items for each row execute function public.order_item_stock();

create or replace function public.order_items_recalc() returns trigger
language plpgsql set search_path = '' as $$
begin perform public.recalc_order(coalesce(new.order_id, old.order_id)); return null; end $$;
create trigger order_items_recalc after insert or update or delete on public.order_items for each row execute function public.order_items_recalc();

-- Bóveda de una sucursal (se crea si no existe).
create or replace function public.vault_of(p_org bigint, p_site bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  select id into v from public.vaults where site_id = p_site and org_id = p_org;
  if v is null then insert into public.vaults (org_id, site_id) values (p_org, p_site) returning id into v; end if;
  return v;
end $$;

create or replace function public.apply_vault_movement() returns trigger
language plpgsql set search_path = '' as $$
declare v_bal numeric;
begin
  select balance into v_bal from public.vaults where id = new.vault_id and org_id = new.org_id for update;
  if v_bal is null then raise exception 'Bóveda no encontrada' using errcode = 'P0001'; end if;
  if v_bal + new.amount < 0 then
    raise exception 'La bóveda no tiene suficiente dinero (disponible: %)', public.fmt_money(v_bal) using errcode = 'P0001';
  end if;
  update public.vaults set balance = balance + new.amount where id = new.vault_id returning balance into new.balance_after;
  return new;
end $$;
create trigger vault_movements_apply before insert on public.vault_movements for each row execute function public.apply_vault_movement();

-- Efectivo esperado en un turno: base + todo lo que entró o salió en efectivo.
create or replace function public.session_cash(p_session bigint) returns numeric
language sql stable set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.cash_movements where session_id = p_session and method = 'efectivo'
$$;

-- Abrir un turno. p: {org_id, register_id, user_id, opening_amount, from_vault, note}
create or replace function public.open_cash_session(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; r record; v_id bigint; v_num text; v_amt numeric := coalesce((p->>'opening_amount')::numeric, 0);
begin
  select * into r from public.cash_registers where id = (p->>'register_id')::bigint and org_id = v_org;
  if r.id is null or not r.active then raise exception 'La caja no existe o está inactiva' using errcode = 'P0001'; end if;
  if exists (select 1 from public.cash_sessions where register_id = r.id and status = 'abierta') then
    raise exception 'La caja % ya tiene un turno abierto', r.name using errcode = 'P0001';
  end if;
  if v_amt < 0 then raise exception 'La base no puede ser negativa' using errcode = 'P0001'; end if;
  v_num := public.next_consecutive(v_org, 'turno_caja', r.site_id, 'TC-');
  insert into public.cash_sessions (org_id, site_id, register_id, number, opening_amount, opened_by, note)
    values (v_org, r.site_id, r.id, v_num, v_amt, (p->>'user_id')::bigint, nullif(p->>'note', '')) returning id into v_id;
  if v_amt > 0 then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, v_id, 'apertura', 'efectivo', v_amt, v_num, 'Base de la caja', (p->>'user_id')::bigint);
    if coalesce((p->>'from_vault')::boolean, false) then
      insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
        values (v_org, public.vault_of(v_org, r.site_id), 'base_caja', -v_amt, v_id, v_num, 'Base para ' || r.name, (p->>'user_id')::bigint);
    end if;
  end if;
  return v_id;
end $$;

-- Cerrar un turno con arqueo. p: {org_id, session_id, user_id, counted_cash, to_vault, note}
create or replace function public.close_cash_session(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; s record; v_exp numeric; v_cnt numeric := (p->>'counted_cash')::numeric;
  v_vault numeric := coalesce((p->>'to_vault')::numeric, 0); v_user bigint := (p->>'user_id')::bigint;
begin
  select * into s from public.cash_sessions where id = (p->>'session_id')::bigint and org_id = v_org for update;
  if s.id is null then raise exception 'Turno no encontrado' using errcode = 'P0001'; end if;
  if s.status <> 'abierta' then raise exception 'El turno % ya está cerrado', s.number using errcode = 'P0001'; end if;
  if v_cnt is null or v_cnt < 0 then raise exception 'Escribe el efectivo contado' using errcode = 'P0001'; end if;
  if v_vault < 0 or v_vault > v_cnt then raise exception 'Lo que pasa a la bóveda no puede superar el efectivo contado' using errcode = 'P0001'; end if;
  v_exp := public.session_cash(s.id);
  if v_vault > 0 then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, s.id, 'a_boveda', 'efectivo', -v_vault, s.number, 'Cierre: pasa a la bóveda', v_user);
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, s.site_id), 'cierre_caja', v_vault, s.id, s.number, 'Cierre del turno ' || s.number, v_user);
  end if;
  update public.cash_sessions set status = 'cerrada', expected_cash = v_exp, counted_cash = v_cnt, difference = v_cnt - v_exp,
    to_vault = v_vault, closed_by = v_user, closed_at = now(), close_note = nullif(p->>'note', '') where id = s.id;
  return jsonb_build_object('number', s.number, 'expected', v_exp, 'counted', v_cnt, 'difference', v_cnt - v_exp, 'toVault', v_vault);
end $$;

-- Cobrar un pedido. p: {org_id, order_id, session_id, user_id, tip, discount: {id,name,type,value,reason}|null,
--   payments: [{method, amount, received, reference}], receivable: {customer_name, customer_doc, customer_phone, due_date, note}}
create or replace function public.charge_order(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; o record; v_sid bigint; v_ssite bigint; v_sstatus text; v_user bigint := (p->>'user_id')::bigint;
  v_tip numeric := coalesce((p->>'tip')::numeric, 0); d jsonb := p->'discount'; pay jsonb; v_sum numeric := 0; v_total numeric;
  v_cxc numeric := 0; v_rnum text; v_rid bigint; v_cash_change numeric := 0;
begin
  select * into o from public.orders where id = (p->>'order_id')::bigint and org_id = v_org for update;
  if o.id is null then raise exception 'Pedido no encontrado' using errcode = 'P0001'; end if;
  if o.status <> 'abierto' then raise exception 'El pedido % ya está %', o.number, o.status using errcode = 'P0001'; end if;
  if not exists (select 1 from public.order_items where order_id = o.id and status <> 'anulado') then
    raise exception 'El pedido no tiene productos' using errcode = 'P0001';
  end if;
  if (p->>'session_id') is not null then
    select id, site_id, status into v_sid, v_ssite, v_sstatus from public.cash_sessions where id = (p->>'session_id')::bigint and org_id = v_org;
    if v_sid is null or v_sstatus <> 'abierta' then raise exception 'El turno de caja no está abierto' using errcode = 'P0001'; end if;
    if v_ssite <> o.site_id then raise exception 'El turno de caja es de otra sucursal' using errcode = 'P0001'; end if;
  end if;
  if v_tip < 0 then raise exception 'La propina no puede ser negativa' using errcode = 'P0001'; end if;

  update public.orders set tip = v_tip,
    discount_id = nullif(d->>'id', '')::bigint, discount_name = d->>'name', discount_type = d->>'type',
    discount_value = (d->>'value')::numeric, discount_reason = nullif(d->>'reason', '')
    where id = o.id;
  perform public.recalc_order(o.id);
  select total into v_total from public.orders where id = o.id;

  for pay in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    v_sum := v_sum + (pay->>'amount')::numeric;
    if pay->>'method' = 'cuenta_por_cobrar' then v_cxc := v_cxc + (pay->>'amount')::numeric; end if;
  end loop;
  if v_sum <> v_total then
    raise exception 'Los pagos (%) no suman el total del pedido (%)', public.fmt_money(v_sum), public.fmt_money(v_total) using errcode = 'P0001';
  end if;
  if v_sid is null and v_sum - v_cxc > 0 then raise exception 'Abre un turno de caja para cobrar' using errcode = 'P0001'; end if;

  if v_cxc > 0 then
    if coalesce(trim(p->'receivable'->>'customer_name'), '') = '' then
      raise exception 'Escribe a nombre de quién queda la cuenta por cobrar' using errcode = 'P0001';
    end if;
    v_rnum := public.next_consecutive(v_org, 'cuenta_cobrar', 0, 'CC-');
    insert into public.receivables (org_id, site_id, order_id, number, customer_name, customer_doc, customer_phone, amount, due_date, note, created_by)
      values (v_org, o.site_id, o.id, v_rnum, trim(p->'receivable'->>'customer_name'), nullif(p->'receivable'->>'customer_doc', ''),
        nullif(p->'receivable'->>'customer_phone', ''), v_cxc, nullif(p->'receivable'->>'due_date', '')::date, nullif(p->'receivable'->>'note', ''), v_user)
      returning id into v_rid;
  end if;

  for pay in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    insert into public.order_payments (org_id, order_id, session_id, method, amount, received, change, reference, user_id)
      values (v_org, o.id, v_sid, pay->>'method', (pay->>'amount')::numeric, (pay->>'received')::numeric,
        case when pay->>'method' = 'efectivo' and (pay->>'received')::numeric > (pay->>'amount')::numeric then (pay->>'received')::numeric - (pay->>'amount')::numeric end,
        nullif(pay->>'reference', ''), v_user);
    if pay->>'method' <> 'cuenta_por_cobrar' then
      insert into public.cash_movements (org_id, session_id, type, method, amount, order_id, ref, note, user_id)
        values (v_org, v_sid, 'venta', pay->>'method', (pay->>'amount')::numeric, o.id, o.number, 'Cobro del pedido ' || o.number, v_user);
    end if;
    if pay->>'method' = 'efectivo' and (pay->>'received')::numeric > (pay->>'amount')::numeric then
      v_cash_change := v_cash_change + (pay->>'received')::numeric - (pay->>'amount')::numeric;
    end if;
  end loop;

  update public.orders set status = 'cobrado', paid = v_sum, session_id = v_sid, cashier_id = v_user, closed_at = now() where id = o.id;
  update public.order_items set status = 'entregado', delivered_at = coalesce(delivered_at, now()) where order_id = o.id and status in ('pendiente', 'preparando', 'listo');
  update public.table_calls set status = 'atendido', attended_by = v_user, attended_at = now() where table_id = o.table_id and status = 'pendiente';
  return jsonb_build_object('number', o.number, 'total', v_total, 'change', v_cash_change, 'receivable', v_rnum);
end $$;

-- Abono a una cuenta por cobrar. p: {org_id, receivable_id, session_id, user_id, method, amount, reference}
create or replace function public.pay_receivable(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; r record; s record; v_amt numeric := (p->>'amount')::numeric; v_user bigint := (p->>'user_id')::bigint;
begin
  select * into r from public.receivables where id = (p->>'receivable_id')::bigint and org_id = v_org for update;
  if r.id is null then raise exception 'Cuenta por cobrar no encontrada' using errcode = 'P0001'; end if;
  if r.status <> 'pendiente' then raise exception 'La cuenta % ya está %', r.number, r.status using errcode = 'P0001'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Escribe el valor del abono' using errcode = 'P0001'; end if;
  if v_amt > r.amount - r.paid then
    raise exception 'El abono supera el saldo (%)', public.fmt_money(r.amount - r.paid) using errcode = 'P0001';
  end if;
  select * into s from public.cash_sessions where id = (p->>'session_id')::bigint and org_id = v_org;
  if s.id is null or s.status <> 'abierta' then raise exception 'Abre un turno de caja para recibir el abono' using errcode = 'P0001'; end if;
  insert into public.receivable_payments (org_id, receivable_id, session_id, method, amount, reference, user_id)
    values (v_org, r.id, s.id, p->>'method', v_amt, nullif(p->>'reference', ''), v_user);
  insert into public.cash_movements (org_id, session_id, type, method, amount, receivable_id, ref, note, user_id)
    values (v_org, s.id, 'abono', p->>'method', v_amt, r.id, r.number, 'Abono de ' || r.customer_name, v_user);
  update public.receivables set paid = paid + v_amt,
    status = case when paid + v_amt >= amount then 'pagada' else status end,
    paid_at = case when paid + v_amt >= amount then now() else paid_at end where id = r.id;
  return jsonb_build_object('number', r.number, 'balance', r.amount - r.paid - v_amt);
end $$;

-- ---------- Seguridad: solo el backend (clave secreta) accede ----------
alter table public.dining_areas enable row level security;
alter table public.dining_tables enable row level security;
alter table public.cash_registers enable row level security;
alter table public.cash_sessions enable row level security;
alter table public.vaults enable row level security;
alter table public.vault_movements enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_payments enable row level security;
alter table public.receivables enable row level security;
alter table public.receivable_payments enable row level security;
alter table public.cash_movements enable row level security;
alter table public.table_calls enable row level security;
revoke all on public.dining_areas, public.dining_tables, public.cash_registers, public.cash_sessions, public.vaults, public.vault_movements,
  public.orders, public.order_items, public.order_payments, public.receivables, public.receivable_payments, public.cash_movements,
  public.table_calls from anon, authenticated;
revoke execute on function public.sale_warehouse(bigint), public.recalc_order(bigint), public.order_item_stock(), public.order_items_recalc(),
  public.vault_of(bigint, bigint), public.apply_vault_movement(), public.session_cash(bigint), public.open_cash_session(jsonb),
  public.close_cash_session(jsonb), public.charge_order(jsonb), public.pay_receivable(jsonb) from public, anon, authenticated;
grant execute on function public.sale_warehouse(bigint), public.recalc_order(bigint), public.order_item_stock(), public.order_items_recalc(),
  public.vault_of(bigint, bigint), public.apply_vault_movement(), public.session_cash(bigint), public.open_cash_session(jsonb),
  public.close_cash_session(jsonb), public.charge_order(jsonb), public.pay_receivable(jsonb) to service_role;

-- Cada sucursal nueva arranca con una caja; las existentes reciben la suya.
create or replace function public.site_bootstrap() returns trigger
language plpgsql set search_path = '' as $$
begin insert into public.cash_registers (org_id, site_id, name) values (new.org_id, new.id, 'Caja 1'); return new; end $$;
create trigger sites_bootstrap after insert on public.sites for each row execute function public.site_bootstrap();
revoke execute on function public.site_bootstrap() from public, anon, authenticated;
grant execute on function public.site_bootstrap() to service_role;
grant execute on function public.fmt_money(numeric) to service_role;
insert into public.cash_registers (org_id, site_id, name) select org_id, id, 'Caja 1' from public.sites;
