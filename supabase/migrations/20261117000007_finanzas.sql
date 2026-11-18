-- =====================================================================
-- TD-004 · Finanzas
-- · Fondos: el fondo general del negocio (bóveda sin sucursal) y el de cada sucursal.
-- · Ingresos de dinero (ID-): aportes de socios, préstamos, capital u otros, al fondo general o al de una sucursal.
-- · Traslados (TR-) entre el fondo general y las sucursales.
-- · Gastos (EG-) por categoría, pagados desde un fondo, desde la caja abierta, por un socio o por el banco.
-- · Socios con su participación, y retiros o pagos de utilidades (RS-).
-- · La caja solo abre si la base está cubierta: lo que quedó en la caja del turno anterior más el fondo de la sucursal.
-- =====================================================================

-- ---------------------------------------------------------------- Fondo general
alter table public.vaults alter column site_id drop not null;
create unique index if not exists vaults_general_key on public.vaults (org_id) where site_id is null;

create or replace function public.vault_of(p_org bigint, p_site bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v bigint;
begin
  select id into v from public.vaults where org_id = p_org and site_id is not distinct from p_site;
  if v is null then insert into public.vaults (org_id, site_id) values (p_org, p_site) returning id into v; end if;
  return v;
end $$;

create or replace function public.apply_vault_movement() returns trigger
language plpgsql set search_path = '' as $$
declare v_bal numeric; v_site bigint;
begin
  select balance, site_id into v_bal, v_site from public.vaults where id = new.vault_id and org_id = new.org_id for update;
  if v_bal is null then raise exception 'Fondo no encontrado' using errcode = 'P0001'; end if;
  if v_bal + new.amount < 0 then
    raise exception 'El fondo % no tiene suficiente dinero (disponible: %)', case when v_site is null then 'general' else 'de la sucursal' end, public.fmt_money(v_bal) using errcode = 'P0001';
  end if;
  update public.vaults set balance = balance + new.amount where id = new.vault_id returning balance into new.balance_after;
  return new;
end $$;

alter table public.vault_movements drop constraint if exists vault_movements_type_check;
alter table public.vault_movements add constraint vault_movements_type_check check (type in (
  'deposito', 'retiro', 'cierre_caja', 'base_caja', 'consignacion', 'ajuste',
  'ingreso', 'gasto', 'traslado', 'retiro_socio', 'anulacion'));

-- ---------------------------------------------------------------- Socios
create table if not exists public.partners (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  document text,
  phone text,
  email text,
  share_pct numeric(5, 2) not null default 0 check (share_pct between 0 and 100),
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Ingresos de dinero
create table if not exists public.money_entries (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete cascade,        -- null: fondo general
  number text not null,
  kind text not null check (kind in ('aporte_socio', 'capital', 'prestamo', 'otro_ingreso')),
  partner_id bigint references public.partners(id) on delete set null,
  amount numeric(16, 2) not null check (amount > 0),
  method text not null default 'efectivo' check (method in ('efectivo', 'transferencia', 'tarjeta', 'nequi', 'daviplata', 'otro')),
  received_on date not null default (now() at time zone 'America/Bogota')::date,
  description text,
  status text not null default 'activo' check (status in ('activo', 'anulado')),
  void_reason text,
  created_by bigint references public.users(id) on delete set null,
  voided_by bigint references public.users(id) on delete set null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint money_entries_partner_chk check (kind <> 'aporte_socio' or partner_id is not null)
);
create index if not exists money_entries_idx on public.money_entries (org_id, received_on desc);

-- ---------------------------------------------------------------- Traslados entre fondos
create table if not exists public.fund_transfers (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  number text not null,
  from_site_id bigint references public.sites(id) on delete cascade,   -- null: fondo general
  to_site_id bigint references public.sites(id) on delete cascade,
  amount numeric(16, 2) not null check (amount > 0),
  note text,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint fund_transfers_chk check (from_site_id is distinct from to_site_id)
);

-- ---------------------------------------------------------------- Gastos
create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete cascade,        -- null: gasto general del negocio
  number text not null,
  category text not null check (category in ('nomina', 'arriendo', 'servicios', 'compras', 'mantenimiento', 'impuestos', 'marketing', 'transporte', 'bancarios', 'otros')),
  description text not null check (char_length(description) between 3 and 200),
  supplier text,
  invoice_ref text,
  amount numeric(16, 2) not null check (amount > 0),
  paid_on date not null default (now() at time zone 'America/Bogota')::date,
  source text not null check (source in ('fondo', 'caja', 'socio', 'banco')),
  session_id bigint references public.cash_sessions(id) on delete set null,
  partner_id bigint references public.partners(id) on delete set null,
  status text not null default 'activo' check (status in ('activo', 'anulado')),
  void_reason text,
  created_by bigint references public.users(id) on delete set null,
  voided_by bigint references public.users(id) on delete set null,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint expenses_partner_chk check (source <> 'socio' or partner_id is not null)
);
create index if not exists expenses_idx on public.expenses (org_id, paid_on desc);

-- ---------------------------------------------------------------- Retiros y utilidades de socios
create table if not exists public.partner_withdrawals (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete cascade,        -- fondo del que sale; null: general
  number text not null,
  partner_id bigint not null references public.partners(id) on delete restrict,
  kind text not null check (kind in ('utilidad', 'retiro')),
  amount numeric(16, 2) not null check (amount > 0),
  method text not null default 'efectivo' check (method in ('efectivo', 'transferencia', 'nequi', 'daviplata', 'otro')),
  paid_on date not null default (now() at time zone 'America/Bogota')::date,
  note text,
  status text not null default 'activo' check (status in ('activo', 'anulado')),
  void_reason text,
  created_by bigint references public.users(id) on delete set null,
  voided_by bigint references public.users(id) on delete set null,
  voided_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- Funciones
-- p: {org_id, user_id, site_id?, kind, partner_id?, amount, method, received_on?, description}
create or replace function public.finance_entry(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_site bigint := nullif(p->>'site_id', '')::bigint; v_id bigint; v_num text; v_amt numeric := (p->>'amount')::numeric;
begin
  v_num := public.next_consecutive(v_org, 'ingreso_dinero', 0, 'ID-');
  insert into public.money_entries (org_id, site_id, number, kind, partner_id, amount, method, received_on, description, created_by)
    values (v_org, v_site, v_num, p->>'kind', nullif(p->>'partner_id', '')::bigint, v_amt, coalesce(p->>'method', 'efectivo'),
      coalesce(nullif(p->>'received_on', '')::date, (now() at time zone 'America/Bogota')::date), nullif(p->>'description', ''), (p->>'user_id')::bigint)
    returning id into v_id;
  insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
    values (v_org, public.vault_of(v_org, v_site), 'ingreso', v_amt, v_num, coalesce(nullif(p->>'description', ''), 'Ingreso de dinero'), (p->>'user_id')::bigint);
  return v_id;
end $$;

-- p: {org_id, user_id, from_site_id?, to_site_id?, amount, note}
create or replace function public.fund_transfer(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_from bigint := nullif(p->>'from_site_id', '')::bigint; v_to bigint := nullif(p->>'to_site_id', '')::bigint;
  v_id bigint; v_num text; v_amt numeric := (p->>'amount')::numeric;
begin
  if v_from is not distinct from v_to then raise exception 'Elige fondos distintos' using errcode = 'P0001'; end if;
  v_num := public.next_consecutive(v_org, 'traslado_fondo', 0, 'TR-');
  insert into public.fund_transfers (org_id, number, from_site_id, to_site_id, amount, note, created_by)
    values (v_org, v_num, v_from, v_to, v_amt, nullif(p->>'note', ''), (p->>'user_id')::bigint) returning id into v_id;
  insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
    values (v_org, public.vault_of(v_org, v_from), 'traslado', -v_amt, v_num, coalesce(nullif(p->>'note', ''), 'Traslado'), (p->>'user_id')::bigint);
  insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
    values (v_org, public.vault_of(v_org, v_to), 'traslado', v_amt, v_num, coalesce(nullif(p->>'note', ''), 'Traslado'), (p->>'user_id')::bigint);
  return v_id;
end $$;

-- p: {org_id, user_id, site_id?, category, description, supplier, invoice_ref, amount, paid_on?, source, session_id?, partner_id?}
create or replace function public.finance_expense(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_site bigint := nullif(p->>'site_id', '')::bigint; v_src text := p->>'source';
  v_id bigint; v_num text; v_amt numeric := (p->>'amount')::numeric; v_sess bigint; s record;
begin
  if v_src = 'caja' then
    select * into s from public.cash_sessions where id = nullif(p->>'session_id', '')::bigint and org_id = v_org for update;
    if s.id is null or s.status <> 'abierta' then raise exception 'Elige un turno de caja abierto' using errcode = 'P0001'; end if;
    if public.session_cash(s.id) < v_amt then
      raise exception 'No hay suficiente efectivo en la caja (disponible: %)', public.fmt_money(public.session_cash(s.id)) using errcode = 'P0001';
    end if;
    v_site := s.site_id; v_sess := s.id;
  end if;
  v_num := public.next_consecutive(v_org, 'gasto', 0, 'EG-');
  insert into public.expenses (org_id, site_id, number, category, description, supplier, invoice_ref, amount, paid_on, source, session_id, partner_id, created_by)
    values (v_org, v_site, v_num, p->>'category', p->>'description', nullif(p->>'supplier', ''), nullif(p->>'invoice_ref', ''), v_amt,
      coalesce(nullif(p->>'paid_on', '')::date, (now() at time zone 'America/Bogota')::date), v_src, v_sess, nullif(p->>'partner_id', '')::bigint, (p->>'user_id')::bigint)
    returning id into v_id;
  if v_src = 'fondo' then
    insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
      values (v_org, public.vault_of(v_org, v_site), 'gasto', -v_amt, v_num, p->>'description', (p->>'user_id')::bigint);
  elsif v_src = 'caja' then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, v_sess, 'egreso', 'efectivo', -v_amt, v_num, p->>'description', (p->>'user_id')::bigint);
  end if;
  return v_id;
end $$;

-- p: {org_id, user_id, site_id?, partner_id, kind, amount, method, paid_on?, note}
create or replace function public.partner_withdrawal(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_site bigint := nullif(p->>'site_id', '')::bigint; v_id bigint; v_num text; v_amt numeric := (p->>'amount')::numeric;
begin
  v_num := public.next_consecutive(v_org, 'retiro_socio', 0, 'RS-');
  insert into public.partner_withdrawals (org_id, site_id, number, partner_id, kind, amount, method, paid_on, note, created_by)
    values (v_org, v_site, v_num, (p->>'partner_id')::bigint, p->>'kind', v_amt, coalesce(p->>'method', 'efectivo'),
      coalesce(nullif(p->>'paid_on', '')::date, (now() at time zone 'America/Bogota')::date), nullif(p->>'note', ''), (p->>'user_id')::bigint)
    returning id into v_id;
  insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
    values (v_org, public.vault_of(v_org, v_site), 'retiro_socio', -v_amt, v_num, coalesce(nullif(p->>'note', ''), 'Retiro de socio'), (p->>'user_id')::bigint);
  return v_id;
end $$;

-- Anular un ingreso, un gasto o un retiro: devuelve el dinero al fondo (o a la caja si sigue abierta).
-- p: {org_id, user_id, kind: entry|expense|withdrawal, id, reason}
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
        values (v_org, public.vault_of(v_org, r.site_id), 'anulacion', r.amount, r.number, 'Anulación: ' || v_reason, v_user);
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

-- ---------------------------------------------------------------- Apertura de caja con fondos
-- La base sale de lo que quedó en la caja del turno anterior y, si falta, del fondo de la sucursal.
-- Si la base es menor que lo que quedó, la diferencia vuelve al fondo de la sucursal.
create or replace function public.open_cash_session(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; r record; v_id bigint; v_num text; v_amt numeric := coalesce((p->>'opening_amount')::numeric, 0);
  v_carry numeric; v_need numeric; v_bal numeric; v_user bigint := (p->>'user_id')::bigint;
begin
  select * into r from public.cash_registers where id = (p->>'register_id')::bigint and org_id = v_org for update;
  if r.id is null or not r.active then raise exception 'La caja no existe o está inactiva' using errcode = 'P0001'; end if;
  if exists (select 1 from public.cash_sessions where register_id = r.id and status = 'abierta') then
    raise exception 'La caja % ya tiene un turno abierto', r.name using errcode = 'P0001';
  end if;
  if v_amt <= 0 then raise exception 'Escribe la base con la que abre la caja' using errcode = 'P0001'; end if;
  v_carry := coalesce(r.float_amount, 0);
  v_need := v_amt - v_carry;
  if v_need > 0 then
    select balance into v_bal from public.vaults where id = public.vault_of(v_org, r.site_id);
    if coalesce(v_bal, 0) < v_need then
      raise exception 'La sucursal no tiene fondos para esa base: faltan %. Ingresa dinero a la sucursal en Finanzas → Fondos.', public.fmt_money(v_need - coalesce(v_bal, 0)) using errcode = 'P0001';
    end if;
  end if;
  v_num := public.next_consecutive(v_org, 'turno_caja', r.site_id, 'TC-');
  insert into public.cash_sessions (org_id, site_id, register_id, number, opening_amount, opened_by, note)
    values (v_org, r.site_id, r.id, v_num, v_amt, v_user, nullif(p->>'note', '')) returning id into v_id;
  insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
    values (v_org, v_id, 'apertura', 'efectivo', v_amt, v_num, 'Base de la caja', v_user);
  if v_need <> 0 then
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, r.site_id), 'base_caja', -v_need, v_id, v_num,
        case when v_need > 0 then 'Base para ' || r.name else 'Sobrante de la base de ' || r.name end, v_user);
  end if;
  update public.cash_registers set float_amount = 0 where id = r.id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- Permisos
alter table public.partners enable row level security;
alter table public.money_entries enable row level security;
alter table public.fund_transfers enable row level security;
alter table public.expenses enable row level security;
alter table public.partner_withdrawals enable row level security;
revoke all on public.partners, public.money_entries, public.fund_transfers, public.expenses, public.partner_withdrawals from anon, authenticated;
revoke execute on function public.finance_entry(jsonb), public.fund_transfer(jsonb), public.finance_expense(jsonb), public.partner_withdrawal(jsonb),
  public.finance_void(jsonb), public.open_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.finance_entry(jsonb), public.fund_transfer(jsonb), public.finance_expense(jsonb), public.partner_withdrawal(jsonb),
  public.finance_void(jsonb), public.open_cash_session(jsonb) to service_role;
