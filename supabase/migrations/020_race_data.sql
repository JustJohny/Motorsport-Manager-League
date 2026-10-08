-- FIRE Fantasy 20's race data export on the site (src/race-data.ts): per round the classification
-- with times and gaps, every driver's laps by sector, and driver stats. Lap and gap data are public
-- to the series; tyre wear and temperature, fuel, setup quality, form and stamina only to the
-- driver's own team and the organizer. `mmsave publish` uploads it (league.json "gameData").

create table league.race_data (
  series text not null default public.current_series() references public.series on delete cascade,
  round int not null,
  location text not null,
  race_date date not null,
  data jsonb not null,
  uploaded_at timestamptz not null default now(),
  primary key (series, round)
);

create table league.race_data_private (
  series text not null default public.current_series() references public.series on delete cascade,
  round int not null,
  team text not null,
  data jsonb not null,
  primary key (series, round, team),
  foreign key (series, round) references league.race_data on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['race_data', 'race_data_private'] loop
    execute format('create view public.%I with (security_invoker = true) as select * from league.%I where series = public.current_series() with local check option', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on league.%I to authenticated', t);
    execute format('grant all on league.%I to service_role', t);
    execute format('alter table league.%I enable row level security', t);
  end loop;
end
$$;

create policy "series members" on league.race_data for select to authenticated using (public.in_series(series));
create policy "own team or organizer" on league.race_data_private for select to authenticated
  using (public.own_or_organizer(series, team));

-- Upload one round, replacing an earlier upload of it (service role, from `mmsave publish`).
create function public.publish_race_data(p_series text, p_round int, p_location text, p_race_date date, p_data jsonb, p_private jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  delete from league.race_data where series = p_series and round = p_round;
  insert into league.race_data (series, round, location, race_date, data) values (p_series, p_round, p_location, p_race_date, p_data);
  for k in select jsonb_object_keys(p_private) loop
    insert into league.race_data_private (series, round, team, data) values (p_series, p_round, k, p_private -> k);
  end loop;
end
$$;
revoke execute on function public.publish_race_data(text, int, text, date, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.publish_race_data(text, int, text, date, jsonb, jsonb) to service_role;

-- Archive and restore include race data.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders', 'chassis_choices', 'car_investment', 'contract_renewals', 'team_looks', 'team_logos',
    'race_data', 'race_data_private']
$$;
