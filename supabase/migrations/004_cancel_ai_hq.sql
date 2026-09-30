-- Phase 3b: the in-game AI also runs member teams between races and starts HQ projects with
-- their money. `mmsave pull` cancels and refunds those (cancelUnorderedHq); here a member may
-- order a building the AI is building, since the AI's project is cancelled first.
-- Runs in one transaction.

begin;

-- The league's first published game date. Constructions started before it are left alone.
create function public.league_start() returns text
language sql stable security definer set search_path = '' as $$
  select min(game_date) from public.snapshots
$$;

-- Level a construction is heading to (extract reports BuildingInProgress as level 1).
create function public.target_level(b jsonb) returns int
language sql immutable set search_path = '' as $$
  select case when b ->> 'state' = 'BuildingInProgress' then 1 else (b ->> 'level')::int + 1 end
$$;

-- An AI-started construction: in progress, started after the league began, not ordered.
-- Mirrors unorderedProject in src/league-rules.ts.
create function public.unordered_project(team_name text, b jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select b ->> 'state' in ('BuildingInProgress', 'Upgrading')
    and coalesce(b ->> 'progressStart', '') > coalesce(public.league_start(), '9999')
    and not exists (select 1 from public.hq_orders o
                    where o.team = team_name and o.status = 'applied'
                      and o.building_type = (b ->> 'type')::int and o.to_level = public.target_level(b))
$$;

create or replace function public.order_hq(building_type int) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  snap bigint := public.latest_snapshot_id();
  hq jsonb;
  b jsonb;
  budget numeric;
  lvl int;
  cost numeric;
  weeks int;
  dep jsonb;
  dep_level int;
  oid bigint;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  select ts.private -> 'hq', (ts.private ->> 'budget')::numeric into hq, budget
    from public.team_snapshots ts where ts.snapshot_id = snap and ts.team = me.team;
  select x into b from jsonb_array_elements(hq) x where (x ->> 'type')::int = order_hq.building_type;
  if b is null then raise exception 'Unknown building'; end if;
  -- A construction the AI started after the league began is cancelled and refunded at the next
  -- apply, so it doesn't block an order; one the league ordered (or older than the league) does.
  if b ->> 'state' in ('BuildingInProgress', 'Upgrading') and not public.unordered_project(me.team, b) then
    raise exception '% is already under construction', b ->> 'name';
  end if;
  if exists (select 1 from public.hq_orders o where o.team = me.team and o.building_type = order_hq.building_type and o.status = 'queued') then
    raise exception '% already has a queued order', b ->> 'name';
  end if;

  lvl := case when b ->> 'state' = 'BuildingInProgress' then 0 else (b ->> 'level')::int end;
  if lvl >= (b ->> 'maxLevel')::int then raise exception '% is at its highest level', b ->> 'name'; end if;
  cost := case when lvl = 0 then (b ->> 'initialCost')::numeric else (b -> 'upgradeCosts' ->> (lvl - 1))::numeric end;
  weeks := case when lvl = 0 then (b ->> 'buildWeeks')::int else (b -> 'upgradeWeeks' ->> (lvl - 1))::int end;
  if cost is null or weeks is null or weeks = 0 then raise exception '% can''t be % here', b ->> 'name', case when lvl = 0 then 'built' else 'upgraded' end; end if;

  -- Prerequisites must be finished (a building under construction counts as not built).
  for dep in select * from jsonb_array_elements(b -> 'dependencies') loop
    select case when x ->> 'state' = 'BuildingInProgress' then 0 else (x ->> 'level')::int end into dep_level
      from jsonb_array_elements(hq) x where (x ->> 'type')::int = (dep ->> 'buildingType')::int;
    if coalesce(dep_level, 0) < (dep ->> 'requiredLevel')::int then
      raise exception '% needs % level %', b ->> 'name',
        (select x ->> 'name' from jsonb_array_elements(hq) x where (x ->> 'type')::int = (dep ->> 'buildingType')::int),
        dep ->> 'requiredLevel';
    end if;
  end loop;

  if public.hq_committed(me.team) + public.bids_committed(me.team) + cost > coalesce(budget, 0) then
    raise exception 'Not enough budget: this costs $% and your HQ orders and leading bids already commit $% of $%',
      to_char(cost, 'FM999,999,999'), to_char(public.hq_committed(me.team) + public.bids_committed(me.team), 'FM999,999,999'),
      to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;

  insert into public.hq_orders (team, snapshot_id, building_type, building_name, to_level, cost, weeks)
    values (me.team, snap, order_hq.building_type, b ->> 'name', lvl + 1, cost, weeks)
    returning id into oid;
  return oid;
end
$$;

grant execute on function public.league_start() to authenticated;
revoke execute on function public.unordered_project(text, jsonb) from public, anon, authenticated;

commit;
