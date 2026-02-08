-- Supabase SQL: Create profiles and generation_logs tables
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor)

-- 1. Create the profiles table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  is_pro boolean default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text default 'none',
  plan_id text,
  generations_used integer default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 1b. Add resume summary columns to profiles (idempotent)
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='resume_hash') then
    alter table public.profiles add column resume_hash text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='resume_summary') then
    alter table public.profiles add column resume_summary text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='resume_updated_at') then
    alter table public.profiles add column resume_updated_at timestamptz;
  end if;
end $$;

-- 2. Create generation_logs table for debugging and support
create table if not exists public.generation_logs (
  id bigint generated always as identity primary key,
  user_email text not null,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  success boolean default true,
  generations_at_request integer default 0,
  error_message text
);

-- 3. Enable Row Level Security
alter table public.profiles enable row level security;
alter table public.generation_logs enable row level security;

-- 4. RLS policies: users can read their own profile, service role can do everything
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Service role full access profiles"
  on public.profiles for all
  using (true)
  with check (true);

create policy "Service role full access logs"
  on public.generation_logs for all
  using (true)
  with check (true);

-- 5. Function to increment generation count
create or replace function public.increment_generations(p_user_id uuid)
returns integer as $$
declare
  new_count integer;
begin
  update public.profiles
  set generations_used = generations_used + 1,
      updated_at = now()
  where id = p_user_id
  returning generations_used into new_count;
  return new_count;
end;
$$ language plpgsql security definer;

-- 6. Grant execute on the function
grant execute on function public.increment_generations(uuid) to authenticated;
grant execute on function public.increment_generations(uuid) to service_role;
