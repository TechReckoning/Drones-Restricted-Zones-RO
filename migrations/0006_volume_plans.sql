-- 0006_volume_plans.sql
-- Volume Planner: save / reopen operational-volume plans per user.
-- Owner-only RLS, same pattern as the other library tables. Re-runnable.
--
-- `data` holds the whole plan (variant, drawn geometry, parameters, pilot/TO-LD),
-- so it can be fully restored without re-deriving anything.

create table if not exists public.volume_plans (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null default 'Untitled plan',
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists volume_plans_user_idx on public.volume_plans (user_id, created_at desc);

alter table public.volume_plans enable row level security;

drop policy if exists volume_plans_select_own on public.volume_plans;
create policy volume_plans_select_own on public.volume_plans for select using (auth.uid() = user_id);
drop policy if exists volume_plans_insert_own on public.volume_plans;
create policy volume_plans_insert_own on public.volume_plans for insert with check (auth.uid() = user_id);
drop policy if exists volume_plans_update_own on public.volume_plans;
create policy volume_plans_update_own on public.volume_plans for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists volume_plans_delete_own on public.volume_plans;
create policy volume_plans_delete_own on public.volume_plans for delete using (auth.uid() = user_id);
