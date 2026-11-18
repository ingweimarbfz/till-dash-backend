-- TD-003: alias temporal de la mesa ("chica de rojo", "solo hombres").
-- Vive en el pedido abierto y se borra solo cuando el pedido se cobra o se anula.
alter table public.orders add column if not exists alias text;
alter table public.orders drop constraint if exists orders_alias_len;
alter table public.orders add constraint orders_alias_len check (alias is null or char_length(alias) <= 40);

create or replace function public.orders_clear_alias() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status <> 'abierto' then new.alias := null; end if;
  return new;
end $$;

drop trigger if exists orders_clear_alias on public.orders;
create trigger orders_clear_alias before update of status on public.orders
  for each row execute function public.orders_clear_alias();

revoke all on function public.orders_clear_alias() from public, anon, authenticated;
