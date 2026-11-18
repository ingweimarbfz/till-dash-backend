-- =====================================================================
-- TD-003: cierre de turno completo e incidentes.
-- · Al cerrar: propinas repartidas por empleado (salen del efectivo), base que queda en la caja
--   para el próximo turno y el resto pasa a la bóveda. Observación del cierre.
-- · Incidentes: platos rotos, daños, faltantes, accidentes… con costo y responsable.
-- =====================================================================

-- Base que queda guardada en la caja para el siguiente turno.
alter table public.cash_registers add column if not exists float_amount numeric(14, 2) not null default 0 check (float_amount >= 0);
alter table public.cash_sessions add column if not exists tips_paid numeric(14, 2) not null default 0;
alter table public.cash_sessions add column if not exists next_float numeric(14, 2) not null default 0;

create table if not exists public.tip_payouts (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  paid_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists tip_payouts_session_idx on public.tip_payouts (session_id);
create index if not exists tip_payouts_user_idx on public.tip_payouts (org_id, user_id, created_at desc);

-- Al abrir un turno, la base guardada en la caja se usa y la caja queda en cero.
create or replace function public.open_cash_session(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; r record; v_id bigint; v_num text; v_amt numeric := coalesce((p->>'opening_amount')::numeric, 0);
begin
  select * into r from public.cash_registers where id = (p->>'register_id')::bigint and org_id = v_org for update;
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
  update public.cash_registers set float_amount = 0 where id = r.id;
  return v_id;
end $$;

-- Cerrar un turno. p: {org_id, session_id, user_id, counted_cash, next_float, tips: [{user_id, amount}], note}
-- Efectivo contado = propinas pagadas + base para mañana + lo que pasa a la bóveda.
create or replace function public.close_cash_session(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; s record; v_exp numeric; v_cnt numeric := (p->>'counted_cash')::numeric;
  v_float numeric := coalesce((p->>'next_float')::numeric, 0); v_user bigint := (p->>'user_id')::bigint;
  v_tips numeric := 0; v_vault numeric; t jsonb; v_emp record;
begin
  select * into s from public.cash_sessions where id = (p->>'session_id')::bigint and org_id = v_org for update;
  if s.id is null then raise exception 'Turno no encontrado' using errcode = 'P0001'; end if;
  if s.status <> 'abierta' then raise exception 'El turno % ya está cerrado', s.number using errcode = 'P0001'; end if;
  if v_cnt is null or v_cnt < 0 then raise exception 'Escribe el efectivo contado' using errcode = 'P0001'; end if;
  if v_float < 0 then raise exception 'La base para mañana no puede ser negativa' using errcode = 'P0001'; end if;
  v_exp := public.session_cash(s.id);

  for t in select * from jsonb_array_elements(coalesce(p->'tips', '[]'::jsonb)) loop
    continue when coalesce((t->>'amount')::numeric, 0) <= 0;
    select id, name, last_name into v_emp from public.users where id = (t->>'user_id')::bigint and org_id = v_org and active;
    if v_emp.id is null then raise exception 'Uno de los empleados de la propina no existe o está inactivo' using errcode = 'P0001'; end if;
    insert into public.tip_payouts (org_id, session_id, user_id, amount, paid_by) values (v_org, s.id, v_emp.id, (t->>'amount')::numeric, v_user);
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, s.id, 'propina_pagada', 'efectivo', -(t->>'amount')::numeric, s.number,
              'Propina para ' || trim(v_emp.name || ' ' || coalesce(v_emp.last_name, '')), v_user);
    v_tips := v_tips + (t->>'amount')::numeric;
  end loop;

  v_vault := v_cnt - v_tips - v_float;
  if v_vault < 0 then
    raise exception 'Con % de efectivo no alcanza para % de propinas y % de base', public.fmt_money(v_cnt), public.fmt_money(v_tips), public.fmt_money(v_float) using errcode = 'P0001';
  end if;
  if v_vault > 0 then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, s.id, 'a_boveda', 'efectivo', -v_vault, s.number, 'Cierre: pasa a la bóveda', v_user);
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, s.site_id), 'cierre_caja', v_vault, s.id, s.number, 'Cierre del turno ' || s.number, v_user);
  end if;
  update public.cash_registers set float_amount = v_float where id = s.register_id;
  update public.cash_sessions set status = 'cerrada', expected_cash = v_exp, counted_cash = v_cnt, difference = v_cnt - v_exp,
    tips_paid = v_tips, next_float = v_float, to_vault = v_vault, closed_by = v_user, closed_at = now(), close_note = nullif(p->>'note', '')
    where id = s.id;
  return jsonb_build_object('number', s.number, 'expected', v_exp, 'counted', v_cnt, 'difference', v_cnt - v_exp,
    'tipsPaid', v_tips, 'nextFloat', v_float, 'toVault', v_vault);
end $$;

-- ---------------------------------------------------------------- Incidentes
create table if not exists public.incidents (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  number text not null,
  type text not null check (type in ('rotura', 'dano', 'faltante', 'accidente', 'queja', 'otro')),
  title text not null check (char_length(title) between 3 and 120),
  description text,
  cost numeric(14, 2) not null default 0 check (cost >= 0),
  quantity numeric(12, 3),
  product_id bigint references public.products(id) on delete set null,
  responsible_id bigint references public.users(id) on delete set null,
  charge_to_responsible boolean not null default false,
  status text not null default 'abierto' check (status in ('abierto', 'resuelto', 'descartado')),
  resolution text,
  occurred_at timestamptz not null default now(),
  reported_by bigint references public.users(id) on delete set null,
  resolved_by bigint references public.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists incidents_site_idx on public.incidents (org_id, site_id, occurred_at desc);
create index if not exists incidents_status_idx on public.incidents (org_id, status);

alter table public.tip_payouts enable row level security;
alter table public.incidents enable row level security;
revoke all on public.tip_payouts, public.incidents from anon, authenticated;
revoke execute on function public.open_cash_session(jsonb), public.close_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.open_cash_session(jsonb), public.close_cash_session(jsonb) to service_role;
