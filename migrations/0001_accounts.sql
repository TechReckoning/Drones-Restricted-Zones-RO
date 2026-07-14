-- Phase 2 — accounts + saved flying-zone history.
-- Run in the Supabase SQL editor (or `supabase db push`). Re-runnable.
--
-- Stores each user's saved flying zones. Auth users live in Supabase's built-in
-- auth.users table (magic-link); we only add app data here, protected by RLS so a
-- user can only ever touch their own rows.

create extension if not exists pgcrypto;

create table if not exists public.flight_zones (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  name               text not null default 'Untitled flying zone',
  geometry           jsonb not null,                 -- GeoJSON Polygon of the flying zone
  area_m2            numeric,                         -- computed area at save time
  overlap_zones      jsonb not null default '[]'::jsonb, -- compact snapshot of overlapping restricted zones
  dataset_valid_from date,                            -- ROMATSA dataset version it was checked against
  created_at         timestamptz not null default now()
);

create index if not exists flight_zones_user_idx
  on public.flight_zones (user_id, created_at desc);

alter table public.flight_zones enable row level security;

-- Owner-only access. Drop-then-create so the migration is re-runnable.
drop policy if exists flight_zones_select_own on public.flight_zones;
create policy flight_zones_select_own on public.flight_zones
  for select using (auth.uid() = user_id);

drop policy if exists flight_zones_insert_own on public.flight_zones;
create policy flight_zones_insert_own on public.flight_zones
  for insert with check (auth.uid() = user_id);

drop policy if exists flight_zones_update_own on public.flight_zones;
create policy flight_zones_update_own on public.flight_zones
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists flight_zones_delete_own on public.flight_zones;
create policy flight_zones_delete_own on public.flight_zones
  for delete using (auth.uid() = user_id);
