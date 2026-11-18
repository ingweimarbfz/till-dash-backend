-- =====================================================================
-- TD-011 · Pago de las compras de inventario
-- · Toda entrada de inventario dice de dónde se pagó: caja del turno, una cuenta o subcuenta de Finanzas,
--   a crédito con el proveedor (cuenta por pagar) o inventario inicial (sin pago, solo super administrador).
-- · supplier_payables: lo que se le debe a un proveedor por una compra a crédito. Cada abono es un gasto
--   (categoría "compras") pagado desde una cuenta, la caja, el banco o un socio.
-- · Si se anula el gasto de un abono, la cuenta por pagar vuelve a quedar pendiente por ese valor.
-- =====================================================================

create table if not exists public.supplier_payables (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  site_id bigint references public.sites(id) on delete set null,
  supplier_id bigint not null references public.suppliers(id) on delete restrict,
  number text not null,
  movement_ref text,                                                    -- entrada de inventario (EN-…)
  invoice_ref text,
  description text not null check (char_length(description) between 3 and 200),
  amount numeric(16, 2) not null check (amount > 0),
  paid numeric(16, 2) not null default 0 check (paid >= 0),
  status text not null default 'pendiente' check (status in ('pendiente', 'pagada', 'anulada')),
  due_on date,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  constraint supplier_payables_paid_chk check (paid <= amount)
);
create index if not exists supplier_payables_org_idx on public.supplier_payables (org_id, status, due_on);
create index if not exists supplier_payables_supplier_idx on public.supplier_payables (supplier_id, created_at desc);
alter table public.supplier_payables enable row level security;
revoke all on public.supplier_payables from anon, authenticated;

-- Abonos: cada uno es un gasto que apunta a su cuenta por pagar.
alter table public.expenses add column if not exists payable_id bigint references public.supplier_payables(id) on delete set null;
create index if not exists expenses_payable_idx on public.expenses (payable_id) where payable_id is not null;

-- Abonar a una cuenta por pagar: registra el gasto (descuenta la cuenta o la caja) y suma lo pagado, todo junto.
create or replace function public.pay_supplier_payable(p jsonb) returns bigint
language plpgsql set search_path = '' as $$
declare v_org bigint := (p->>'org_id')::bigint; r record; v_amt numeric := (p->>'amount')::numeric; v_exp bigint;
begin
  select * into r from public.supplier_payables where id = (p->>'payable_id')::bigint and org_id = v_org for update;
  if r.id is null or r.status <> 'pendiente' then raise exception 'La cuenta por pagar no existe o ya no está pendiente' using errcode = 'P0001'; end if;
  if v_amt is null or v_amt <= 0 then raise exception 'Escribe un valor mayor que cero' using errcode = 'P0001'; end if;
  if v_amt > r.amount - r.paid then
    raise exception 'El abono supera el saldo pendiente (%)', public.fmt_money(r.amount - r.paid) using errcode = 'P0001';
  end if;
  v_exp := public.finance_expense(p || jsonb_build_object('category', 'compras', 'site_id', coalesce(p->>'site_id', r.site_id::text)));
  update public.expenses set payable_id = r.id, supplier_id = r.supplier_id where id = v_exp;
  update public.supplier_payables set paid = paid + v_amt,
    status = case when paid + v_amt >= amount then 'pagada' else 'pendiente' end,
    paid_at = case when paid + v_amt >= amount then now() else null end
    where id = r.id;
  return v_exp;
end $$;
revoke execute on function public.pay_supplier_payable(jsonb) from public, anon, authenticated;
grant execute on function public.pay_supplier_payable(jsonb) to service_role;

-- Anular el gasto de un abono devuelve ese valor al saldo pendiente.
create or replace function public.expense_payable_void() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.payable_id is not null and old.status = 'activo' and new.status = 'anulado' then
    update public.supplier_payables set paid = greatest(0, paid - old.amount), status = 'pendiente', paid_at = null
      where id = new.payable_id and status <> 'anulada';
  end if;
  return new;
end $$;
drop trigger if exists expenses_payable_void on public.expenses;
create trigger expenses_payable_void after update of status on public.expenses
  for each row execute function public.expense_payable_void();
