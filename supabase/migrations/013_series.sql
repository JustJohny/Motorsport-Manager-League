-- Several series (one MM save each) on one site, and ending a series to start fresh.
--
-- Every league table moves to the `league` schema and gets a `series` column. In `public`, a view
-- with the old name shows only the current series, so every existing function keeps working,
-- scoped to one series:
-- - The site and the toolkit send the series in the `x-series` request header
--   (`public.current_series()` reads it; `app.series` overrides it).
-- - New rows get it through the column default.
-- Row-level security on the tables checks the row's own series, so realtime (which has no request
-- headers) also only sends members the rows of series they're in.
-- Data from before this migration becomes the series "main".
-- Runs in one transaction.

begin;

create schema league;
grant usage on schema league to authenticated, service_role;

create table public.series (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  created_at timestamptz not null default now()
);

create function public.current_series() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('app.series', true), ''),
                  nullif(current_setting('request.headers', true), '')::json ->> 'x-series')
$$;

-- The league so far.
insert into public.series (id, name)
  select 'main', coalesce((select s.public -> 'championship' ->> 'name' from public.snapshots s order by s.id desc limit 1), 'League')
  where exists (select 1 from public.snapshots) or exists (select 1 from public.league_members);

-- ---------------------------------------------------------------------------------------------
-- Move the tables and add `series`.

do $$
declare t text;
begin
  foreach t in array array[
    'league_members', 'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices'
  ] loop
    execute format('alter table public.%I set schema league', t);
    execute format('alter table league.%I add column series text references public.series on delete cascade', t);
    execute format('update league.%I set series = ''main'' where exists (select 1 from public.series where id = ''main'')', t);
    -- A fresh database has only the default league_settings row; publishing makes one per series.
    execute format('delete from league.%I where series is null', t);
    execute format('alter table league.%I alter column series set not null, alter column series set default public.current_series()', t);
    -- Policies moved with the table; they're replaced below.
    execute (select coalesce(string_agg(format('drop policy %I on league.%I;', p.policyname, t), ' '), '')
             from pg_policies p where p.schemaname = 'league' and p.tablename = t);
  end loop;
end
$$;

-- The league settings row: one per series. A new series gets one when it's first published.
alter table league.league_settings drop constraint league_settings_pkey, add constraint league_settings_pkey primary key (series);

-- Keys and unique rules per series (team names repeat across saves).
alter table league.league_members drop constraint league_members_pkey, add constraint league_members_pkey primary key (series, discord_username);
alter table league.part_fitting drop constraint part_fitting_pkey, add constraint part_fitting_pkey primary key (series, team, car, part_type);
alter table league.part_improvement drop constraint part_improvement_pkey, add constraint part_improvement_pkey primary key (series, team);
alter table league.rule_votes drop constraint rule_votes_pkey, add constraint rule_votes_pkey primary key (series, team, season, rule_id);
alter table league.rule_vote_results drop constraint rule_vote_results_pkey, add constraint rule_vote_results_pkey primary key (series, season, rule_id);
alter table league.next_rule_overrides drop constraint next_rule_overrides_pkey, add constraint next_rule_overrides_pkey primary key (series, season, rule_group);
alter table league.supplier_choices drop constraint supplier_choices_pkey, add constraint supplier_choices_pkey primary key (series, team, season, supplier_type);
alter table league.engine_plans drop constraint engine_plans_team_fkey;
alter table league.engine_builds drop constraint engine_builds_team_fkey;
alter table league.engine_customers drop constraint engine_customers_owner_fkey;
alter table league.engine_programmes drop constraint engine_programmes_pkey, add constraint engine_programmes_pkey primary key (series, team);
alter table league.engine_plans drop constraint engine_plans_pkey, add constraint engine_plans_pkey primary key (series, team, season),
  add constraint engine_plans_team_fkey foreign key (series, team) references league.engine_programmes on delete cascade;
alter table league.engine_builds drop constraint engine_builds_pkey, add constraint engine_builds_pkey primary key (series, team, season),
  add constraint engine_builds_team_fkey foreign key (series, team) references league.engine_programmes on delete cascade;
alter table league.engine_customers drop constraint engine_customers_pkey, add constraint engine_customers_pkey primary key (series, customer, season),
  add constraint engine_customers_owner_fkey foreign key (series, owner) references league.engine_programmes on delete cascade;
drop index league.one_active_window;
create unique index one_active_window on league.transfer_windows (series) where status = 'open';
drop index league.one_queued_order;
create unique index one_queued_order on league.hq_orders (series, team, building_type) where status = 'queued';
drop index league.one_queued_design;
create unique index one_queued_design on league.design_orders (series, team) where status = 'queued';

-- ---------------------------------------------------------------------------------------------
-- The current series' rows, under the old names.

do $$
declare t text;
begin
  foreach t in array array[
    'league_members', 'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices'
  ] loop
    execute format('create view public.%I with (security_invoker = true) as select * from league.%I where series = public.current_series() with local check option', t, t);
    execute format('revoke all on public.%I from anon', t);
    -- Reads go through the view (and realtime through the table); RLS below decides which rows.
    execute format('grant select on league.%I to authenticated', t);
    execute format('grant all on league.%I to service_role', t);
  end loop;
end
$$;

-- bid_history shows every bid of the series, without who each team would release. It runs as its
-- owner, so it reads the table (the series view would apply the member's own row rules).
drop view public.bid_history;
create view public.bid_history with (security_invoker = false) as
  select id, auction_id, team, yearly_wage, years, created_at from league.bids
  where series = public.current_series() and public.is_member();
revoke all on public.bid_history from anon;
grant select on public.bid_history to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row-level security by the row's own series.

create function public.member_in(s text) returns league.league_members
language sql stable security definer set search_path = '' as $$
  select * from league.league_members m where m.series = s and m.discord_username = public.current_discord_username()
$$;

create function public.in_series(s text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (public.member_in(s)).team is not null
$$;

create function public.own_or_organizer(s text, row_team text) returns boolean
language sql stable security definer set search_path = '' as $$
  select m.team = row_team or m.role = 'organizer' from public.member_in(s) m
$$;

create function public.organizes_any() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from league.league_members m where m.discord_username = public.current_discord_username() and m.role = 'organizer')
$$;

do $$
declare t text;
begin
  -- Everyone in the series sees these.
  foreach t in array array[
    'league_members', 'snapshots', 'market_snapshots', 'league_settings', 'transfer_windows', 'auctions',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides', 'engine_programmes', 'engine_customers'
  ] loop
    execute format('create policy "series members" on league.%I for select to authenticated using (public.in_series(series))', t);
  end loop;
  -- The team's own rows, and the organizer's.
  foreach t in array array[
    'team_snapshots', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'engine_plans', 'engine_builds', 'engine_spend', 'supplier_choices'
  ] loop
    execute format('create policy "own team or organizer" on league.%I for select to authenticated using (public.own_or_organizer(series, team))', t);
  end loop;
end
$$;

drop policy "own login or organizer" on public.logins;
create policy "own login or organizer" on public.logins
  for select to authenticated using (user_id = auth.uid() or public.organizes_any());

alter table public.series enable row level security;
create policy "series members" on public.series for select to authenticated using (public.in_series(id));

-- The policies call these as the logged-in user; they only reveal the caller's own membership.
revoke execute on function public.member_in(text), public.own_or_organizer(text, text), public.in_series(text), public.organizes_any() from public, anon;
grant execute on function public.member_in(text), public.own_or_organizer(text, text), public.in_series(text), public.organizes_any() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Functions that upsert by a named key now write the table directly, with the series.

create or replace function public.set_fitting(car int, part_type text, part_guid text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  other text;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if set_fitting.car not in (0, 1) then raise exception 'Car must be 0 or 1'; end if;
  if public.my_part(set_fitting.part_type, set_fitting.part_guid) is null then raise exception 'Your team has no such part'; end if;
  -- What the other car will run: its fitting choice, else what the game has fitted.
  select coalesce(
    (select f.part_guid from public.part_fitting f where f.team = me.team and f.car = 1 - set_fitting.car and f.part_type = set_fitting.part_type),
    (select p ->> 'guid' from public.team_snapshots ts, jsonb_array_elements(ts.private -> 'parts' -> set_fitting.part_type) p
     where ts.snapshot_id = public.latest_snapshot_id() and ts.team = me.team and (p ->> 'fittedToCar')::int = 1 - set_fitting.car))
    into other;
  if other = set_fitting.part_guid then
    raise exception 'That part is on car %; fit another part there first', 2 - set_fitting.car;
  end if;
  insert into league.part_fitting (series, team, car, part_type, part_guid)
    values (me.series, me.team, set_fitting.car, set_fitting.part_type, set_fitting.part_guid)
    on conflict on constraint part_fitting_pkey do update set part_guid = excluded.part_guid, updated_at = now();
end
$$;

create or replace function public.set_improvement(performance text[], reliability text[], split numeric) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  priv jsonb;
  slots int;
  g text;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  select ts.private into priv from public.team_snapshots ts where ts.snapshot_id = public.latest_snapshot_id() and ts.team = me.team;
  slots := (priv -> 'design' -> 'improvement' ->> 'slots')::int;
  if slots is null then raise exception 'Your team''s data has no improvement info yet'; end if;
  if coalesce(array_length(performance, 1), 0) > slots or coalesce(array_length(reliability, 1), 0) > slots then
    raise exception 'At most % parts per list (Factory level)', slots;
  end if;
  if split < 0 or split > 1 then raise exception 'Split must be between 0 and 1'; end if;
  foreach g in array performance || reliability loop
    if not exists (select 1 from jsonb_each(priv -> 'parts') t, jsonb_array_elements(t.value) p where p ->> 'guid' = g) then
      raise exception 'Your team has no such part';
    end if;
  end loop;
  if cardinality(performance) <> (select count(distinct x) from unnest(performance) x)
     or cardinality(reliability) <> (select count(distinct x) from unnest(reliability) x) then
    raise exception 'A part is listed twice';
  end if;
  insert into league.part_improvement (series, team, performance, reliability, split)
    values (me.series, me.team, set_improvement.performance, set_improvement.reliability, set_improvement.split)
    on conflict on constraint part_improvement_pkey do update set performance = excluded.performance, reliability = excluded.reliability,
      split = excluded.split, updated_at = now();
end
$$;

create or replace function public.cast_rule_vote(rule_id int, choice text, extra_power int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  regs jsonb := public.latest_regulations();
  v_season int := (regs ->> 'season')::int;
  power int;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if not exists (select 1 from jsonb_array_elements(regs -> 'votes') v
                 where (v ->> 'ruleId')::int = cast_rule_vote.rule_id and v ->> 'status' = 'upcoming') then
    raise exception 'That vote isn''t open';
  end if;
  if exists (select 1 from public.rule_vote_results r where r.season = v_season and r.rule_id = cast_rule_vote.rule_id) then
    raise exception 'That vote has already been decided';
  end if;
  if choice not in ('yes', 'no', 'abstain') then raise exception 'Vote yes, no or abstain'; end if;
  if choice = 'abstain' and extra_power > 0 then raise exception 'Abstaining uses no vote power'; end if;
  select (t ->> 'votingPower')::int into power from jsonb_array_elements(regs -> 'teams') t where t ->> 'team' = me.team;
  if extra_power < 0 or extra_power > coalesce(power, 0) then
    raise exception 'You can add at most % vote power', coalesce(power, 0);
  end if;
  insert into league.rule_votes (series, team, season, rule_id, choice, extra_power)
    values (me.series, me.team, v_season, cast_rule_vote.rule_id, cast_rule_vote.choice, cast_rule_vote.extra_power)
    on conflict on constraint rule_votes_pkey do update set choice = excluded.choice, extra_power = excluded.extra_power, updated_at = now();
end
$$;

create or replace function public.set_next_rule(rule_group text, rule_id int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  regs jsonb := public.latest_regulations();
  v_season int := (regs ->> 'season')::int;
begin
  if not public.is_organizer() then raise exception 'Only the organizer can change next season''s rules'; end if;
  if rule_id is null then
    delete from public.next_rule_overrides o where o.season = v_season and o.rule_group = set_next_rule.rule_group;
    return;
  end if;
  if (regs -> 'rules' -> (rule_id::text) ->> 'group') is distinct from rule_group then
    raise exception 'Rule % is not in group %', rule_id, rule_group;
  end if;
  insert into league.next_rule_overrides (series, season, rule_group, rule_id)
    values (public.current_series(), v_season, set_next_rule.rule_group, set_next_rule.rule_id)
    on conflict on constraint next_rule_overrides_pkey do update set rule_id = excluded.rule_id, updated_at = now();
end
$$;

create or replace function public.choose_supplier(supplier_type text, supplier_id int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  car jsonb;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  car := public.supplier_window_car(me.team);
  if not exists (select 1 from jsonb_array_elements(car -> 'options' -> supplier_type) o
                 where (o ->> 'id')::int = choose_supplier.supplier_id) then
    raise exception 'That supplier isn''t available to your team';
  end if;
  insert into league.supplier_choices (series, team, season, supplier_type, supplier_id)
    values (me.series, me.team, (car ->> 'season')::int, choose_supplier.supplier_type, choose_supplier.supplier_id)
    on conflict on constraint supplier_choices_pkey do update set supplier_id = excluded.supplier_id, updated_at = now();
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Publishing creates the series; the organizer's toolkit ends one.

drop function public.publish_snapshot(jsonb, jsonb);
create function public.publish_snapshot(members jsonb, snapshot jsonb, series_name text default null) returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  s text := public.current_series();
  sid bigint;
begin
  if s is null then raise exception 'No series: send the x-series header (the "series" in league.json)'; end if;
  insert into public.series (id, name) values (s, coalesce(series_name, snapshot -> 'public' -> 'championship' ->> 'name', s))
    on conflict (id) do update set name = coalesce(publish_snapshot.series_name, public.series.name);
  insert into league.league_settings (series) values (s) on conflict do nothing;

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

-- Delete a series and everything in it (after `mmsave archive` has saved a backup).
create function public.end_series(series_id text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  delete from public.series where id = series_id;
  if not found then raise exception 'No series %', series_id; end if;
end
$$;

-- Everything in the current series, for `mmsave archive` (a JSON backup before end_series), and
-- the way back. Tables are listed parents first, so a restore satisfies the foreign keys.
create function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices']
$$;

create function public.export_series() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  s text := public.current_series();
  out jsonb;
  t text;
  rows jsonb;
begin
  select jsonb_build_object('series', to_jsonb(x), 'exportedAt', now(), 'tables', '{}'::jsonb) into out from public.series x where x.id = s;
  if out is null then raise exception 'No series %', coalesce(s, '(none: send x-series)'); end if;
  foreach t in array public.series_tables() loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) - ''series''), ''[]'') from league.%I r where r.series = $1', t) into rows using s;
    out := jsonb_set(out, array['tables', t], rows);
  end loop;
  return out;
end
$$;

-- Restore an export into a series that doesn't exist (any more): its id from the backup, or `as_id`.
-- Row ids are kept, so restore after end_series, not next to the original.
create function public.import_series(backup jsonb, as_id text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  s text := coalesce(as_id, backup -> 'series' ->> 'id');
  t text;
  seq text;
begin
  if exists (select 1 from public.series where id = s) then raise exception 'Series % already exists; end it first or pick another id', s; end if;
  insert into public.series (id, name, created_at) values (s, backup -> 'series' ->> 'name', coalesce((backup -> 'series' ->> 'created_at')::timestamptz, now()));
  foreach t in array public.series_tables() loop
    execute format('insert into league.%1$I overriding system value select * from jsonb_populate_recordset(null::league.%1$I, '
                   || '(select coalesce(jsonb_agg(r || jsonb_build_object(''series'', $1)), ''[]'') from jsonb_array_elements($2) r))', t)
      using s, coalesce(backup -> 'tables' -> t, '[]');
    -- Keep identity columns ahead of the restored ids.
    seq := case when exists (select 1 from information_schema.columns c where c.table_schema = 'league' and c.table_name = t and c.column_name = 'id')
                then pg_get_serial_sequence(format('league.%I', t), 'id') end;
    if seq is not null then
      execute format('select setval(%L, greatest((select coalesce(max(id), 0) from league.%I), (select last_value from %s)))', seq, t, seq);
    end if;
  end loop;
end
$$;

-- The series the logged-in user is in, for the site's series switcher.
create function public.my_series() returns table (id text, name text, team text, role text)
language sql stable security definer set search_path = '' as $$
  select s.id, s.name, m.team, m.role from league.league_members m join public.series s on s.id = m.series
  where m.discord_username = public.current_discord_username() order by s.created_at, s.id
$$;

revoke execute on function public.publish_snapshot(jsonb, jsonb, text), public.end_series(text), public.export_series(), public.import_series(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.publish_snapshot(jsonb, jsonb, text), public.end_series(text), public.export_series(), public.import_series(jsonb, text)
  to service_role;
revoke execute on function public.my_series() from public, anon;
grant execute on function public.my_series() to authenticated;

commit;
