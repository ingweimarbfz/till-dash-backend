-- TD-020 (2) · Pagos al personal: por turno o por nómina, configurado por empleado.
-- · Cada empleado tiene su forma de pago (users.pay_mode):
--     'turno'   → se le paga cada turno trabajado: horas × valor de la hora (users.hour_rate).
--     'nomina'  → se le paga el salario (users.salary) al final de la quincena o del mes (users.pay_period).
--     'ninguno' → no se le paga desde TillDash+ (dueños, socios…).
-- · Al cerrar el turno se pregunta a cada domiciliario (su parte de los domicilios, sin propinas) y a
--   cada empleado por turno si recibe el pago ahora. Si no, queda pendiente en Pagos al personal.
-- · Lo que se le debe o se le pagó a cada uno queda en staff_earnings (turno, domicilios, nómina).
-- · El pago de turnos y nómina es un gasto del negocio (categoría Nómina). La parte del domiciliario no:
--   es el valor del domicilio que el cliente pagó para él.

alter table public.users add column if not exists pay_mode text not null default 'ninguno';
alter table public.users drop constraint if exists users_pay_mode_chk;
alter table public.users add constraint users_pay_mode_chk check (pay_mode in ('ninguno', 'turno', 'nomina'));
alter table public.users add column if not exists hour_rate numeric(14, 2) not null default 0 check (hour_rate >= 0);
alter table public.users add column if not exists salary numeric(14, 2) not null default 0 check (salary >= 0);
alter table public.users add column if not exists pay_period text not null default 'mensual';
alter table public.users drop constraint if exists users_pay_period_chk;
alter table public.users add constraint users_pay_period_chk check (pay_period in ('quincenal', 'mensual'));

alter table public.cash_sessions add column if not exists staff_paid numeric(14, 2) not null default 0;

create table if not exists public.staff_earnings (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete set null,
  user_id bigint not null references public.users(id) on delete restrict,
  kind text not null check (kind in ('turno', 'domicilios', 'nomina')),
  session_id bigint references public.cash_sessions(id) on delete set null,   -- turno trabajado
  hours numeric(6, 2),
  rate numeric(14, 2),
  deliveries int,
  period_from date,
  period_to date,
  amount numeric(14, 2) not null check (amount > 0),
  note text,
  status text not null default 'pendiente' check (status in ('pendiente', 'pagado')),
  paid_at timestamptz,
  paid_by bigint references public.users(id) on delete set null,
  paid_source text check (paid_source in ('cierre', 'caja', 'fondo', 'transferencia')),
  paid_method text,
  paid_number text,
  paid_session_id bigint references public.cash_sessions(id) on delete set null,
  expense_id bigint references public.expenses(id) on delete set null,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists staff_earnings_site_idx on public.staff_earnings (org_id, site_id, status, created_at desc);
create index if not exists staff_earnings_user_idx on public.staff_earnings (user_id, kind, created_at desc);
create index if not exists staff_earnings_session_idx on public.staff_earnings (session_id);
create unique index if not exists staff_earnings_payroll_uniq on public.staff_earnings (user_id, period_from) where kind = 'nomina';
alter table public.staff_earnings enable row level security;
revoke all on public.staff_earnings from anon, authenticated;

-- 'pago_turno': pago de turnos en el cierre (se anula al reabrir). 'pago_personal': domicilios pagados
-- después desde Pagos al personal (no se anula al reabrir).
alter table public.cash_movements drop constraint if exists cash_movements_type_check;
alter table public.cash_movements add constraint cash_movements_type_check
  check (type in ('apertura', 'venta', 'abono', 'ingreso', 'egreso', 'a_boveda', 'propina_pagada', 'domicilio_pagado', 'base_domiciliario', 'retorno_domiciliario', 'pago_propina', 'pago_turno', 'pago_personal'));
alter table public.vault_movements drop constraint if exists vault_movements_type_check;
alter table public.vault_movements add constraint vault_movements_type_check check (type in (
  'deposito', 'retiro', 'cierre_caja', 'base_caja', 'consignacion', 'ajuste',
  'ingreso', 'gasto', 'traslado', 'retiro_socio', 'anulacion', 'pago_propina', 'pago_personal'));

-- Cierre de caja. Además de lo anterior:
-- · couriers: [{user_id, amount, deliveries, fees, share, tips, pay_now}] → pay_now = false deja su parte pendiente.
-- · staff: [{user_id, hours, rate, amount, pay_now}] → turnos trabajados; pay_now = true se paga del efectivo.
create or replace function public.close_cash_session(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; s record; v_exp numeric; v_cnt numeric := (p->>'counted_cash')::numeric;
  v_float numeric := coalesce((p->>'next_float')::numeric, 0); v_user bigint := (p->>'user_id')::bigint;
  v_tips numeric := 0; v_cour numeric := 0; v_staff numeric := 0; v_vault numeric; t jsonb; v_emp record; v_amt numeric;
  v_now boolean; v_num text; v_exp_id bigint; v_name text;
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

  for t in select * from jsonb_array_elements(coalesce(p->'couriers', '[]'::jsonb)) loop
    v_amt := coalesce((t->>'amount')::numeric, 0);
    continue when v_amt <= 0;
    select id, name, last_name into v_emp from public.users where id = (t->>'user_id')::bigint and org_id = v_org;
    if v_emp.id is null then raise exception 'Uno de los domiciliarios no existe' using errcode = 'P0001'; end if;
    if coalesce((t->>'pay_now')::boolean, true) then
      insert into public.courier_payouts (org_id, session_id, user_id, deliveries, fees, share, tips, amount, paid_by)
        values (v_org, s.id, v_emp.id, coalesce((t->>'deliveries')::int, 0), coalesce((t->>'fees')::numeric, 0), coalesce((t->>'share')::numeric, 0),
                coalesce((t->>'tips')::numeric, 0), v_amt, v_user);
      insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
        values (v_org, s.id, 'domicilio_pagado', 'efectivo', -v_amt, s.number,
                'Domicilios para ' || trim(v_emp.name || ' ' || coalesce(v_emp.last_name, '')), v_user);
      v_cour := v_cour + v_amt;
    else
      insert into public.staff_earnings (org_id, site_id, user_id, kind, session_id, deliveries, amount, note, created_by)
        values (v_org, s.site_id, v_emp.id, 'domicilios', s.id, coalesce((t->>'deliveries')::int, 0), v_amt, 'Domicilios del turno ' || s.number, v_user);
    end if;
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p->'staff', '[]'::jsonb)) loop
    v_amt := round(coalesce((t->>'amount')::numeric, 0));
    continue when v_amt <= 0;
    select id, name, last_name into v_emp from public.users where id = (t->>'user_id')::bigint and org_id = v_org;
    if v_emp.id is null then raise exception 'Uno de los empleados del turno no existe' using errcode = 'P0001'; end if;
    v_name := trim(v_emp.name || ' ' || coalesce(v_emp.last_name, ''));
    v_now := coalesce((t->>'pay_now')::boolean, true);
    v_exp_id := null; v_num := null;
    if v_now then
      v_num := public.next_consecutive(v_org, 'gasto', 0, 'EG-');
      insert into public.expenses (org_id, site_id, number, category, description, amount, source, session_id, created_by)
        values (v_org, s.site_id, v_num, 'nomina', left('Turno ' || s.number || ' · ' || v_name || coalesce(' (' || nullif(t->>'hours', '') || ' h)', ''), 200), v_amt, 'caja', s.id, v_user)
        returning id into v_exp_id;
      insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
        values (v_org, s.id, 'pago_turno', 'efectivo', -v_amt, v_num, 'Turno para ' || v_name, v_user);
      v_staff := v_staff + v_amt;
    end if;
    insert into public.staff_earnings (org_id, site_id, user_id, kind, session_id, hours, rate, amount, note, created_by,
        status, paid_at, paid_by, paid_source, paid_method, paid_number, paid_session_id, expense_id)
      values (v_org, s.site_id, v_emp.id, 'turno', s.id, nullif(t->>'hours', '')::numeric, nullif(t->>'rate', '')::numeric, v_amt, 'Turno ' || s.number, v_user,
        case when v_now then 'pagado' else 'pendiente' end, case when v_now then now() end, case when v_now then v_user end,
        case when v_now then 'cierre' end, case when v_now then 'efectivo' end, v_num, case when v_now then s.id end, v_exp_id);
  end loop;

  v_vault := v_cnt - v_tips - v_cour - v_staff - v_float;
  if v_vault < 0 then
    raise exception 'Con % de efectivo no alcanza para % de domiciliarios, % de turnos y % de base', public.fmt_money(v_cnt), public.fmt_money(v_cour), public.fmt_money(v_staff), public.fmt_money(v_float) using errcode = 'P0001';
  end if;
  if v_vault > 0 then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, s.id, 'a_boveda', 'efectivo', -v_vault, s.number, 'Cierre: pasa a la bóveda', v_user);
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, s.site_id), 'cierre_caja', v_vault, s.id, s.number, 'Cierre del turno ' || s.number, v_user);
  end if;
  update public.cash_registers set float_amount = v_float where id = s.register_id;
  update public.cash_sessions set status = 'cerrada', expected_cash = v_exp, counted_cash = v_cnt, difference = v_cnt - v_exp,
    tips_paid = v_tips, couriers_paid = v_cour, staff_paid = v_staff, next_float = v_float, to_vault = v_vault, closed_by = v_user, closed_at = now(), close_note = nullif(p->>'note', '')
    where id = s.id;
  return jsonb_build_object('number', s.number, 'expected', v_exp, 'counted', v_cnt, 'difference', v_cnt - v_exp,
    'tipsPaid', v_tips, 'couriersPaid', v_cour, 'staffPaid', v_staff, 'nextFloat', v_float, 'toVault', v_vault);
end $$;
revoke execute on function public.close_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.close_cash_session(jsonb) to service_role;

-- Reabrir: además se anula lo que el cierre registró al personal (turnos pagados o pendientes y domicilios
-- pendientes). Si algo de ese turno ya se pagó después en Pagos al personal, no se puede reabrir.
create or replace function public.reopen_cash_session(p jsonb)
returns jsonb
language plpgsql
set search_path to ''
as $function$
declare v_org bigint := (p->>'org_id')::bigint; v_user bigint := (p->>'user_id')::bigint;
  r record; s record; v_hours int; v_bal numeric; v_snap jsonb;
begin
  select * into r from public.cash_reopen_requests where id = (p->>'request_id')::bigint and org_id = v_org for update;
  if r.id is null then raise exception 'Solicitud no encontrada' using errcode = 'P0001'; end if;
  if r.status <> 'pendiente' then raise exception 'La solicitud ya fue %', r.status using errcode = 'P0001'; end if;
  select * into s from public.cash_sessions where id = r.session_id and org_id = v_org for update;
  if s.id is null then raise exception 'Turno no encontrado' using errcode = 'P0001'; end if;
  if s.status <> 'cerrada' then raise exception 'El turno % ya está abierto', s.number using errcode = 'P0001'; end if;
  select coalesce(cash_reopen_hours, 12) into v_hours from public.app_settings where org_id = v_org;
  v_hours := coalesce(v_hours, 12);
  if v_hours <= 0 then raise exception 'La reapertura de turnos está desactivada en Configuración' using errcode = 'P0001'; end if;
  if s.closed_at < now() - make_interval(hours => v_hours) then
    raise exception 'Pasaron más de % horas desde el cierre del turno %. Ya no se puede reabrir.', v_hours, s.number using errcode = 'P0001';
  end if;
  if exists (select 1 from public.cash_sessions where register_id = s.register_id and id <> s.id and (status = 'abierta' or opened_at > s.closed_at)) then
    raise exception 'Ya se abrió un turno nuevo en esta caja. El turno % no se puede reabrir.', s.number using errcode = 'P0001';
  end if;
  if exists (select 1 from public.staff_earnings where session_id = s.id and status = 'pagado' and paid_source <> 'cierre') then
    raise exception 'Lo pendiente al personal de este turno ya se pagó en Pagos al personal. El turno % no se puede reabrir.', s.number using errcode = 'P0001';
  end if;
  if coalesce(s.to_vault, 0) > 0 then
    select balance into v_bal from public.vaults where id = public.vault_of(v_org, s.site_id);
    if coalesce(v_bal, 0) < s.to_vault then
      raise exception 'El fondo de la sucursal ya no tiene los % que entraron con el cierre (disponible: %).', public.fmt_money(s.to_vault), public.fmt_money(coalesce(v_bal, 0)) using errcode = 'P0001';
    end if;
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, s.site_id), 'anulacion', -s.to_vault, s.id, s.number, 'Reapertura del turno ' || s.number, v_user);
  end if;
  v_snap := jsonb_build_object('expected', s.expected_cash, 'counted', s.counted_cash, 'difference', s.difference, 'tipsPaid', s.tips_paid, 'couriersPaid', s.couriers_paid,
    'staffPaid', s.staff_paid, 'nextFloat', s.next_float, 'toVault', s.to_vault, 'closedAt', s.closed_at, 'closedBy', s.closed_by, 'closeNote', s.close_note);
  -- El efectivo vuelve al turno: se quitan la salida a la bóveda, las propinas, domicilios y turnos pagados en el cierre y la base que quedaba en la caja.
  delete from public.cash_movements where session_id = s.id and type in ('a_boveda', 'propina_pagada', 'domicilio_pagado', 'pago_turno');
  delete from public.courier_payouts where session_id = s.id;
  delete from public.tip_payouts where session_id = s.id and source = 'cierre';
  delete from public.expenses where id in (select expense_id from public.staff_earnings where session_id = s.id and paid_source = 'cierre' and expense_id is not null);
  delete from public.staff_earnings where session_id = s.id;
  update public.cash_registers set float_amount = 0 where id = s.register_id;
  update public.cash_sessions set status = 'abierta', expected_cash = null, counted_cash = null, difference = null, tips_paid = 0, couriers_paid = 0, staff_paid = 0,
    next_float = 0, to_vault = 0, closed_by = null, closed_at = null, reopen_count = reopen_count + 1, reopened_at = now()
    where id = s.id;
  update public.cash_reopen_requests set status = 'aprobada', resolved_by = v_user, resolved_at = now(),
    resolution = nullif(p->>'note', ''), snapshot = v_snap where id = r.id;
  return jsonb_build_object('number', s.number, 'sessionId', s.id, 'snapshot', v_snap);
end $function$;
revoke execute on function public.reopen_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.reopen_cash_session(jsonb) to service_role;

-- Pagar al personal desde Pagos al personal.
-- p: {org_id, user_id, site_id, source: caja|fondo|transferencia, session_id, method, note,
--     earnings: [id…] (turnos y domicilios pendientes), payroll: [{user_id, amount, period_from, period_to}]}
create or replace function public.pay_staff(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_user bigint := (p->>'user_id')::bigint; v_site bigint := (p->>'site_id')::bigint;
  v_src text := p->>'source'; v_method text := coalesce(nullif(p->>'method', ''), 'efectivo'); v_note text := nullif(trim(coalesce(p->>'note', '')), '');
  s record; e record; t jsonb; v_num text; v_total numeric := 0; v_count int := 0; v_exp_id bigint; v_name text; v_vault bigint;
  v_amt numeric; v_from date; v_to date; v_emp record; v_esrc text; v_sid bigint;
begin
  if v_src not in ('caja', 'fondo', 'transferencia') then raise exception 'Elige de dónde sale el dinero' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.sites where id = v_site and org_id = v_org) then raise exception 'Sucursal no encontrada' using errcode = 'P0001'; end if;
  if v_src = 'transferencia' and v_method not in ('transferencia', 'nequi', 'daviplata') then raise exception 'Elige el medio de la transferencia' using errcode = 'P0001'; end if;
  if v_src <> 'transferencia' then v_method := 'efectivo'; end if;
  v_esrc := case v_src when 'transferencia' then 'banco' else v_src end;

  -- Total para revisar el efectivo de una vez.
  select coalesce(sum(amount), 0), count(*) into v_total, v_count from public.staff_earnings
    where id in (select (x)::bigint from jsonb_array_elements_text(coalesce(p->'earnings', '[]'::jsonb)) x) and org_id = v_org;
  if v_count <> jsonb_array_length(coalesce(p->'earnings', '[]'::jsonb)) then raise exception 'Uno de los pagos pendientes no existe' using errcode = 'P0001'; end if;
  for t in select * from jsonb_array_elements(coalesce(p->'payroll', '[]'::jsonb)) loop
    if coalesce((t->>'amount')::numeric, 0) <= 0 then raise exception 'Escribe el valor de la nómina' using errcode = 'P0001'; end if;
    v_total := v_total + (t->>'amount')::numeric; v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'Elige qué se va a pagar' using errcode = 'P0001'; end if;

  if v_src = 'caja' then
    select * into s from public.cash_sessions where id = (p->>'session_id')::bigint and org_id = v_org for update;
    if s.id is null or s.status <> 'abierta' then raise exception 'Elige un turno de caja abierto' using errcode = 'P0001'; end if;
    if s.site_id <> v_site then raise exception 'El turno es de otra sucursal' using errcode = 'P0001'; end if;
    v_sid := s.id;
    if public.session_cash(s.id) < v_total then
      raise exception 'En la caja hay % de efectivo y el pago es de %', public.fmt_money(public.session_cash(s.id)), public.fmt_money(v_total) using errcode = 'P0001';
    end if;
  elsif v_src = 'fondo' then
    v_vault := public.vault_of(v_org, v_site);
    select balance into v_amt from public.vaults where id = v_vault;
    if coalesce(v_amt, 0) < v_total then
      raise exception 'El fondo de la sucursal tiene % y el pago es de %', public.fmt_money(coalesce(v_amt, 0)), public.fmt_money(v_total) using errcode = 'P0001';
    end if;
  end if;
  v_num := public.next_consecutive(v_org, 'pago_personal', v_site, 'PN-');

  for e in select se.*, u.name as uname, u.last_name as ulast from public.staff_earnings se join public.users u on u.id = se.user_id
      where se.id in (select (x)::bigint from jsonb_array_elements_text(coalesce(p->'earnings', '[]'::jsonb)) x) and se.org_id = v_org for update of se loop
    if e.status <> 'pendiente' then raise exception 'Un pago de % ya estaba hecho', trim(e.uname || ' ' || coalesce(e.ulast, '')) using errcode = 'P0001'; end if;
    if e.site_id is distinct from v_site then raise exception 'Un pago pendiente es de otra sucursal' using errcode = 'P0001'; end if;
    v_name := trim(e.uname || ' ' || coalesce(e.ulast, ''));
    v_exp_id := null;
    if e.kind = 'domicilios' then
      -- La parte del domiciliario no es un gasto: es el valor del domicilio que pagó el cliente.
      if v_src = 'caja' then
        insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
          values (v_org, v_sid, 'pago_personal', 'efectivo', -e.amount, v_num, 'Domicilios para ' || v_name, v_user);
      elsif v_src = 'fondo' then
        insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
          values (v_org, v_vault, 'pago_personal', -e.amount, v_num, 'Domicilios para ' || v_name, v_user);
      end if;
    else
      v_exp_id := public.finance_expense(jsonb_build_object('org_id', v_org, 'user_id', v_user, 'site_id', v_site, 'category', 'nomina',
        'description', left(coalesce(e.note, 'Turno') || ' · ' || v_name || coalesce(' (' || trim_scale(e.hours) || ' h)', ''), 200), 'amount', e.amount,
        'source', v_esrc, 'session_id', v_sid, 'invoice_ref', v_num));
    end if;
    update public.staff_earnings set status = 'pagado', paid_at = now(), paid_by = v_user, paid_source = v_src, paid_method = v_method,
      paid_number = v_num, paid_session_id = v_sid, expense_id = v_exp_id,
      note = coalesce(note, '') || coalesce(' · ' || v_note, '') where id = e.id;
  end loop;

  for t in select * from jsonb_array_elements(coalesce(p->'payroll', '[]'::jsonb)) loop
    select id, name, last_name, pay_mode into v_emp from public.users where id = (t->>'user_id')::bigint and org_id = v_org;
    if v_emp.id is null then raise exception 'Uno de los empleados no existe' using errcode = 'P0001'; end if;
    v_from := (t->>'period_from')::date; v_to := (t->>'period_to')::date;
    if v_from is null or v_to is null or v_to < v_from then raise exception 'El periodo de la nómina no es válido' using errcode = 'P0001'; end if;
    v_name := trim(v_emp.name || ' ' || coalesce(v_emp.last_name, ''));
    if exists (select 1 from public.staff_earnings where user_id = v_emp.id and kind = 'nomina' and period_from = v_from) then
      raise exception 'La nómina de % del % ya se pagó', v_name, to_char(v_from, 'DD/MM/YYYY') using errcode = 'P0001';
    end if;
    v_amt := (t->>'amount')::numeric;
    v_exp_id := public.finance_expense(jsonb_build_object('org_id', v_org, 'user_id', v_user, 'site_id', v_site, 'category', 'nomina',
      'description', left('Nómina ' || to_char(v_from, 'DD/MM') || ' al ' || to_char(v_to, 'DD/MM/YYYY') || ' · ' || v_name, 200), 'amount', v_amt,
      'source', v_esrc, 'session_id', v_sid, 'invoice_ref', v_num));
    insert into public.staff_earnings (org_id, site_id, user_id, kind, period_from, period_to, amount, note, created_by,
        status, paid_at, paid_by, paid_source, paid_method, paid_number, paid_session_id, expense_id)
      values (v_org, v_site, v_emp.id, 'nomina', v_from, v_to, v_amt, v_note, v_user,
        'pagado', now(), v_user, v_src, v_method, v_num, v_sid, v_exp_id);
  end loop;
  return jsonb_build_object('number', v_num, 'total', v_total, 'count', v_count, 'source', v_src);
end $$;
revoke execute on function public.pay_staff(jsonb) from public, anon, authenticated;
grant execute on function public.pay_staff(jsonb) to service_role;

notify pgrst, 'reload schema';
