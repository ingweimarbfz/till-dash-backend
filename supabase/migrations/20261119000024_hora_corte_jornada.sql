-- TD-019 · Jornadas que cruzan la medianoche.
-- Muchos establecimientos abren a las 4 p. m. y cierran a la 1, 2 o 3 a. m. del día siguiente. El cuadre
-- del día agrupa los turnos por jornada: un turno pertenece a la jornada del día en que se abrió, contando
-- que la jornada empieza a esta hora (hora de Colombia). Con 6, un turno abierto el 20 a las 2 a. m. es de
-- la jornada del 19. 0 = día calendario (medianoche a medianoche).
alter table public.app_settings add column if not exists day_cutoff_hour smallint not null default 6;
alter table public.app_settings drop constraint if exists app_settings_day_cutoff_hour_check;
alter table public.app_settings add constraint app_settings_day_cutoff_hour_check check (day_cutoff_hour between 0 and 12);
