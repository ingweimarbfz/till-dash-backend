-- =====================================================================
-- TD-004 · Gastos del turno y solicitudes de recursos
-- · El cajero registra gastos menores del turno (hielo, limones, domicilios…): salen del efectivo de su
--   caja y quedan como gasto (EG-) en Finanzas. Hay un tope por gasto (app_settings.cash_expense_limit).
-- · Para compras mayores el cajero pide recursos al administrador (SR-). Si lo aprueba, el dinero sale del
--   fondo de la sucursal (o del general) y entra a la caja abierta.
-- =====================================================================
alter table public.app_settings add column if not exists cash_expense_limit numeric(14, 2) not null default 100000 check (cash_expense_limit >= 0);

create table if not exists public.cash_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint not null references public.sites(id) on delete cascade,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  number text not null,
  amount numeric(14, 2) not null check (amount > 0),
  reason text not null check (char_length(reason) between 3 and 200),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada')),
  approved_amount numeric(14, 2),
  from_general boolean not null default false,
  resolution text,
  requested_by bigint references public.users(id) on delete set null,
  resolved_by bigint references public.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists cash_requests_idx on public.cash_requests (org_id, status, created_at desc);

-- Aprobar: p {org_id, user_id, id, amount?, from_general?, note?}
create or replace function public.approve_cash_request(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; v_user bigint := (p->>'user_id')::bigint; r record; s record; v_amt numeric; v_gen boolean := coalesce((p->>'from_general')::boolean, false);
begin
  select * into r from public.cash_requests where id = (p->>'id')::bigint and org_id = v_org for update;
  if r.id is null then raise exception 'Solicitud no encontrada' using errcode = 'P0001'; end if;
  if r.status <> 'pendiente' then raise exception 'La solicitud ya fue %', r.status using errcode = 'P0001'; end if;
  select * into s from public.cash_sessions where id = r.session_id;
  if s.status <> 'abierta' then raise exception 'El turno % ya se cerró', s.number using errcode = 'P0001'; end if;
  v_amt := coalesce(nullif(p->>'amount', '')::numeric, r.amount);
  if v_amt <= 0 then raise exception 'El valor debe ser mayor que cero' using errcode = 'P0001'; end if;
  insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
    values (v_org, public.vault_of(v_org, case when v_gen then null else s.site_id end), 'base_caja', -v_amt, s.id, r.number, 'Recursos para ' || s.number || ': ' || r.reason, v_user);
  insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
    values (v_org, s.id, 'ingreso', 'efectivo', v_amt, r.number, 'Recursos aprobados: ' || r.reason, v_user);
  update public.cash_requests set status = 'aprobada', approved_amount = v_amt, from_general = v_gen, resolution = nullif(p->>'note', ''),
    resolved_by = v_user, resolved_at = now() where id = r.id;
  return jsonb_build_object('number', r.number, 'amount', v_amt, 'session', s.number);
end $$;

alter table public.cash_requests enable row level security;
revoke all on public.cash_requests from anon, authenticated;
revoke execute on function public.approve_cash_request(jsonb) from public, anon, authenticated;
grant execute on function public.approve_cash_request(jsonb) to service_role;

-- Insumos de operación (hielo, limones, desechables): gasto que no entra al inventario.
alter table public.expenses drop constraint if exists expenses_category_check;
alter table public.expenses add constraint expenses_category_check check (category in ('nomina', 'arriendo', 'servicios', 'compras', 'insumos', 'mantenimiento', 'impuestos', 'marketing', 'transporte', 'bancarios', 'otros'));
