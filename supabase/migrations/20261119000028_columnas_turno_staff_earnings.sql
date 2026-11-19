-- TD-021 (fix) · Columnas del turno en staff_earnings.
-- La migración 20261119000026 se amplió después de aplicarse: extra_hours, extra_rate y fixed quedaron dentro
-- de "create table if not exists", así que en las bases donde la tabla ya existía no se crearon. Sin ellas
-- fallan el registro manual de turnos y el pago de turnos en el cierre de caja.
alter table public.staff_earnings add column if not exists extra_hours numeric(6, 2);
alter table public.staff_earnings add column if not exists extra_rate numeric(14, 2);
alter table public.staff_earnings add column if not exists fixed boolean not null default false;

notify pgrst, 'reload schema';
