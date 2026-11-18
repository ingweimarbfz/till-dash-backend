-- =====================================================================
-- TD-006 · Cuadre del día, reapertura de turnos de caja y cuenta del cliente en el QR
-- · cash_reopen_hours: horas después del cierre en que un turno todavía se puede reabrir
--   (0 = desactivado). Nunca si ya se abrió un turno nuevo en esa caja.
-- · cash_reopen_requests: solicitud con motivo; solo el administrador la aprueba y reabre el turno.
--   Al reabrir se anula el cierre: vuelve a la caja lo que pasó a la bóveda, se quitan las propinas
--   pagadas y la base para el próximo turno, y el turno queda abierto para corregir y cerrar de nuevo.
-- · qr_bill_view: qué ve el cliente de su cuenta en la carta QR (completa, sin valores u oculta).
-- =====================================================================

alter table public.app_settings add column if not exists cash_reopen_hours smallint not null default 12
  check (cash_reopen_hours between 0 and 72);
alter table public.app_settings add column if not exists qr_bill_view text not null default 'completa'
  check (qr_bill_view in ('completa', 'sin_valores', 'oculta'));

alter table public.cash_sessions add column if not exists reopen_count smallint not null default 0;
alter table public.cash_sessions add column if not exists reopened_at timestamptz;

create table if not exists public.cash_reopen_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete cascade,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  reason text not null check (char_length(reason) between 5 and 300),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada')),
  resolution text,
  snapshot jsonb,                                  -- el cierre que se anuló (esperado, contado, diferencia, propinas, base, bóveda)
  requested_by bigint references public.users(id) on delete set null,
  resolved_by bigint references public.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists cash_reopen_requests_pending_key on public.cash_reopen_requests (session_id) where status = 'pendiente';
create index if not exists cash_reopen_requests_org_idx on public.cash_reopen_requests (org_id, status, created_at desc);
alter table public.cash_reopen_requests enable row level security;
revoke all on public.cash_reopen_requests from anon, authenticated;

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
  v_snap := jsonb_build_object('expected', s.expected_cash, 'counted', s.counted_cash, 'difference', s.difference, 'tipsPaid', s.tips_paid,
    'nextFloat', s.next_float, 'toVault', s.to_vault, 'closedAt', s.closed_at, 'closedBy', s.closed_by, 'closeNote', s.close_note);
  -- El efectivo vuelve al turno: se quitan la salida a la bóveda, las propinas pagadas y la base que quedaba en la caja.
  delete from public.cash_movements where session_id = s.id and type in ('a_boveda', 'propina_pagada');
  delete from public.tip_payouts where session_id = s.id;
  update public.cash_registers set float_amount = 0 where id = s.register_id;
  update public.cash_sessions set status = 'abierta', expected_cash = null, counted_cash = null, difference = null, tips_paid = 0,
    next_float = 0, to_vault = 0, closed_by = null, closed_at = null, reopen_count = reopen_count + 1, reopened_at = now()
    where id = s.id;
  update public.cash_reopen_requests set status = 'aprobada', resolved_by = v_user, resolved_at = now(),
    resolution = nullif(p->>'note', ''), snapshot = v_snap where id = r.id;
  return jsonb_build_object('number', s.number, 'sessionId', s.id, 'snapshot', v_snap);
end $function$;
revoke execute on function public.reopen_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.reopen_cash_session(jsonb) to service_role;
