-- =====================================================================
-- TD-004 · Carta, opciones del QR y subcuentas de dinero
-- · Opciones del QR independientes: llamar al mesero, pedir la cuenta, pedir con confirmación y pedir
--   directo (si ambas formas de pedir están activas, las categorías elegidas van directo y el resto se confirma).
-- · menus: cartas que arma el administrador (secciones, destacados, horario, sucursales y presentación).
--   El QR muestra la carta activa de la sucursal en ese momento.
-- · Subcuentas: bolsas de dinero dentro del fondo general o de una sucursal (caja menor, servicios…).
--   El superadmin las crea y traslada dinero entre la cuenta principal y cada subcuenta.
-- =====================================================================

-- ---------------------------------------------------------------- Opciones del QR
alter table public.app_settings add column if not exists qr_call_waiter boolean not null default true;
alter table public.app_settings add column if not exists qr_request_bill boolean not null default true;
alter table public.app_settings add column if not exists qr_order_confirm boolean not null default false;
alter table public.app_settings add column if not exists qr_order_direct boolean not null default false;
alter table public.app_settings add column if not exists qr_direct_categories bigint[] not null default '{}';
update public.app_settings set qr_order_confirm = true where qr_ordering = 'confirmar' and not qr_order_confirm and not qr_order_direct;
update public.app_settings set qr_order_direct = true where qr_ordering = 'directo' and not qr_order_confirm and not qr_order_direct;

-- ---------------------------------------------------------------- Cartas
create table if not exists public.menus (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  title text,
  welcome text,
  cover_url text,
  layout text not null default 'lista' check (layout in ('lista', 'cuadricula')),
  show_photos boolean not null default true,
  show_descriptions boolean not null default true,
  sold_out text not null default 'marcar' check (sold_out in ('marcar', 'ocultar')),
  footer_note text,
  site_ids bigint[] not null default '{}',          -- vacío: todas las sucursales
  days smallint[] not null default '{0,1,2,3,4,5,6}', -- 0 domingo … 6 sábado
  time_from time,
  time_to time,                                      -- si time_to < time_from, la carta pasa la medianoche
  category_ids bigint[] not null default '{}',       -- secciones en orden; vacío: todas las de la carta
  featured_ids bigint[] not null default '{}',
  hidden_product_ids bigint[] not null default '{}',
  active boolean not null default true,
  sort_order int not null default 0,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists menus_org_idx on public.menus (org_id, active, sort_order);
alter table public.menus enable row level security;
revoke all on public.menus from anon, authenticated;

-- ---------------------------------------------------------------- Subcuentas
alter table public.vaults add column if not exists kind text not null default 'principal';
alter table public.vaults drop constraint if exists vaults_kind_check;
alter table public.vaults add constraint vaults_kind_check check (kind in ('principal', 'subcuenta'));
alter table public.vaults add column if not exists name text;
alter table public.vaults add column if not exists purpose text;
alter table public.vaults add column if not exists active boolean not null default true;
-- Servicios que se pagan desde la subcuenta (luz, mantenimiento de aires, publicidad…), con su categoría de gasto.
alter table public.vaults add column if not exists services jsonb not null default '[]';
alter table public.vaults add column if not exists created_at timestamptz not null default now();
alter table public.vaults drop constraint if exists vaults_site_key;
drop index if exists public.vaults_general_key;
create unique index if not exists vaults_principal_site_key on public.vaults (site_id) where kind = 'principal' and site_id is not null;
create unique index if not exists vaults_principal_general_key on public.vaults (org_id) where kind = 'principal' and site_id is null;
create unique index if not exists vaults_sub_name_key on public.vaults (org_id, coalesce(site_id, 0), lower(name)) where kind = 'subcuenta';
alter table public.vaults drop constraint if exists vaults_sub_name_check;
alter table public.vaults add constraint vaults_sub_name_check check (kind = 'principal' or char_length(coalesce(name, '')) between 2 and 60);

create or replace function public.vault_of(p_org bigint, p_site bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  select id into v from public.vaults where org_id = p_org and site_id is not distinct from p_site and kind = 'principal';
  if v is null then insert into public.vaults (org_id, site_id) values (p_org, p_site) returning id into v; end if;
  return v;
end $$;

create or replace function public.apply_vault_movement() returns trigger
language plpgsql set search_path = '' as $$
declare v record;
begin
  select balance, site_id, kind, name into v from public.vaults where id = new.vault_id and org_id = new.org_id for update;
  if v.balance is null then raise exception 'Fondo no encontrado' using errcode = 'P0001'; end if;
  if v.balance + new.amount < 0 then
    raise exception '% no tiene suficiente dinero (disponible: %)',
      case when v.kind = 'subcuenta' then 'La subcuenta ' || v.name when v.site_id is null then 'El fondo general' else 'El fondo de la sucursal' end,
      public.fmt_money(v.balance) using errcode = 'P0001';
  end if;
  update public.vaults set balance = balance + new.amount where id = new.vault_id returning balance into new.balance_after;
  return new;
end $$;

-- Traslados entre cualquier par de cuentas (principal o subcuenta, de cualquier sucursal).
alter table public.fund_transfers add column if not exists from_vault_id bigint references public.vaults(id) on delete set null;
alter table public.fund_transfers add column if not exists to_vault_id bigint references public.vaults(id) on delete set null;
alter table public.fund_transfers drop constraint if exists fund_transfers_chk;
alter table public.fund_transfers add constraint fund_transfers_chk check (from_vault_id is distinct from to_vault_id or from_site_id is distinct from to_site_id);

-- p: {org_id, user_id, from_vault_id, to_vault_id, amount, note}
create or replace function public.vault_transfer(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_user bigint := (p->>'user_id')::bigint;
  a record; b record; v_id bigint; v_num text; v_amt numeric := (p->>'amount')::numeric; v_note text;
begin
  select * into a from public.vaults where id = (p->>'from_vault_id')::bigint and org_id = v_org;
  select * into b from public.vaults where id = (p->>'to_vault_id')::bigint and org_id = v_org;
  if a.id is null or b.id is null then raise exception 'Cuenta no encontrada' using errcode = 'P0001'; end if;
  if a.id = b.id then raise exception 'Elige cuentas distintas' using errcode = 'P0001'; end if;
  if not b.active then raise exception 'La subcuenta % está inactiva', b.name using errcode = 'P0001'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Escribe un valor mayor que cero' using errcode = 'P0001'; end if;
  v_num := public.next_consecutive(v_org, 'traslado_fondo', 0, 'TR-');
  v_note := coalesce(nullif(p->>'note', ''), 'Traslado');
  insert into public.fund_transfers (org_id, number, from_site_id, to_site_id, from_vault_id, to_vault_id, amount, note, created_by)
    values (v_org, v_num, a.site_id, b.site_id, a.id, b.id, v_amt, nullif(p->>'note', ''), v_user) returning id into v_id;
  insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
    values (v_org, a.id, 'traslado', -v_amt, v_num, v_note, v_user);
  insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
    values (v_org, b.id, 'traslado', v_amt, v_num, v_note, v_user);
  return v_id;
end $$;

-- Gastos pagados desde una subcuenta.
alter table public.expenses add column if not exists vault_id bigint references public.vaults(id) on delete set null;

-- p: {org_id, user_id, site_id?, vault_id?, category, description, supplier, invoice_ref, amount, paid_on?, source, session_id?, partner_id?}
create or replace function public.finance_expense(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_site bigint := nullif(p->>'site_id', '')::bigint; v_src text := p->>'source';
  v_id bigint; v_num text; v_amt numeric := (p->>'amount')::numeric; v_sess bigint; s record; v_vault bigint := nullif(p->>'vault_id', '')::bigint; vr record;
begin
  if v_src = 'caja' then
    select * into s from public.cash_sessions where id = nullif(p->>'session_id', '')::bigint and org_id = v_org for update;
    if s.id is null or s.status <> 'abierta' then raise exception 'Elige un turno de caja abierto' using errcode = 'P0001'; end if;
    if public.session_cash(s.id) < v_amt then
      raise exception 'No hay suficiente efectivo en la caja (disponible: %)', public.fmt_money(public.session_cash(s.id)) using errcode = 'P0001';
    end if;
    v_site := s.site_id; v_sess := s.id; v_vault := null;
  elsif v_src = 'fondo' then
    if v_vault is not null then
      select * into vr from public.vaults where id = v_vault and org_id = v_org;
      if vr.id is null then raise exception 'Cuenta no encontrada' using errcode = 'P0001'; end if;
      v_site := vr.site_id;
    else
      v_vault := public.vault_of(v_org, v_site);
    end if;
  else
    v_vault := null;
  end if;
  v_num := public.next_consecutive(v_org, 'gasto', 0, 'EG-');
  insert into public.expenses (org_id, site_id, number, category, description, supplier, invoice_ref, amount, paid_on, source, session_id, partner_id, vault_id, created_by)
    values (v_org, v_site, v_num, p->>'category', p->>'description', nullif(p->>'supplier', ''), nullif(p->>'invoice_ref', ''), v_amt,
      coalesce(nullif(p->>'paid_on', '')::date, (now() at time zone 'America/Bogota')::date), v_src, v_sess, nullif(p->>'partner_id', '')::bigint, v_vault, (p->>'user_id')::bigint)
    returning id into v_id;
  if v_src = 'fondo' then
    insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
      values (v_org, v_vault, 'gasto', -v_amt, v_num, p->>'description', (p->>'user_id')::bigint);
  elsif v_src = 'caja' then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, v_sess, 'egreso', 'efectivo', -v_amt, v_num, p->>'description', (p->>'user_id')::bigint);
  end if;
  return v_id;
end $$;

-- Anular: un gasto pagado desde una subcuenta devuelve el dinero a esa subcuenta.
create or replace function public.finance_void(p jsonb) returns void
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_user bigint := (p->>'user_id')::bigint; v_id bigint := (p->>'id')::bigint;
  v_reason text := nullif(p->>'reason', ''); r record;
begin
  if v_reason is null then raise exception 'Escribe el motivo de la anulación' using errcode = 'P0001'; end if;
  if p->>'kind' = 'entry' then
    select * into r from public.money_entries where id = v_id and org_id = v_org for update;
    if r.id is null or r.status <> 'activo' then raise exception 'El ingreso no existe o ya está anulado' using errcode = 'P0001'; end if;
    insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
      values (v_org, public.vault_of(v_org, r.site_id), 'anulacion', -r.amount, r.number, 'Anulación: ' || v_reason, v_user);
    update public.money_entries set status = 'anulado', void_reason = v_reason, voided_by = v_user, voided_at = now() where id = r.id;
  elsif p->>'kind' = 'expense' then
    select * into r from public.expenses where id = v_id and org_id = v_org for update;
    if r.id is null or r.status <> 'activo' then raise exception 'El gasto no existe o ya está anulado' using errcode = 'P0001'; end if;
    if r.source = 'fondo' then
      insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
        values (v_org, coalesce(r.vault_id, public.vault_of(v_org, r.site_id)), 'anulacion', r.amount, r.number, 'Anulación: ' || v_reason, v_user);
    elsif r.source = 'caja' then
      if exists (select 1 from public.cash_sessions where id = r.session_id and status = 'abierta') then
        insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
          values (v_org, r.session_id, 'ingreso', 'efectivo', r.amount, r.number, 'Anulación: ' || v_reason, v_user);
      else
        insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
          values (v_org, public.vault_of(v_org, r.site_id), 'anulacion', r.amount, r.number, 'Anulación: ' || v_reason, v_user);
      end if;
    end if;
    update public.expenses set status = 'anulado', void_reason = v_reason, voided_by = v_user, voided_at = now() where id = r.id;
  elsif p->>'kind' = 'withdrawal' then
    select * into r from public.partner_withdrawals where id = v_id and org_id = v_org for update;
    if r.id is null or r.status <> 'activo' then raise exception 'El retiro no existe o ya está anulado' using errcode = 'P0001'; end if;
    insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
      values (v_org, public.vault_of(v_org, r.site_id), 'anulacion', r.amount, r.number, 'Anulación: ' || v_reason, v_user);
    update public.partner_withdrawals set status = 'anulado', void_reason = v_reason, voided_by = v_user, voided_at = now() where id = r.id;
  else
    raise exception 'Tipo de documento no válido' using errcode = 'P0001';
  end if;
end $$;

revoke execute on function public.vault_transfer(jsonb) from public, anon, authenticated;
grant execute on function public.vault_transfer(jsonb) to service_role;

-- Con ambas formas de pedir, una mesa puede tener a la vez un pedido por confirmar y un aviso de pedido directo.
drop index if exists public.table_calls_pending_idx;
create unique index if not exists table_calls_pending_idx on public.table_calls (table_id, kind, (order_id is null)) where status = 'pendiente';

-- ---------------------------------------------------------------- Calificación del servicio
-- El cliente califica desde el QR de su mesa (1 a 5 estrellas). Se atribuye al mesero del pedido.
create table if not exists public.service_ratings (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete set null,
  table_id bigint references public.dining_tables(id) on delete set null,
  order_id bigint not null references public.orders(id) on delete cascade,
  waiter_id bigint references public.users(id) on delete set null,
  stars smallint not null check (stars between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_ratings_order_key unique (order_id)
);
create index if not exists service_ratings_waiter_idx on public.service_ratings (org_id, waiter_id, created_at desc);
alter table public.service_ratings enable row level security;
revoke all on public.service_ratings from anon, authenticated;
