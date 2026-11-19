-- TD-020 · Pago de propinas en un módulo aparte, cuando se requiera.
-- Antes las propinas se pagaban en el cierre del turno; lo que no se repartía se iba a la bóveda sin
-- dejar rastro de que se debía. Ahora el cierre ya no paga propinas:
-- · Lo que los clientes dejan de propina y aún no se ha pagado queda "por pagar" en la sucursal
--   (propinas de los pedidos cobrados − propinas pagadas). Se calcula, no se guarda.
-- · Las propinas se pagan cuando se quiera desde Caja → Propinas, a uno o varios empleados. El dinero
--   sale de la caja abierta, del fondo de la sucursal o se paga por transferencia/Nequi/Daviplata.
-- · Cada pago lleva un consecutivo (PP-0001) y queda por persona en tip_payouts.
-- · Los pagos hechos en cierres anteriores quedan como source = 'cierre'. Reabrir un turno solo anula
--   esos, no los pagados desde el módulo.

alter table public.tip_payouts alter column session_id drop not null;
alter table public.tip_payouts add column if not exists site_id bigint references public.sites(id) on delete set null;
alter table public.tip_payouts add column if not exists source text not null default 'cierre';
alter table public.tip_payouts add column if not exists method text not null default 'efectivo';
alter table public.tip_payouts add column if not exists vault_id bigint references public.vaults(id) on delete set null;
alter table public.tip_payouts add column if not exists number text;               -- consecutivo del pago (PP-…)
alter table public.tip_payouts add column if not exists note text;
alter table public.tip_payouts drop constraint if exists tip_payouts_source_chk;
alter table public.tip_payouts add constraint tip_payouts_source_chk check (source in ('cierre', 'caja', 'fondo', 'transferencia'));
create index if not exists tip_payouts_site_idx on public.tip_payouts (org_id, site_id, created_at desc);

-- La sucursal del pago sale del turno cuando no viene (los pagos del cierre).
create or replace function public.tip_payouts_site() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.site_id is null and new.session_id is not null then
    select site_id into new.site_id from public.cash_sessions where id = new.session_id;
  end if;
  return new;
end $$;
drop trigger if exists tip_payouts_site on public.tip_payouts;
create trigger tip_payouts_site before insert on public.tip_payouts for each row execute function public.tip_payouts_site();
revoke execute on function public.tip_payouts_site() from public, anon, authenticated;

update public.tip_payouts t set site_id = s.site_id from public.cash_sessions s where t.session_id = s.id and t.site_id is null;

-- Movimiento de caja y del fondo propios del módulo (el cierre sigue usando 'propina_pagada').
alter table public.cash_movements drop constraint if exists cash_movements_type_check;
alter table public.cash_movements add constraint cash_movements_type_check
  check (type in ('apertura', 'venta', 'abono', 'ingreso', 'egreso', 'a_boveda', 'propina_pagada', 'domicilio_pagado', 'base_domiciliario', 'retorno_domiciliario', 'pago_propina'));
alter table public.vault_movements drop constraint if exists vault_movements_type_check;
alter table public.vault_movements add constraint vault_movements_type_check check (type in (
  'deposito', 'retiro', 'cierre_caja', 'base_caja', 'consignacion', 'ajuste',
  'ingreso', 'gasto', 'traslado', 'retiro_socio', 'anulacion', 'pago_propina'));

-- Pagar propinas. p: {org_id, user_id, site_id, source: caja|fondo|transferencia, session_id (caja),
--   method (transferencia|nequi|daviplata), note, payments: [{user_id, amount}]}
create or replace function public.pay_tips(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_user bigint := (p->>'user_id')::bigint; v_site bigint := (p->>'site_id')::bigint;
  v_src text := p->>'source'; v_method text := coalesce(nullif(p->>'method', ''), 'efectivo'); v_note text := nullif(trim(coalesce(p->>'note', '')), '');
  s record; v_vault bigint; v_num text; v_total numeric := 0; v_count int := 0; t jsonb; v_amt numeric; v_emp record; v_name text; v_cash numeric; v_sid bigint;
begin
  if v_src not in ('caja', 'fondo', 'transferencia') then raise exception 'Elige de dónde sale el dinero' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.sites where id = v_site and org_id = v_org) then raise exception 'Sucursal no encontrada' using errcode = 'P0001'; end if;
  if v_src = 'transferencia' and v_method not in ('transferencia', 'nequi', 'daviplata') then raise exception 'Elige el medio de la transferencia' using errcode = 'P0001'; end if;
  if v_src <> 'transferencia' then v_method := 'efectivo'; end if;

  for t in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    v_amt := coalesce((t->>'amount')::numeric, 0);
    continue when v_amt <= 0;
    v_total := v_total + v_amt; v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'Escribe cuánto se le paga a cada persona' using errcode = 'P0001'; end if;

  if v_src = 'caja' then
    select * into s from public.cash_sessions where id = (p->>'session_id')::bigint and org_id = v_org for update;
    if s.id is null then raise exception 'Turno no encontrado' using errcode = 'P0001'; end if;
    if s.status <> 'abierta' then raise exception 'El turno % ya está cerrado', s.number using errcode = 'P0001'; end if;
    if s.site_id <> v_site then raise exception 'El turno es de otra sucursal' using errcode = 'P0001'; end if;
    v_sid := s.id;
    v_cash := public.session_cash(s.id);
    if v_cash < v_total then
      raise exception 'En la caja hay % de efectivo y el pago es de %', public.fmt_money(v_cash), public.fmt_money(v_total) using errcode = 'P0001';
    end if;
  elsif v_src = 'fondo' then
    v_vault := public.vault_of(v_org, v_site);
  end if;

  v_num := public.next_consecutive(v_org, 'pago_propinas', v_site, 'PP-');
  for t in select * from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) loop
    v_amt := coalesce((t->>'amount')::numeric, 0);
    continue when v_amt <= 0;
    select id, name, last_name into v_emp from public.users where id = (t->>'user_id')::bigint and org_id = v_org;
    if v_emp.id is null then raise exception 'Uno de los empleados del pago no existe' using errcode = 'P0001'; end if;
    v_name := trim(v_emp.name || ' ' || coalesce(v_emp.last_name, ''));
    insert into public.tip_payouts (org_id, site_id, session_id, user_id, amount, paid_by, source, method, vault_id, number, note)
      values (v_org, v_site, v_sid, v_emp.id, v_amt, v_user, v_src, v_method, v_vault, v_num, v_note);
    if v_src = 'caja' then
      insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
        values (v_org, v_sid, 'pago_propina', 'efectivo', -v_amt, v_num, 'Propina para ' || v_name, v_user);
    end if;
  end loop;

  if v_src = 'fondo' then
    insert into public.vault_movements (org_id, vault_id, type, amount, ref, note, user_id)
      values (v_org, v_vault, 'pago_propina', -v_total, v_num, 'Pago de propinas ' || v_num || coalesce(' · ' || v_note, ''), v_user);
  end if;
  return jsonb_build_object('number', v_num, 'total', v_total, 'count', v_count, 'source', v_src);
end $$;
revoke execute on function public.pay_tips(jsonb) from public, anon, authenticated;
grant execute on function public.pay_tips(jsonb) to service_role;

-- Reabrir un turno: solo se anulan las propinas pagadas en su cierre (las del módulo siguen pagadas).
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
  if coalesce(s.to_vault, 0) > 0 then
    select balance into v_bal from public.vaults where id = public.vault_of(v_org, s.site_id);
    if coalesce(v_bal, 0) < s.to_vault then
      raise exception 'El fondo de la sucursal ya no tiene los % que entraron con el cierre (disponible: %).', public.fmt_money(s.to_vault), public.fmt_money(coalesce(v_bal, 0)) using errcode = 'P0001';
    end if;
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, s.site_id), 'anulacion', -s.to_vault, s.id, s.number, 'Reapertura del turno ' || s.number, v_user);
  end if;
  v_snap := jsonb_build_object('expected', s.expected_cash, 'counted', s.counted_cash, 'difference', s.difference, 'tipsPaid', s.tips_paid, 'couriersPaid', s.couriers_paid,
    'nextFloat', s.next_float, 'toVault', s.to_vault, 'closedAt', s.closed_at, 'closedBy', s.closed_by, 'closeNote', s.close_note);
  -- El efectivo vuelve al turno: se quitan la salida a la bóveda, las propinas y domicilios pagados en el cierre y la base que quedaba en la caja.
  delete from public.cash_movements where session_id = s.id and type in ('a_boveda', 'propina_pagada', 'domicilio_pagado');
  delete from public.courier_payouts where session_id = s.id;
  delete from public.tip_payouts where session_id = s.id and source = 'cierre';
  update public.cash_registers set float_amount = 0 where id = s.register_id;
  update public.cash_sessions set status = 'abierta', expected_cash = null, counted_cash = null, difference = null, tips_paid = 0, couriers_paid = 0,
    next_float = 0, to_vault = 0, closed_by = null, closed_at = null, reopen_count = reopen_count + 1, reopened_at = now()
    where id = s.id;
  update public.cash_reopen_requests set status = 'aprobada', resolved_by = v_user, resolved_at = now(),
    resolution = nullif(p->>'note', ''), snapshot = v_snap where id = r.id;
  return jsonb_build_object('number', s.number, 'sessionId', s.id, 'snapshot', v_snap);
end $function$;
revoke execute on function public.reopen_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.reopen_cash_session(jsonb) to service_role;

notify pgrst, 'reload schema';
