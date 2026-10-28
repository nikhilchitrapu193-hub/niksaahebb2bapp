-- =============================================================================
-- P2-7: Growth — website leads, push subscriptions, referral tracking
-- =============================================================================

-- Leads from public-facing website
create table if not exists website_leads (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone        text,
  email        text,
  outlet_name  text,
  message      text,
  source       text default 'website',  -- 'website','referral','direct'
  status       text not null default 'new' check (status in ('new','contacted','converted','lost')),
  notes        text,
  referred_by  uuid references restaurants(id) on delete set null,
  assigned_to  uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Push notification subscriptions (Web Push)
create table if not exists push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references profiles(id) on delete cascade,
  endpoint      text not null unique,
  p256dh_key    text not null,
  auth_key      text not null,
  user_agent    text,
  created_at    timestamptz not null default now()
);

-- Referral codes
create table if not exists referral_codes (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade unique,
  code          text not null unique,
  uses_count    int not null default 0,
  reward_type   text default 'discount',  -- 'discount','credit'
  reward_value  numeric(10,2) default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

alter table website_leads      enable row level security;
alter table push_subscriptions enable row level security;
alter table referral_codes     enable row level security;

create policy "admin manage leads"         on website_leads      for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "anon insert lead"           on website_leads      for insert with check (true);  -- public form
create policy "admin manage push_subs"     on push_subscriptions for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "own push_sub"               on push_subscriptions for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy "admin manage referrals"     on referral_codes     for all using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));
create policy "restaurant view own ref"    on referral_codes     for select using (restaurant_id = (select restaurant_id from profiles where id = auth.uid()));

create index if not exists idx_leads_status       on website_leads(status);
create index if not exists idx_push_profile       on push_subscriptions(profile_id);
create index if not exists idx_referral_code_code on referral_codes(code);
