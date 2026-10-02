-- Pit crews for member teams, run by the site (src/pit-crew.ts has the rules).
--
-- In MM only the player's career team has crew people; every AI team has one skill and confidence
-- per pit stop task. So the site keeps a full crew for each member AI team: people with skills,
-- confidence, positions and per-race contracts, an applicant list and a funding level. The
-- toolkit creates the starting crews and processes each race at publish (`save_team_crew`), and
-- at pull writes the crew's skills into the save and charges `crew_spend`.
-- The career team's crew stays MM's own, managed in game (shown from the snapshot).
-- Runs in one transaction.

begin;

-- One row per site-run crew: its funding (0 Low, 1 Medium, 2 High) and the last race processed.
create table league.pit_crew_teams (
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  funding int not null default 1 check (funding between 0 and 2),
  processed_round int not null default 0,
  primary key (series, team)
);

-- Crew people. role: PitCrewRole 0..9 (a position) or 11 (reserve).
create table league.pit_crew (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  first_name text not null,
  last_name text not null,
  nationality text not null,
  birth date not null,
  peak date not null,
  -- Tyres, FrontJack, RearJack, FixingParts, Refuelling.
  stats real[] not null check (cardinality(stats) = 5),
  confidence real not null,
  max_confidence real not null,
  decline real not null,
  role int not null check (role between 0 and 9 or role = 11),
  -- Per race.
  wage numeric not null,
  races_left int not null
);
create unique index one_per_position on league.pit_crew (series, team, role) where role <> 11;

create table league.pit_crew_applicants (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  first_name text not null,
  last_name text not null,
  nationality text not null,
  birth date not null,
  peak date not null,
  stats real[] not null check (cardinality(stats) = 5),
  confidence real not null,
  max_confidence real not null,
  decline real not null,
  wage numeric not null,
  -- Races until the application lapses.
  races_left int not null
);

-- Money the crew costs, charged at the next pull: wages and funding per race, sign-on fees.
create table league.crew_spend (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  kind text not null check (kind in ('wages', 'funding', 'signon')),
  description text not null,
  amount numeric not null,
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now()
);

-- What happened to a crew: signings, releases, renewals, contracts ending, retirements.
create table league.pit_crew_log (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  round int,
  message text not null,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log'] loop
    execute format('create view public.%I with (security_invoker = true) as select * from league.%I where series = public.current_series() with local check option', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on league.%I to authenticated', t);
    execute format('grant all on league.%I to service_role', t);
    execute format('alter table league.%I enable row level security', t);
    execute format('create policy "own team or organizer" on league.%I for select to authenticated using (public.own_or_organizer(series, team))', t);
  end loop;
end
$$;
alter publication supabase_realtime add table league.pit_crew_teams, league.pit_crew, league.pit_crew_applicants, league.crew_spend, league.pit_crew_log;

-- Rules mirrored from src/pit-crew.ts (a test checks they agree).
create function public.crew_settings() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('maxCrew', 15, 'signOnFee', 45000, 'renewBelow', 12, 'retireAge', 38, 'fundingCost', jsonb_build_array(0, 50000, 120000))
$$;

-- perRaceWage: about $1K per point of average skill above 2, $3K to $10K.
create function public.crew_wage(stats real[]) returns numeric
language sql immutable set search_path = '' as $$
  select greatest(3, least(10, round((select avg(x)::numeric from unnest(stats) x)) - 2)) * 1000
$$;

-- Queued HQ orders, part designs, engine spending and crew costs all commit budget.
create or replace function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cost) from public.hq_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(cost) from public.design_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.engine_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.crew_spend where team = team_name and status = 'queued'), 0)
$$;

-- The member's site-run crew team (the career team's crew is managed in game).
create function public.my_crew_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if not exists (select 1 from public.pit_crew_teams c where c.team = me.team) then
    raise exception 'Your team''s pit crew isn''t run on the site (the career team''s crew is managed in game)';
  end if;
  return me.team;
end
$$;

-- The latest snapshot's pit crew rule and season length.
create function public.crew_positions() returns int[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array(select jsonb_array_elements_text(s.public -> 'championship' -> 'pitCrew' -> 'roles')::int), array[0, 1, 2, 3, 4, 5])
  from public.snapshots s where s.id = public.latest_snapshot_id()
$$;

create function public.crew_contract_races() returns int
language sql stable security definer set search_path = '' as $$
  select 2 * jsonb_array_length(s.public -> 'championship' -> 'calendar') + 1 from public.snapshots s where s.id = public.latest_snapshot_id()
$$;

create function public.crew_log(team_name text, message text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.pit_crew_log (team, round, message)
    select team_name, (s.public -> 'championship' -> 'lastRace' ->> 'round')::int, message
    from public.snapshots s where s.id = public.latest_snapshot_id()
$$;

-- PitCrewController.AssignRoleToPitCrewMember: whoever holds the position swaps with them.
-- A crew member leaves a position only by someone else taking it.
create function public.set_crew_role(crew_id bigint, role int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_crew_team();
  who public.pit_crew;
  holder bigint;
begin
  select * into who from public.pit_crew c where c.id = crew_id and c.team = t;
  if who.id is null then raise exception 'No such crew member in your team'; end if;
  if set_crew_role.role = 11 then raise exception 'Put someone else in that position instead'; end if;
  if not set_crew_role.role = any(public.crew_positions()) then raise exception 'That position isn''t used in this series'; end if;
  if who.role = set_crew_role.role then return; end if;
  select c.id into holder from public.pit_crew c where c.team = t and c.role = set_crew_role.role;
  -- Free the position first (the unique index allows one person per position).
  update public.pit_crew c set role = 11 where c.id = holder;
  update public.pit_crew c set role = set_crew_role.role where c.id = who.id;
  update public.pit_crew c set role = who.role where c.id = holder;
end
$$;

create function public.set_crew_funding(level int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_crew_team();
begin
  if level not between 0 and 2 then raise exception 'Funding is 0 (Low), 1 (Medium) or 2 (High)'; end if;
  update public.pit_crew_teams c set funding = level where c.team = t;
end
$$;

-- Sign an applicant as a reserve: MM's sign-on fee, reserved against the budget.
create function public.sign_crew_applicant(applicant_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_crew_team();
  a public.pit_crew_applicants;
  fee numeric := (public.crew_settings() ->> 'signOnFee')::numeric;
  budget numeric;
begin
  select * into a from public.pit_crew_applicants x where x.id = applicant_id and x.team = t;
  if a.id is null then raise exception 'That applicant isn''t on your list'; end if;
  if (select count(*) from public.pit_crew c where c.team = t) >= (public.crew_settings() ->> 'maxCrew')::int then
    raise exception 'Your crew is full (% people); release someone first', public.crew_settings() ->> 'maxCrew';
  end if;
  select (ts.private ->> 'budget')::numeric into budget from public.team_snapshots ts
    where ts.snapshot_id = public.latest_snapshot_id() and ts.team = t;
  if public.hq_committed(t) + public.bids_committed(t) + fee > coalesce(budget, 0) then
    raise exception 'Not enough budget: the sign-on fee is $% and your orders and leading bids already commit $% of $%',
      to_char(fee, 'FM999,999,999'), to_char(public.hq_committed(t) + public.bids_committed(t), 'FM999,999,999'), to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;
  insert into public.pit_crew (team, first_name, last_name, nationality, birth, peak, stats, confidence, max_confidence, decline, role, wage, races_left)
    values (t, a.first_name, a.last_name, a.nationality, a.birth, a.peak, a.stats, a.confidence, a.max_confidence, a.decline, 11, a.wage, public.crew_contract_races());
  delete from public.pit_crew_applicants x where x.id = a.id;
  insert into public.crew_spend (team, kind, description, amount) values (t, 'signon', format('%s. %s - Sign On Fee', left(a.first_name, 1), a.last_name), fee);
  perform public.crew_log(t, format('Signed %s %s', a.first_name, a.last_name));
end
$$;

-- Release someone (MM charges nothing). Their position goes to the reserve best at it.
create function public.release_crew(crew_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_crew_team();
  who public.pit_crew;
  sub bigint;
begin
  select * into who from public.pit_crew c where c.id = crew_id and c.team = t;
  if who.id is null then raise exception 'No such crew member in your team'; end if;
  if who.role <> 11 then
    select c.id into sub from public.pit_crew c where c.team = t and c.role = 11 order by c.stats[
      (array[2, 3, 1, 1, 1, 1, 4, 4, 5, 5])[who.role + 1]] desc, c.id limit 1;
    if sub is null then raise exception 'Nobody in reserve to take that position; sign someone first'; end if;
  end if;
  delete from public.pit_crew c where c.id = who.id;
  update public.pit_crew c set role = who.role where c.id = sub;
  perform public.crew_log(t, format('Released %s %s', who.first_name, who.last_name));
end
$$;

-- ContractPitCrew.RenewContract: a fresh contract (twice the season, plus one) at today's wage,
-- once fewer than 12 races are left. Crew at retirement age don't renew.
create function public.renew_crew(crew_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_crew_team();
  who public.pit_crew;
  today date;
begin
  select * into who from public.pit_crew c where c.id = crew_id and c.team = t;
  if who.id is null then raise exception 'No such crew member in your team'; end if;
  if who.races_left >= (public.crew_settings() ->> 'renewBelow')::int then
    raise exception 'Contracts can be renewed with fewer than % races left', public.crew_settings() ->> 'renewBelow';
  end if;
  select left(s.game_date, 10)::date into today from public.snapshots s where s.id = public.latest_snapshot_id();
  if extract(year from age(today, who.birth)) >= (public.crew_settings() ->> 'retireAge')::int then
    raise exception '% % is retiring and won''t sign again', who.first_name, who.last_name;
  end if;
  update public.pit_crew c set races_left = public.crew_contract_races(), wage = public.crew_wage(c.stats) where c.id = who.id;
  perform public.crew_log(t, format('Renewed %s %s', who.first_name, who.last_name));
end
$$;

-- The toolkit's write: a team's whole crew and applicant list (ids kept), the spending and log of
-- the races it processed, and how far it got.
-- Runs as its owner (new ids come from the sequences); only the service role may call it.
create function public.save_team_crew(team_name text, processed_round int, crew jsonb, applicants jsonb, spend jsonb, log jsonb, funding int default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare s text := public.current_series();
begin
  insert into league.pit_crew_teams (series, team, funding, processed_round)
    values (s, team_name, coalesce(funding, 1), processed_round)
    on conflict on constraint pit_crew_teams_pkey do update set processed_round = excluded.processed_round,
      funding = coalesce(save_team_crew.funding, league.pit_crew_teams.funding);
  delete from league.pit_crew c where c.series = s and c.team = team_name;
  insert into league.pit_crew overriding system value
    select coalesce(r.id, nextval(pg_get_serial_sequence('league.pit_crew', 'id'))), s, team_name, r.first_name, r.last_name, r.nationality,
           r.birth, r.peak, r.stats, r.confidence, r.max_confidence, r.decline, r.role, r.wage, r.races_left
    from jsonb_populate_recordset(null::league.pit_crew, crew) r;
  delete from league.pit_crew_applicants a where a.series = s and a.team = team_name;
  insert into league.pit_crew_applicants overriding system value
    select coalesce(r.id, nextval(pg_get_serial_sequence('league.pit_crew_applicants', 'id'))), s, team_name, r.first_name, r.last_name, r.nationality,
           r.birth, r.peak, r.stats, r.confidence, r.max_confidence, r.decline, r.wage, r.races_left
    from jsonb_populate_recordset(null::league.pit_crew_applicants, applicants) r;
  insert into league.crew_spend (series, team, kind, description, amount)
    select s, team_name, r.kind, r.description, r.amount from jsonb_populate_recordset(null::league.crew_spend, spend) r;
  insert into league.pit_crew_log (series, team, round, message)
    select s, team_name, r.round, r.message from jsonb_populate_recordset(null::league.pit_crew_log, log) r;
end
$$;

grant execute on function public.set_crew_role(bigint, int), public.set_crew_funding(int), public.sign_crew_applicant(bigint),
  public.release_crew(bigint), public.renew_crew(bigint) to authenticated;
revoke execute on function public.save_team_crew(text, int, jsonb, jsonb, jsonb, jsonb, int) from public, anon, authenticated;
grant execute on function public.save_team_crew(text, int, jsonb, jsonb, jsonb, jsonb, int) to service_role;

-- Archive and restore include the crew.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log']
$$;

commit;
