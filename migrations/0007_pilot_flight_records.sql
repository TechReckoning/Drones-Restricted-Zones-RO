-- 0007_pilot_flight_records.sql
-- Per-pilot Flight Record (AACR "Evidență proprie a tuturor zborurilor").
-- One record per pilot; owner-only RLS, same pattern as the other tables.
-- Re-runnable.
--
-- `data` holds the whole record as JSON:
--   { pilot: { first_name, surname, address, phone_fixed, phone_mobile, dob,
--              certificate_number },
--     flights: [ { date, type, registration, route, hours }, ... ] }
-- Everything is free text except `type` (a fixed set of category labels).
-- Nothing here feeds the request forms or any other section of the app.

create table if not exists public.pilot_flight_records (
  pilot_id   uuid primary key references public.pilots (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists pilot_flight_records_user_idx on public.pilot_flight_records (user_id);

alter table public.pilot_flight_records enable row level security;

drop policy if exists pfr_select_own on public.pilot_flight_records;
create policy pfr_select_own on public.pilot_flight_records for select using (auth.uid() = user_id);
drop policy if exists pfr_insert_own on public.pilot_flight_records;
create policy pfr_insert_own on public.pilot_flight_records for insert with check (auth.uid() = user_id);
drop policy if exists pfr_update_own on public.pilot_flight_records;
create policy pfr_update_own on public.pilot_flight_records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists pfr_delete_own on public.pilot_flight_records;
create policy pfr_delete_own on public.pilot_flight_records for delete using (auth.uid() = user_id);
