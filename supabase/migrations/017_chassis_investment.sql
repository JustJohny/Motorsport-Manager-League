-- Next year's car: MM's two chassis design sliders, and the car fund level.
--
-- Chassis (src/chassis.ts): nose height 0..1 (fuel efficiency ↔ tyre wear) and rear package 0..1
-- (improvability ↔ tyre heating), set in the supplier window, main championship only; at pre-season
-- `pull` emits setChassis after setSuppliers. The suppliers' bounds are applied by the op (they
-- depend on the suppliers finally chosen), so only 0..1 is checked here.
-- Investment: TeamFinanceController's Low/Medium/High car fund, a standing choice re-applied every
-- pull (cash flow only, as in MM).
-- Runs in one transaction.

begin;

create table league.chassis_choices (
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  season int not null,
  nose real not null check (nose between 0 and 1),
  rear real not null check (rear between 0 and 1),
  updated_at timestamptz not null default now(),
  primary key (series, team, season)
);

create table league.car_investment (
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  level int not null check (level between 0 and 2),
  updated_at timestamptz not null default now(),
  primary key (series, team)
);

do $$
declare t text;
begin
  foreach t in array array['chassis_choices', 'car_investment'] loop
    execute format('create view public.%I with (security_invoker = true) as select * from league.%I where series = public.current_series() with local check option', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on league.%I to authenticated', t);
    execute format('grant all on league.%I to service_role', t);
    execute format('alter table league.%I enable row level security', t);
    execute format('create policy "own team or organizer" on league.%I for select to authenticated using (public.own_or_organizer(series, team))', t);
  end loop;
end
$$;
alter publication supabase_realtime add table league.chassis_choices, league.car_investment;

-- The member's team, if MM's AI runs it (the career team designs its car in game).
create function public.my_car_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if exists (select 1 from public.snapshots s, jsonb_array_elements(s.public -> 'teams') t
             where s.id = public.latest_snapshot_id() and t ->> 'name' = me.team and (t ->> 'isPlayerTeam')::boolean) then
    raise exception 'The career team designs its car in game';
  end if;
  return me.team;
end
$$;

create function public.set_chassis(nose real, rear real) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_car_team();
  car jsonb := public.supplier_window_car(t);
begin
  if not coalesce((car ->> 'chassisDesign')::boolean, false) then
    raise exception 'MM''s design sliders are only in the main championship';
  end if;
  if nose not between 0 and 1 or rear not between 0 and 1 then raise exception 'Sliders go from 0 to 1'; end if;
  insert into public.chassis_choices (team, season, nose, rear) values (t, (car ->> 'season')::int, nose, rear)
    on conflict (series, team, season) do update set nose = excluded.nose, rear = excluded.rear, updated_at = now();
end
$$;

create function public.set_car_investment(level int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_car_team();
begin
  if level not between 0 and 2 then raise exception 'Investment is 0 (Low), 1 (Medium) or 2 (High)'; end if;
  insert into public.car_investment (team, level) values (t, level)
    on conflict (series, team) do update set level = excluded.level, updated_at = now();
end
$$;

grant execute on function public.set_chassis(real, real), public.set_car_investment(int) to authenticated;

-- Archive and restore include them.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders', 'chassis_choices', 'car_investment']
$$;

commit;
