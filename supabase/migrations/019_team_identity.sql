-- Team identity: members pick their team's colours, livery pattern and logo.
--
-- MM keeps only `Team.colorID` and `Team.liveryID` in the save; colours come from its Team Colours
-- table and logos from image mods (docs/save-schema.md, "Team colours, livery and logos"). So:
-- - team_looks: a standing choice per team (four colours + a livery pattern). `mmsave pull` re-applies
--   it every time (setTeamLook); `mmsave team-mod` writes the colour rows into a Team Colours
--   database mod. Each team keeps one colour row ID for good, unique across series, because the mod
--   is one file for the whole game install.
-- - team_logos: uploads (Storage bucket "team-logos", "<series>/<file>") wait for the organizer's
--   approval; `mmsave team-mod` puts the approved ones into the logo mod bundle.
-- Rules (the user's, 2026-10-05): any time between races; free colour picker; clashes only warn;
-- logos need the organizer's approval. The career team's colours live in the save header, so it's
-- left out (as with sponsors).
-- Runs in one transaction.

begin;

-- MM's own table has rows 0..128; league rows follow, never reused.
create sequence league.team_color_id start 129;
grant usage on sequence league.team_color_id to service_role;

create table league.team_looks (
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  primary_colour text not null check (primary_colour ~ '^#[0-9a-f]{6}$'),
  secondary_colour text not null check (secondary_colour ~ '^#[0-9a-f]{6}$'),
  tertiary_colour text not null check (tertiary_colour ~ '^#[0-9a-f]{6}$'),
  trim_colour text not null check (trim_colour ~ '^#[0-9a-f]{6}$'),
  livery_id int not null,
  color_id int not null unique default nextval('league.team_color_id'),
  updated_at timestamptz not null default now(),
  primary key (series, team)
);

create table league.team_logos (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  -- Object name in the team-logos bucket: "<series>/<file>".
  path text not null,
  -- pending: waiting for the organizer; approved: the team's logo (one at a time);
  -- replaced: an earlier approved logo; rejected; withdrawn: the member uploaded another first.
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'replaced')),
  note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index one_approved_logo on league.team_logos (series, team) where status = 'approved';
create unique index one_pending_logo on league.team_logos (series, team) where status = 'pending';

do $$
declare t text;
begin
  foreach t in array array['team_looks', 'team_logos'] loop
    execute format('create view public.%I with (security_invoker = true) as select * from league.%I where series = public.current_series() with local check option', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on league.%I to authenticated', t);
    execute format('grant all on league.%I to service_role', t);
    execute format('alter table league.%I enable row level security', t);
  end loop;
end
$$;
-- A team's look is public in game, so every member of the series sees every team's.
create policy "series members" on league.team_looks for select to authenticated using (public.in_series(series));
-- Approved logos are public; pending and rejected ones only to the team and the organizer.
create policy "approved, or own team or organizer" on league.team_logos for select to authenticated
  using (public.in_series(series) and (status = 'approved' or public.own_or_organizer(series, team)));
alter publication supabase_realtime add table league.team_looks, league.team_logos;

-- The member's team, if MM's AI runs it (the career team's colours are in the save header).
create function public.my_look_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if exists (select 1 from public.snapshots s, jsonb_array_elements(s.public -> 'teams') t
             where s.id = public.latest_snapshot_id() and t ->> 'name' = me.team and (t ->> 'isPlayerTeam')::boolean) then
    raise exception 'The career team''s colours and logo are set in game';
  end if;
  return me.team;
end
$$;

create function public.set_team_look(primary_colour text, secondary_colour text, tertiary_colour text, trim_colour text, livery_id int) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_look_team();
  c text;
  cid int;
begin
  foreach c in array array[primary_colour, secondary_colour, tertiary_colour, trim_colour] loop
    if c is null or lower(c) !~ '^#[0-9a-f]{6}$' then raise exception 'Colours must look like #c8102e'; end if;
  end loop;
  if not exists (select 1 from public.snapshots s, jsonb_array_elements(coalesce(s.public -> 'championship' -> 'liveries', '[]')) l
                 where s.id = public.latest_snapshot_id() and (l ->> 'id')::int = set_team_look.livery_id) then
    raise exception 'That livery pattern isn''t available in this championship';
  end if;
  -- Update first: an insert ... on conflict would use up a colour row ID on every save.
  update public.team_looks x set
    primary_colour = lower(set_team_look.primary_colour), secondary_colour = lower(set_team_look.secondary_colour),
    tertiary_colour = lower(set_team_look.tertiary_colour), trim_colour = lower(set_team_look.trim_colour),
    livery_id = set_team_look.livery_id, updated_at = now()
    where x.team = t
    returning x.color_id into cid;
  if cid is null then
    insert into public.team_looks as x (team, primary_colour, secondary_colour, tertiary_colour, trim_colour, livery_id)
      values (t, lower(primary_colour), lower(secondary_colour), lower(tertiary_colour), lower(trim_colour), set_team_look.livery_id)
      returning x.color_id into cid;
  end if;
  return cid;
end
$$;

-- After uploading the file to the team-logos bucket. An earlier pending upload is withdrawn.
create function public.submit_team_logo(path text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_look_team();
  oid bigint;
begin
  if path is null or path !~ ('^' || public.current_series() || '/[A-Za-z0-9._-]+\.(png|webp|jpg|jpeg)$') then
    raise exception 'Upload the logo to "%/<file>.png" first', public.current_series();
  end if;
  update public.team_logos x set status = 'withdrawn' where x.team = t and x.status = 'pending';
  insert into public.team_logos (team, path) values (t, submit_team_logo.path) returning id into oid;
  return oid;
end
$$;

create function public.withdraw_team_logo(logo_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_look_team();
begin
  update public.team_logos x set status = 'withdrawn' where x.id = logo_id and x.team = t and x.status = 'pending';
  if not found then raise exception 'No such pending logo'; end if;
end
$$;

-- The organizer approves (replacing the team's current logo) or rejects, with an optional note.
create function public.review_team_logo(logo_id bigint, approve boolean, note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare l public.team_logos;
begin
  if not public.is_organizer() then raise exception 'Only the organizer reviews logos'; end if;
  select * into l from public.team_logos x where x.id = logo_id and x.status = 'pending';
  if l.id is null then raise exception 'No such pending logo'; end if;
  if approve then
    update public.team_logos x set status = 'replaced' where x.team = l.team and x.status = 'approved';
  end if;
  update public.team_logos x set status = case when approve then 'approved' else 'rejected' end,
    note = review_team_logo.note, reviewed_at = now()
    where x.id = l.id;
end
$$;

-- For `mmsave team-mod`: every series' looks and approved logos (the mod serves the whole install),
-- with the team's MM teamID from that series' latest snapshot.
create function public.all_team_identities() returns table (
  series text, team text, team_id int, color_id int, primary_colour text, secondary_colour text,
  tertiary_colour text, trim_colour text, livery_id int, logo_path text, logo_approved_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with teams as (
    select x.series, x.team from league.team_looks x
    union select l.series, l.team from league.team_logos l where l.status = 'approved'
  ), latest as (
    select s.series, max(s.id) as id from league.snapshots s group by s.series
  )
  select t.series, t.team,
    (select (j ->> 'teamID')::int from league.snapshots s join latest on latest.id = s.id, jsonb_array_elements(s.public -> 'teams') j
     where s.series = t.series and j ->> 'name' = t.team),
    k.color_id, k.primary_colour, k.secondary_colour, k.tertiary_colour, k.trim_colour, k.livery_id,
    l.path, l.reviewed_at
  from teams t
  left join league.team_looks k on k.series = t.series and k.team = t.team
  left join league.team_logos l on l.series = t.series and l.team = t.team and l.status = 'approved'
  order by t.series, t.team
$$;

revoke execute on function public.all_team_identities() from public, anon, authenticated;
grant execute on function public.all_team_identities() to service_role;
grant execute on function public.set_team_look(text, text, text, text, int), public.submit_team_logo(text),
  public.withdraw_team_logo(bigint), public.review_team_logo(bigint, boolean, text) to authenticated;

-- Archive and restore include team identities.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders', 'chassis_choices', 'car_investment', 'contract_renewals', 'team_looks', 'team_logos']
$$;

-- Storage (Supabase only; the test database has no storage schema):
-- - team-logos: public read, members upload into their series' folder, 1 MB images.
-- - liveries: MM's livery colour masks, public read, uploaded by `mmsave liveries` (service role).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('team-logos', 'team-logos', true, 1048576, array['image/png', 'image/webp', 'image/jpeg']),
             ('liveries', 'liveries', true, 1048576, array['image/png'])
      on conflict (id) do nothing;
    execute $p$
      create policy "league members upload logos" on storage.objects for insert to authenticated
        with check (bucket_id = 'team-logos' and public.in_series((storage.foldername(name))[1]))
    $p$;
  end if;
end
$$;

commit;
