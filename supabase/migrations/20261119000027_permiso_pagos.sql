-- TD-021 · Los pagos asignados al personal (forma de pago, valor de la hora, salario, pago de turnos,
-- domicilios pendientes y nómina) solo los ve y gestiona el super administrador, o un administrador al
-- que el super administrador le dé este permiso. Las propinas siguen como estaban (caja y administración).
alter table public.users add column if not exists can_manage_pay boolean not null default false;
comment on column public.users.can_manage_pay is 'Administrador con permiso para ver y gestionar los pagos al personal (lo asigna el super administrador)';

notify pgrst, 'reload schema';
