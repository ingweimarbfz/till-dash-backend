-- =====================================================================
-- TD-016 · Fechas de vencimiento por lote y productos próximos a vencer
-- · Al registrar una entrada (o el stock inicial) la fecha de vencimiento es opcional. Con fecha,
--   esas unidades quedan en un lote (stock_lots): bodega + producto + fecha. Dos entradas con la
--   misma fecha en la misma bodega suman al mismo lote. Sin fecha, son unidades "sin vencimiento".
-- · Las salidas se descuentan por FEFO (primero lo que vence primero):
--     1) los lotes vigentes, del que vence antes al que vence después;
--     2) las unidades sin fecha;
--     3) los lotes ya vencidos, solo si no queda otra cosa.
--   Una venta que solo podría salir de un lote vencido se bloquea (app_settings.block_expired_sales):
--   lo vencido se da de baja, no se vende. Una baja puede apuntar a un lote (inventory_movements.lot_id).
-- · Los traslados llevan sus lotes a la bodega de destino con la misma fecha, y una devolución
--   (ítem anulado) regresa a los lotes de los que salió la venta.
-- · stock_lot_moves guarda qué lote tocó cada movimiento (trazabilidad del lote).
-- · Siempre se cumple: suma de los lotes de una bodega ≤ existencias de esa bodega.
-- =====================================================================

alter table public.app_settings add column if not exists expiry_alert_days int not null default 15 check (expiry_alert_days between 1 and 365);
alter table public.app_settings add column if not exists block_expired_sales boolean not null default true;

create table if not exists public.stock_lots (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  warehouse_id bigint not null references public.warehouses(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  expires_on date not null,
  quantity numeric(14, 3) not null default 0 check (quantity >= 0),   -- lo que queda del lote
  received numeric(14, 3) not null default 0,                          -- todo lo que ha entrado al lote
  unit_cost numeric(14, 2),
  ref text,                                                            -- primera entrada (EN-00001, TR-00001…)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_lots_place_date_key unique (warehouse_id, product_id, expires_on)
);
create index if not exists stock_lots_org_exp_idx on public.stock_lots (org_id, expires_on) where quantity > 0;
create index if not exists stock_lots_product_idx on public.stock_lots (product_id);

create table if not exists public.stock_lot_moves (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  lot_id bigint not null references public.stock_lots(id) on delete cascade,
  movement_id bigint not null references public.inventory_movements(id) on delete cascade,
  quantity numeric(14, 3) not null check (quantity <> 0),             -- con signo, como el movimiento
  created_at timestamptz not null default now()
);
create index if not exists stock_lot_moves_movement_idx on public.stock_lot_moves (movement_id);
create index if not exists stock_lot_moves_lot_idx on public.stock_lot_moves (lot_id);

alter table public.inventory_movements add column if not exists expires_on date;     -- entrada: fecha del lote que crea
alter table public.inventory_movements add column if not exists lot_id bigint references public.stock_lots(id) on delete set null; -- baja de un lote puntual

alter table public.stock_lots enable row level security;
alter table public.stock_lot_moves enable row level security;

-- Suma unidades a un lote (lo crea si no existe) y deja la huella del movimiento.
create or replace function public.stock_lot_add(p_org bigint, p_wh bigint, p_prod bigint, p_exp date, p_qty numeric, p_cost numeric, p_ref text, p_move bigint)
returns bigint language plpgsql set search_path = '' as $$
declare v_lot bigint;
begin
  insert into public.stock_lots (org_id, warehouse_id, product_id, expires_on, quantity, received, unit_cost, ref)
    values (p_org, p_wh, p_prod, p_exp, p_qty, p_qty, p_cost, p_ref)
    on conflict (warehouse_id, product_id, expires_on) do update
      set quantity = public.stock_lots.quantity + excluded.quantity, received = public.stock_lots.received + excluded.received,
          unit_cost = coalesce(excluded.unit_cost, public.stock_lots.unit_cost), updated_at = now()
    returning id into v_lot;
  insert into public.stock_lot_moves (org_id, lot_id, movement_id, quantity) values (p_org, v_lot, p_move, p_qty);
  return v_lot;
end $$;

-- Saca hasta p_qty de un lote y devuelve cuánto sacó.
create or replace function public.stock_lot_take(p_lot bigint, p_qty numeric, p_move bigint)
returns numeric language plpgsql set search_path = '' as $$
declare v_take numeric; v_org bigint;
begin
  select least(quantity, p_qty), org_id into v_take, v_org from public.stock_lots where id = p_lot for update;
  if coalesce(v_take, 0) <= 0 then return 0; end if;
  update public.stock_lots set quantity = quantity - v_take, updated_at = now() where id = p_lot;
  insert into public.stock_lot_moves (org_id, lot_id, movement_id, quantity) values (v_org, p_lot, p_move, -v_take);
  return v_take;
end $$;

create or replace function public.apply_stock_lots() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_today date := (now() at time zone 'America/Bogota')::date;
  v_left numeric; v_lots numeric; v_undated numeric; v_block boolean; v_name text; v_wh text;
  l record;
begin
  -- ---------- Entradas ----------
  if new.quantity > 0 then
    if new.type in ('entrada', 'ajuste') and new.expires_on is not null then
      perform public.stock_lot_add(new.org_id, new.warehouse_id, new.product_id, new.expires_on, new.quantity, new.unit_cost, new.ref, new.id);
    elsif new.type = 'traslado_entrada' then
      -- Los mismos lotes que salieron de la bodega de origen en este traslado.
      for l in select sl.expires_on, sl.unit_cost, -sum(lm.quantity) as q
               from public.stock_lot_moves lm
               join public.inventory_movements m on m.id = lm.movement_id
               join public.stock_lots sl on sl.id = lm.lot_id
               where m.org_id = new.org_id and m.ref = new.ref and m.product_id = new.product_id and m.type = 'traslado_salida'
               group by sl.expires_on, sl.unit_cost loop
        if l.q > 0 then perform public.stock_lot_add(new.org_id, new.warehouse_id, new.product_id, l.expires_on, l.q, l.unit_cost, new.ref, new.id); end if;
      end loop;
    elsif new.type = 'devolucion' then
      -- Regresa a los lotes de los que salió la venta de ese pedido (lo que aún no se ha devuelto).
      v_left := new.quantity;
      for l in select lm.lot_id, -sum(lm.quantity) as net
               from public.stock_lot_moves lm
               join public.inventory_movements m on m.id = lm.movement_id
               join public.stock_lots sl on sl.id = lm.lot_id
               where m.org_id = new.org_id and m.ref = new.ref and m.product_id = new.product_id and m.warehouse_id = new.warehouse_id
                 and m.type in ('venta', 'devolucion')
               group by lm.lot_id, sl.expires_on having sum(lm.quantity) < 0
               order by sl.expires_on loop
        exit when v_left <= 0;
        update public.stock_lots set quantity = quantity + least(v_left, l.net), updated_at = now() where id = l.lot_id;
        insert into public.stock_lot_moves (org_id, lot_id, movement_id, quantity) values (new.org_id, l.lot_id, new.id, least(v_left, l.net));
        v_left := v_left - least(v_left, l.net);
      end loop;
    end if;
    return null;
  end if;

  -- ---------- Salidas ----------
  v_left := -new.quantity;
  select coalesce(sum(quantity), 0) into v_lots from public.stock_lots
    where warehouse_id = new.warehouse_id and product_id = new.product_id and quantity > 0;
  if new.lot_id is not null then
    if not exists (select 1 from public.stock_lots where id = new.lot_id and warehouse_id = new.warehouse_id and product_id = new.product_id) then
      raise exception 'El lote elegido no es de este producto en esta bodega' using errcode = 'P0001';
    end if;
    if public.stock_lot_take(new.lot_id, v_left, new.id) < v_left then
      raise exception 'El lote elegido no tiene tantas unidades' using errcode = 'P0001';
    end if;
    return null;
  end if;
  if v_lots = 0 then return null; end if;
  -- Existencias antes del movimiento (stock_after lo puso el trigger anterior) menos lo que está en lotes.
  v_undated := greatest(new.stock_after - new.quantity - v_lots, 0);

  -- 1) Lotes vigentes: primero el que vence antes.
  for l in select id from public.stock_lots
           where warehouse_id = new.warehouse_id and product_id = new.product_id and quantity > 0 and expires_on >= v_today
           order by expires_on, id loop
    exit when v_left <= 0;
    v_left := v_left - public.stock_lot_take(l.id, v_left, new.id);
  end loop;
  -- 2) Unidades sin fecha.
  v_left := v_left - least(v_left, v_undated);
  -- 3) Lotes vencidos, solo si no queda otra cosa.
  if v_left > 0 then
    if new.type = 'venta' then
      select block_expired_sales into v_block from public.app_settings where org_id = new.org_id;
      if coalesce(v_block, true) then
        select name into v_name from public.products where id = new.product_id;
        select name into v_wh from public.warehouses where id = new.warehouse_id;
        raise exception 'No se puede vender "%": lo que queda en % está vencido. Dalo de baja o corrige la fecha del lote en Inventario → Vencimientos', v_name, v_wh using errcode = 'P0001';
      end if;
    end if;
    for l in select id from public.stock_lots
             where warehouse_id = new.warehouse_id and product_id = new.product_id and quantity > 0 and expires_on < v_today
             order by expires_on, id loop
      exit when v_left <= 0;
      v_left := v_left - public.stock_lot_take(l.id, v_left, new.id);
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists inventory_movements_lots on public.inventory_movements;
create trigger inventory_movements_lots after insert on public.inventory_movements for each row execute function public.apply_stock_lots();
