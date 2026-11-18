-- TD-008 · Domicilios y domiciliarios
-- · orders.delivery_fee: valor del domicilio que se le cobra al cliente (0 = no se cobra). Solo en pedidos a domicilio.
--   Se suma al total después del descuento (el descuento no aplica sobre el domicilio).
-- · app_settings.delivery_fee_default: tarifa sugerida que se precarga al abrir un domicilio (0 = sin sugerencia).
-- · orders.courier_id / delivery_status / dispatched_at / arrived_at: domiciliario asignado y estado de la entrega
--   (por_despachar → en_camino → entregado).
-- · app_settings.courier_share_mode / courier_share_percent: qué parte del valor del domicilio le toca al domiciliario
--   ('todo' o 'porcentaje'; el resto queda como venta del negocio).
-- · courier_payouts + cash_movements 'domicilio_pagado': al cerrar la caja se le paga a cada domiciliario su parte de los
--   domicilios y las propinas de sus entregas. Sale del efectivo de la caja, como las propinas. Al reabrir el turno se anula.

alter table public.orders add column if not exists delivery_fee numeric(14,2) not null default 0;
do $$ begin
  alter table public.orders add constraint orders_delivery_fee_check check (delivery_fee >= 0);
exception when duplicate_object then null; end $$;
alter table public.app_settings add column if not exists delivery_fee_default numeric(14,2) not null default 0;
do $$ begin
  alter table public.app_settings add constraint app_settings_delivery_fee_default_check check (delivery_fee_default >= 0);
exception when duplicate_object then null; end $$;

alter table public.orders add column if not exists courier_id bigint references public.users(id) on delete set null;
alter table public.orders add column if not exists delivery_status text;
alter table public.orders add column if not exists dispatched_at timestamptz;
alter table public.orders add column if not exists arrived_at timestamptz;
do $$ begin
  alter table public.orders add constraint orders_delivery_status_check check (delivery_status in ('por_despachar', 'en_camino', 'entregado'));
exception when duplicate_object then null; end $$;
update public.orders set delivery_status = case when status = 'abierto' then 'por_despachar' else 'entregado' end
  where type = 'domicilio' and delivery_status is null;
create index if not exists orders_courier_idx on public.orders (courier_id) where courier_id is not null;

alter table public.app_settings add column if not exists courier_share_mode text not null default 'todo';
alter table public.app_settings add column if not exists courier_share_percent numeric(5,2) not null default 100;
do $$ begin
  alter table public.app_settings add constraint app_settings_courier_share_chk
    check (courier_share_mode in ('todo', 'porcentaje') and courier_share_percent between 0 and 100);
exception when duplicate_object then null; end $$;

create table if not exists public.courier_payouts (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  session_id bigint not null references public.cash_sessions(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete restrict,
  deliveries int not null default 0,
  fees numeric(14,2) not null default 0,      -- valor de los domicilios cobrados en el turno
  share numeric(14,2) not null default 0,     -- lo que le toca de esos domicilios
  tips numeric(14,2) not null default 0,      -- propinas de sus entregas
  amount numeric(14,2) not null check (amount > 0),
  paid_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists courier_payouts_session_idx on public.courier_payouts (session_id);
create index if not exists courier_payouts_user_idx on public.courier_payouts (user_id, created_at);
alter table public.courier_payouts enable row level security;
revoke all on public.courier_payouts from anon, authenticated;
alter table public.cash_sessions add column if not exists couriers_paid numeric(14,2) not null default 0;

alter table public.cash_movements drop constraint if exists cash_movements_type_check;
alter table public.cash_movements add constraint cash_movements_type_check
  check (type in ('apertura', 'venta', 'abono', 'ingreso', 'egreso', 'a_boveda', 'propina_pagada', 'domicilio_pagado'));

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
    total = v_sub - v_disc + tip + coalesce(delivery_fee, 0) where id = p_order;
end $$;

create or replace function public.charge_order(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; o record; v_sid bigint; v_ssite bigint; v_sstatus text; v_user bigint := (p->>'user_id')::bigint;
  v_tip numeric := coalesce((p->>'tip')::numeric, 0); d jsonb := p->'discount'; pay jsonb; v_sum numeric := 0; v_total numeric;
  v_cxc numeric := 0; v_rnum text; v_rid bigint; v_cash_change numeric := 0; v_fee numeric;
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
  -- Domicilio: si el cobro trae la tarifa, reemplaza la del pedido. Solo aplica a pedidos a domicilio.
  v_fee := case when o.type = 'domicilio' then coalesce((p->>'delivery_fee')::numeric, o.delivery_fee, 0) else 0 end;
  if v_fee < 0 then raise exception 'El valor del domicilio no puede ser negativo' using errcode = 'P0001'; end if;

  update public.orders set tip = v_tip, delivery_fee = v_fee,
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
  return jsonb_build_object('number', o.number, 'total', v_total, 'change', v_cash_change, 'receivable', v_rnum, 'deliveryFee', v_fee);
end $$;

-- Cierre de caja: además de las propinas, se paga a cada domiciliario lo suyo (couriers: [{user_id, amount, deliveries, fees, share, tips}]).
create or replace function public.close_cash_session(p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; s record; v_exp numeric; v_cnt numeric := (p->>'counted_cash')::numeric;
  v_float numeric := coalesce((p->>'next_float')::numeric, 0); v_user bigint := (p->>'user_id')::bigint;
  v_tips numeric := 0; v_cour numeric := 0; v_vault numeric; t jsonb; v_emp record;
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
    continue when coalesce((t->>'amount')::numeric, 0) <= 0;
    select id, name, last_name into v_emp from public.users where id = (t->>'user_id')::bigint and org_id = v_org;
    if v_emp.id is null then raise exception 'Uno de los domiciliarios no existe' using errcode = 'P0001'; end if;
    insert into public.courier_payouts (org_id, session_id, user_id, deliveries, fees, share, tips, amount, paid_by)
      values (v_org, s.id, v_emp.id, coalesce((t->>'deliveries')::int, 0), coalesce((t->>'fees')::numeric, 0), coalesce((t->>'share')::numeric, 0),
              coalesce((t->>'tips')::numeric, 0), (t->>'amount')::numeric, v_user);
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, s.id, 'domicilio_pagado', 'efectivo', -(t->>'amount')::numeric, s.number,
              'Domicilios para ' || trim(v_emp.name || ' ' || coalesce(v_emp.last_name, '')), v_user);
    v_cour := v_cour + (t->>'amount')::numeric;
  end loop;

  v_vault := v_cnt - v_tips - v_cour - v_float;
  if v_vault < 0 then
    raise exception 'Con % de efectivo no alcanza para % de propinas, % de domiciliarios y % de base', public.fmt_money(v_cnt), public.fmt_money(v_tips), public.fmt_money(v_cour), public.fmt_money(v_float) using errcode = 'P0001';
  end if;
  if v_vault > 0 then
    insert into public.cash_movements (org_id, session_id, type, method, amount, ref, note, user_id)
      values (v_org, s.id, 'a_boveda', 'efectivo', -v_vault, s.number, 'Cierre: pasa a la bóveda', v_user);
    insert into public.vault_movements (org_id, vault_id, type, amount, session_id, ref, note, user_id)
      values (v_org, public.vault_of(v_org, s.site_id), 'cierre_caja', v_vault, s.id, s.number, 'Cierre del turno ' || s.number, v_user);
  end if;
  update public.cash_registers set float_amount = v_float where id = s.register_id;
  update public.cash_sessions set status = 'cerrada', expected_cash = v_exp, counted_cash = v_cnt, difference = v_cnt - v_exp,
    tips_paid = v_tips, couriers_paid = v_cour, next_float = v_float, to_vault = v_vault, closed_by = v_user, closed_at = now(), close_note = nullif(p->>'note', '')
    where id = s.id;
  return jsonb_build_object('number', s.number, 'expected', v_exp, 'counted', v_cnt, 'difference', v_cnt - v_exp,
    'tipsPaid', v_tips, 'couriersPaid', v_cour, 'nextFloat', v_float, 'toVault', v_vault);
end $$;

revoke execute on function public.recalc_order(bigint), public.charge_order(jsonb), public.close_cash_session(jsonb) from public, anon, authenticated;
grant execute on function public.recalc_order(bigint), public.charge_order(jsonb), public.close_cash_session(jsonb) to service_role;

-- Reabrir un turno también anula lo pagado a los domiciliarios.
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
  -- El efectivo vuelve al turno: se quitan la salida a la bóveda, las propinas y domicilios pagados y la base que quedaba en la caja.
  delete from public.cash_movements where session_id = s.id and type in ('a_boveda', 'propina_pagada', 'domicilio_pagado');
  delete from public.courier_payouts where session_id = s.id;
  delete from public.tip_payouts where session_id = s.id;
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
