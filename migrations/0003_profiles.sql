-- Phase A (flight-request generator) — reusable profile + equipment library.
-- Run in the Supabase SQL editor after 0001/0002. Re-runnable.
--
-- Stores the operator's own details plus a library of remote pilots and drones,
-- used to pre-fill the official ROMATSA flight-approval forms. Owner-only via RLS.

create extension if not exists pgcrypto;

-- One operator profile per user.
create table if not exists public.operator_profile (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  operator_name  text,
  contact_details text,           -- "Date de contact" (address / general contact)
  contact_person text,
  phone_landline text,            -- telefon fix
  phone_mobile   text,
  fax            text,
  email          text,
  operator_code  text,
  updated_at     timestamptz not null default now()
);

-- Many remote pilots per user.
create table if not exists public.pilots (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  name           text not null default '',
  phone          text,
  qualifications text,            -- "Calificări relevante"
  created_at     timestamptz not null default now()
);
create index if not exists pilots_user_idx on public.pilots (user_id, created_at desc);

-- Many drones per user.
create table if not exists public.drones (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  registration   text,            -- Identificare / Înmatriculare
  serial         text,
  manufacturer   text,
  model          text,
  operating_class text,           -- C0/C1/C2/C3/C4/PRV...
  category       text,            -- A1/A2/A3
  operator_code  text,
  mtom_kg        numeric,         -- MTOM/MTOW
  created_at     timestamptz not null default now()
);
create index if not exists drones_user_idx on public.drones (user_id, created_at desc);

-- Owner-only RLS on all three (drop-then-create → re-runnable), same pattern as 0001.
alter table public.operator_profile enable row level security;
alter table public.pilots           enable row level security;
alter table public.drones           enable row level security;

do $$
declare t text;
begin
  foreach t in array array['operator_profile','pilots','drones'] loop
    execute format('drop policy if exists %I_select_own on public.%I', t, t);
    execute format('create policy %I_select_own on public.%I for select using (auth.uid() = user_id)', t, t);
    execute format('drop policy if exists %I_insert_own on public.%I', t, t);
    execute format('create policy %I_insert_own on public.%I for insert with check (auth.uid() = user_id)', t, t);
    execute format('drop policy if exists %I_update_own on public.%I', t, t);
    execute format('create policy %I_update_own on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t, t);
    execute format('drop policy if exists %I_delete_own on public.%I', t, t);
    execute format('create policy %I_delete_own on public.%I for delete using (auth.uid() = user_id)', t, t);
  end loop;
end $$;
