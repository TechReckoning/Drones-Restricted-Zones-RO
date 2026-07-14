-- Phase 3 — subscriptions / trial state.
-- Run in the Supabase SQL editor after 0001. Re-runnable.
--
-- One row per user tracking the 7-day trial and (if they subscribe) the Stripe
-- subscription. Users may READ their own row; all WRITES happen server-side via
-- the service-role key (Stripe webhook / checkout), never from the browser.

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text,
  status                 text,          -- Stripe subscription status (active, canceled, past_due, …)
  plan                   text,          -- 'monthly' | 'annual'
  current_period_end     timestamptz,   -- paid-through date
  trial_ends_at          timestamptz,   -- end of the local 7-day free trial
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_customer_idx
  on public.subscriptions (stripe_customer_id);

alter table public.subscriptions enable row level security;

-- Read-your-own only. No insert/update/delete policies → the browser (anon/user
-- role) cannot write; only the service role (which bypasses RLS) does.
drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select using (auth.uid() = user_id);
