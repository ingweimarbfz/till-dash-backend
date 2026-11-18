-- TD-003: al cobrar, la mesa queda "por liberar" hasta que el mesero la limpia y toca Liberar.
alter table public.dining_tables add column if not exists to_release_at timestamptz;
alter table public.dining_tables add column if not exists last_order_id bigint references public.orders(id) on delete set null;

create or replace function public.orders_table_release() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.table_id is not null and new.status = 'cobrado' and old.status = 'abierto' then
    update public.dining_tables set to_release_at = now(), last_order_id = new.id where id = new.table_id;
  end if;
  return new;
end $$;

drop trigger if exists orders_table_release on public.orders;
create trigger orders_table_release after update of status on public.orders
  for each row execute function public.orders_table_release();

revoke all on function public.orders_table_release() from public, anon, authenticated;
