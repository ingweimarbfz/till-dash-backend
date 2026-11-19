-- TD-021 · Columnas de horas extra y valor fijo en staff_earnings.
-- 000026 crea la tabla con "create table if not exists": donde la tabla ya existía (primera versión de
-- 000026, antes de las horas extra) estas columnas no se crearon y registrar o pagar turnos fallaba.
alter table public.staff_earnings add column if not exists extra_hours numeric(6, 2);   -- horas extra del turno
alter table public.staff_earnings add column if not exists extra_rate numeric(14, 2);   -- valor de la hora extra
alter table public.staff_earnings add column if not exists fixed boolean not null default false;  -- valor fijo en vez de horas × valor

notify pgrst, 'reload schema';
