-- TD-022 · Domiciliario: con qué base trabaja, si es externo y su vehículo.
-- · courier_float: 'empresa' (la caja le da base de cambio) o 'propia' (trabaja con su propio dinero; no se le da base).
-- · courier_external: no trabaja para la empresa (se registra rápido desde Domicilios). Como puede no usar la app,
--   el personal también puede marcar sus domicilios como entregados.
-- · vehicle_type / vehicle_has_plate / vehicle_plate: moto y carro llevan placa; bicicleta, patineta eléctrica o a pie no.
alter table public.users add column if not exists courier_float text not null default 'empresa';
alter table public.users add column if not exists courier_external boolean not null default false;
alter table public.users add column if not exists vehicle_type text;
alter table public.users add column if not exists vehicle_has_plate boolean not null default false;
alter table public.users add column if not exists vehicle_plate text;

do $$ begin
  alter table public.users add constraint users_courier_float_check check (courier_float in ('empresa', 'propia'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.users add constraint users_vehicle_type_check check (vehicle_type is null or vehicle_type in ('moto', 'carro', 'bicicleta', 'patineta', 'a_pie', 'otro'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.users add constraint users_vehicle_plate_check check (not vehicle_has_plate or coalesce(vehicle_plate, '') <> '');
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
