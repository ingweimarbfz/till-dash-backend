-- TD-021 · Permiso de pagos y forma de pago del domiciliario.
-- · Los pagos asignados al personal (forma de pago, valor de la hora, salario, pago de turnos, domicilios
--   pendientes y nómina) solo los ve y gestiona el super administrador, o un administrador al que el super
--   administrador le dé este permiso (users.can_manage_pay). Las propinas siguen como estaban.
-- · Al domiciliario se le paga por domicilios (su parte del valor del domicilio, según el % de
--   Configuración) o por jornada como a un empleado (por turno o nómina); en ese caso el valor de sus
--   domicilios queda para el negocio (users.courier_pay).
alter table public.users add column if not exists can_manage_pay boolean not null default false;
alter table public.users add column if not exists courier_pay text not null default 'domicilios';
alter table public.users drop constraint if exists users_courier_pay_chk;
alter table public.users add constraint users_courier_pay_chk check (courier_pay in ('domicilios', 'jornada'));
comment on column public.users.can_manage_pay is 'Administrador con permiso para ver y gestionar los pagos al personal (lo asigna el super administrador)';
comment on column public.users.courier_pay is 'Domiciliario: domicilios = su parte del valor del domicilio; jornada = se le paga como empleado (turno o nómina)';

notify pgrst, 'reload schema';
