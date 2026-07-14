-- Phase B (flight-request generator) — saved request history.
-- Run in the Supabase SQL editor after 0003. Re-runnable.
--
-- Each row is a generated ROMATSA request: the form type, a human label, and the
-- exact PDF field values (so it can be re-downloaded without re-deriving). RLS owner-only.

create table if not exists public.flight_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  form_type  text not null,               -- 'informare' | 'solicitare'
  label      text,
  fields     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists flight_requests_user_idx on public.flight_requests (user_id, created_at desc);

alter table public.flight_requests enable row level security;

drop policy if exists flight_requests_select_own on public.flight_requests;
create policy flight_requests_select_own on public.flight_requests for select using (auth.uid() = user_id);
drop policy if exists flight_requests_insert_own on public.flight_requests;
create policy flight_requests_insert_own on public.flight_requests for insert with check (auth.uid() = user_id);
drop policy if exists flight_requests_update_own on public.flight_requests;
create policy flight_requests_update_own on public.flight_requests for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists flight_requests_delete_own on public.flight_requests;
create policy flight_requests_delete_own on public.flight_requests for delete using (auth.uid() = user_id);
