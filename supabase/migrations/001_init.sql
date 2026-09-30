-- League website v1: read-only snapshots published by `mmsave publish`, Discord login.
-- Run once in the Supabase SQL editor (or `supabase db push`). It runs in one transaction,
-- so a failed run changes nothing and can simply be run again.

begin;

-- Who is in the league. Replaced on every publish from league.json.
create table public.league_members (
  discord_username text primary key,       -- lower case
  member text not null,
  team text not null,
  role text not null check (role in ('member', 'organizer'))
);

-- One row per publish. `public` is what every member may see (see src/publish.ts).
create table public.snapshots (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  round int,
  game_date text,
  public jsonb not null
);

-- Budget, HQ and parts: visible to the team's member and the organizer only.
create table public.team_snapshots (
  snapshot_id bigint not null references public.snapshots on delete cascade,
  team text not null,
  private jsonb not null,
  primary key (snapshot_id, team)
);

create table public.market_snapshots (
  snapshot_id bigint primary key references public.snapshots on delete cascade,
  free_agents jsonb not null
);

-- Every Discord login the site has seen, so the organizer can match usernames to teams.
create table public.logins (
  user_id uuid primary key references auth.users on delete cascade,
  discord_username text not null,
  display_name text,
  last_seen timestamptz not null default now()
);

-- The Discord username of the caller. Supabase's Discord provider puts "username#0" in
-- user_metadata.name (older accounts: "username#1234"), so strip the discriminator.
create function public.current_discord_username() returns text
language sql stable set search_path = '' as $$
  select lower(coalesce(
    nullif(split_part(auth.jwt() -> 'user_metadata' ->> 'name', '#', 1), ''),
    auth.jwt() -> 'user_metadata' ->> 'user_name',
    auth.jwt() -> 'user_metadata' ->> 'full_name'))
$$;

-- security definer so policies can read league_members without recursing into its own RLS.
create function public.my_member() returns public.league_members
language sql stable security definer set search_path = '' as $$
  select * from public.league_members where discord_username = public.current_discord_username()
$$;

create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.league_members where discord_username = public.current_discord_username())
$$;

create function public.is_organizer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.league_members
                 where discord_username = public.current_discord_username() and role = 'organizer')
$$;

-- Called by the site after login.
create function public.touch_login() returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.logins (user_id, discord_username, display_name)
  values (auth.uid(), public.current_discord_username(),
          auth.jwt() -> 'user_metadata' -> 'custom_claims' ->> 'global_name')
  on conflict (user_id) do update
    set discord_username = excluded.discord_username, display_name = excluded.display_name, last_seen = now()
$$;

-- Called by `mmsave publish` with the service-role key: replace members, add a snapshot.
create function public.publish_snapshot(members jsonb, snapshot jsonb) returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  sid bigint;
begin
  delete from public.league_members where true;
  insert into public.league_members (discord_username, member, team, role)
    select m ->> 'discord_username', m ->> 'member', m ->> 'team', m ->> 'role'
    from jsonb_array_elements(members) m;

  insert into public.snapshots (round, game_date, public)
    values ((snapshot -> 'public' -> 'championship' -> 'lastRace' ->> 'round')::int,
            snapshot -> 'public' ->> 'gameDate',
            snapshot -> 'public')
    returning id into sid;

  insert into public.team_snapshots (snapshot_id, team, private)
    select sid, t ->> 'team', t -> 'private' from jsonb_array_elements(snapshot -> 'teams') t;

  insert into public.market_snapshots (snapshot_id, free_agents) values (sid, snapshot -> 'freeAgents');
  return sid;
end
$$;

revoke execute on function public.publish_snapshot(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.publish_snapshot(jsonb, jsonb) to service_role;
revoke execute on function public.touch_login() from public, anon;
grant execute on function public.touch_login() to authenticated;

-- Row-level security: reads only, for logged-in league members. All writes go through the
-- functions above.
alter table public.league_members enable row level security;
alter table public.snapshots enable row level security;
alter table public.team_snapshots enable row level security;
alter table public.market_snapshots enable row level security;
alter table public.logins enable row level security;

create policy "members see the league" on public.league_members
  for select to authenticated using (public.is_member());
create policy "members see snapshots" on public.snapshots
  for select to authenticated using (public.is_member());
create policy "members see the market" on public.market_snapshots
  for select to authenticated using (public.is_member());
create policy "own team or organizer" on public.team_snapshots
  for select to authenticated using (team = (public.my_member()).team or public.is_organizer());
create policy "own login or organizer" on public.logins
  for select to authenticated using (user_id = auth.uid() or public.is_organizer());

commit;
