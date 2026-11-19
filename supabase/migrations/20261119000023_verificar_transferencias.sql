-- TD-017 · Verificar las transferencias del turno (Nequi, Daviplata, transferencia bancaria).
-- Las transferencias no entran al efectivo de la caja, pero hay que confirmar que sí llegaron a la cuenta
-- o al celular. Cada cobro o abono por transferencia es un movimiento de caja (cash_movements); su
-- verificación queda aquí: llegó o no llegó, quién lo revisó, en qué cuenta y la foto del comprobante.
-- Sin fila = pendiente por verificar.
create table if not exists public.transfer_checks (
  movement_id bigint primary key references public.cash_movements(id) on delete cascade,
  org_id bigint not null references public.organizations(id) on delete cascade,
  status text not null check (status in ('verificada', 'no_llego')),
  account text,
  note text,
  proof text,
  has_proof boolean generated always as (proof is not null) stored,
  checked_by bigint references public.users(id) on delete set null,
  checked_at timestamptz not null default now()
);
create index if not exists transfer_checks_org_idx on public.transfer_checks (org_id, status);
create index if not exists cash_movements_transfer_idx on public.cash_movements (org_id, method, created_at desc)
  where method in ('transferencia', 'nequi', 'daviplata') and type in ('venta', 'abono');
alter table public.transfer_checks enable row level security;
