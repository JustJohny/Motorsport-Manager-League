-- The league's pre-season (the user's rules, 2026-10-09). While the organizer has it open:
-- - members sign free agents straight away: first come wins, no sign-on fee, at the market's
--   opening wage (min_wage), for 1..max_contract_years seasons;
-- - they rearrange their own team: promote the reserve, swap the drivers' cars, swap the
--   mechanics, release anyone (a released race driver, engineer or mechanic stays unless someone
--   is signed into the seat before the pull);
-- - they pick this season's suppliers (FF20: every supplier of the tier), for free.
-- Moves are kept in order; `mmsave pull` replays them (src/preseason.ts). Only free agents of the
-- latest publish can be signed: people released now reach the market at the next publish.
-- Runs in one transaction.

begin;

alter table league.league_settings add column preseason boolean not null default false;
-- The series view lists the table's columns as they were when it was made; add the new one.
create or replace view public.league_settings with (security_invoker = true) as
  select * from league.league_settings where series = public.current_series() with local check option;

create table league.preseason_moves (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  kind text not null check (kind in ('sign', 'promote', 'swapCars', 'swapMechanics', 'release')),
  person_guid text,
  person_name text,
  other_guid text,
  other_name text,
  years int check (years between 1 and 5),
  yearly_wage numeric,
  new_end text,
  -- The free agent as published, so the site can show them in their new seat.
  person jsonb,
  snapshot_id bigint not null,
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz
);
-- First come wins: one queued signing per free agent in the series.
create unique index one_signing_per_person on league.preseason_moves (series, person_guid) where kind = 'sign' and status = 'queued';

create view public.preseason_moves with (security_invoker = true) as
  select * from league.preseason_moves where series = public.current_series() with local check option;
revoke all on public.preseason_moves from anon;
grant select on league.preseason_moves to authenticated;
grant all on league.preseason_moves to service_role;
alter table league.preseason_moves enable row level security;
-- Signings and line-ups are public, as MM's team screens are.
create policy "series members" on league.preseason_moves for select to authenticated using (public.in_series(series));
alter publication supabase_realtime add table league.preseason_moves;

create table league.preseason_suppliers (
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  supplier_type text not null,
  supplier_id int not null,
  supplier_name text not null,
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  primary key (series, team, supplier_type)
);
create view public.preseason_suppliers with (security_invoker = true) as
  select * from league.preseason_suppliers where series = public.current_series() with local check option;
revoke all on public.preseason_suppliers from anon;
grant select on league.preseason_suppliers to authenticated;
grant all on league.preseason_suppliers to service_role;
alter table league.preseason_suppliers enable row level security;
create policy "own team or organizer" on league.preseason_suppliers for select to authenticated using (public.own_or_organizer(series, team));
alter publication supabase_realtime add table league.preseason_suppliers;

-- ---------------------------------------------------------------------------------------------

create function public.set_preseason(open boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_organizer() then raise exception 'Only the organizer can open or close the pre-season'; end if;
  update public.league_settings set preseason = set_preseason.open;
  if not found then raise exception 'Publish a snapshot first'; end if;
end
$$;

-- The caller's team, if the pre-season is open and MM's AI runs it (the career team is played in game).
create function public.my_preseason_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if not coalesce((public.league_settings_row()).preseason, false) then raise exception 'The pre-season is closed'; end if;
  if exists (select 1 from public.snapshots s, jsonb_array_elements(s.public -> 'teams') t
             where s.id = public.latest_snapshot_id() and t ->> 'name' = me.team and (t ->> 'isPlayerTeam')::boolean) then
    raise exception 'The career team is managed in game';
  end if;
  return me.team;
end
$$;

-- Someone on the team: in the latest snapshot, or signed by its queued moves.
create function public.preseason_staff(team_name text, guid text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s -> 'person' from public.snapshots sn, jsonb_array_elements(sn.public -> 'teams') t, jsonb_array_elements(t -> 'staff') s
       where sn.id = public.latest_snapshot_id() and t ->> 'name' = team_name and s -> 'person' ->> 'guid' = guid),
    (select m.person from public.preseason_moves m
       where m.team = team_name and m.kind = 'sign' and m.status = 'queued' and m.person_guid = guid))
$$;

create function public.preseason_sign(person_guid text, replacing_guid text, years int) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_preseason_team();
  p jsonb;
  r jsonb;
  today text;
  max_years int := (public.league_settings_row()).max_contract_years;
  oid bigint;
begin
  select x into p from public.market_snapshots m, jsonb_array_elements(m.free_agents) x
    where m.snapshot_id = public.latest_snapshot_id() and x ->> 'guid' = preseason_sign.person_guid;
  if p is null then raise exception 'Only free agents can be signed in pre-season'; end if;
  if exists (select 1 from public.preseason_moves m where m.kind = 'sign' and m.person_guid = preseason_sign.person_guid
             and (m.status = 'queued' or (m.status = 'applied'
                  and m.applied_at > (select s.created_at from public.snapshots s where s.id = public.latest_snapshot_id())))) then
    raise exception '% has already been signed by %', p ->> 'name',
      (select m.team from public.preseason_moves m where m.kind = 'sign' and m.person_guid = preseason_sign.person_guid
         and m.status in ('queued', 'applied') order by m.id desc limit 1);
  end if;
  if years < 1 or years > max_years then raise exception 'A contract runs 1 to % seasons', max_years; end if;
  if replacing_guid is not null then
    r := public.preseason_staff(t, replacing_guid);
    if r is null then raise exception 'That person isn''t on your team'; end if;
    if r ->> 'kind' <> p ->> 'kind' then
      raise exception '% (%) can''t replace % (%)', p ->> 'name', lower(p ->> 'kind'), r ->> 'name', lower(r ->> 'kind');
    end if;
  end if;
  select s.game_date into today from public.snapshots s where s.id = public.latest_snapshot_id();
  insert into public.preseason_moves (team, kind, person_guid, person_name, other_guid, other_name, years, yearly_wage, new_end, person, snapshot_id)
    values (t, 'sign', preseason_sign.person_guid, p ->> 'name', replacing_guid, r ->> 'name', years, public.min_wage(p),
            (left(today, 4)::int + years - 1)::text || '-12-31T00:00:00.0000000', p, public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

-- Own-team moves. The order and the seats are checked when they're replayed (src/preseason.ts),
-- where a move that no longer fits is skipped with a warning; here only that the people are on the team.
create function public.preseason_move(kind text, person_guid text, other_guid text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_preseason_team();
  p jsonb;
  o jsonb;
  oid bigint;
begin
  if kind not in ('promote', 'swapCars', 'swapMechanics', 'release') then raise exception 'Unknown move %', kind; end if;
  if kind in ('promote', 'release') then
    p := public.preseason_staff(t, person_guid);
    if p is null then raise exception 'That person isn''t on your team'; end if;
  end if;
  if kind = 'promote' then
    o := public.preseason_staff(t, other_guid);
    if o is null or o ->> 'kind' <> 'Driver' or p ->> 'kind' <> 'Driver' then raise exception 'Promote swaps two of your drivers'; end if;
  end if;
  insert into public.preseason_moves (team, kind, person_guid, person_name, other_guid, other_name, snapshot_id)
    values (t, kind, case when kind in ('promote', 'release') then person_guid end, p ->> 'name',
            case when kind = 'promote' then other_guid end, o ->> 'name', public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

-- Take back the team's latest queued move (a signing frees the free agent again).
create function public.preseason_undo() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_preseason_team();
begin
  update public.preseason_moves m set status = 'cancelled'
    where m.id = (select max(x.id) from public.preseason_moves x where x.team = t and x.status = 'queued');
  if not found then raise exception 'Nothing to undo'; end if;
end
$$;

-- This season's suppliers: any of the team's options in the latest snapshot.
create function public.preseason_supplier(supplier_type text, supplier_id int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_preseason_team();
  o jsonb;
begin
  select x into o from public.team_snapshots ts, jsonb_array_elements(ts.private -> 'design' -> 'currentCar' -> 'options' -> supplier_type) x
    where ts.snapshot_id = public.latest_snapshot_id() and ts.team = t and (x ->> 'id')::int = preseason_supplier.supplier_id;
  if o is null then raise exception 'That supplier isn''t available to your team'; end if;
  -- Into the table itself: ON CONFLICT doesn't work through the series view.
  insert into league.preseason_suppliers (team, supplier_type, supplier_id, supplier_name)
    values (t, preseason_supplier.supplier_type, preseason_supplier.supplier_id, o ->> 'name')
    on conflict on constraint preseason_suppliers_pkey do update
      set supplier_id = excluded.supplier_id, supplier_name = excluded.supplier_name, updated_at = now(), applied_at = null;
end
$$;

-- Back to the car's current supplier (a pick not yet applied).
create function public.clear_preseason_supplier(supplier_type text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_preseason_team();
begin
  delete from public.preseason_suppliers s where s.team = t and s.supplier_type = clear_preseason_supplier.supplier_type and s.applied_at is null;
end
$$;

revoke execute on function public.my_preseason_team(), public.preseason_staff(text, text) from public, anon, authenticated;
revoke execute on function public.set_preseason(boolean), public.preseason_sign(text, text, int), public.preseason_move(text, text, text),
  public.preseason_undo(), public.preseason_supplier(text, int), public.clear_preseason_supplier(text) from public, anon;
grant execute on function public.set_preseason(boolean), public.preseason_sign(text, text, int), public.preseason_move(text, text, text),
  public.preseason_undo(), public.preseason_supplier(text, int), public.clear_preseason_supplier(text) to authenticated;

-- Archive and restore include the pre-season.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders', 'chassis_choices', 'car_investment', 'contract_renewals', 'team_looks', 'team_logos',
    'race_data', 'race_data_private', 'preseason_moves', 'preseason_suppliers']
$$;

commit;
