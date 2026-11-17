-- figurdiscover accounts: one row of saved data per user.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.

create table if not exists public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- Each signed-in user can only see and change their own row.
drop policy if exists "read own data"   on public.user_data;
drop policy if exists "insert own data" on public.user_data;
drop policy if exists "update own data" on public.user_data;

create policy "read own data"   on public.user_data for select using (auth.uid() = user_id);
create policy "insert own data" on public.user_data for insert with check (auth.uid() = user_id);
create policy "update own data" on public.user_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ===== PRO subscriptions ($15/month "Market analysis") =====
-- Each user can only READ their own subscription. Only you (from this dashboard) or the
-- payment provider's webhook (service role) can add or change rows.
create table if not exists public.subscriptions (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  plan               text not null default 'pro_monthly',
  status             text not null default 'active',      -- active | trialing | canceled | past_due
  current_period_end timestamptz,                          -- leave empty = no end date
  provider           text,                                 -- lemonsqueezy | stripe | paypal | manual
  provider_ref       text,
  updated_at         timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select using (auth.uid() = user_id);

-- To give someone PRO by hand (e.g. yourself), run (replace the email):
-- insert into public.subscriptions (user_id, status, provider, current_period_end)
-- select id, 'active', 'manual', now() + interval '1 month' from auth.users where email = 'name@example.com'
-- on conflict (user_id) do update set status = 'active', current_period_end = excluded.current_period_end, updated_at = now();
