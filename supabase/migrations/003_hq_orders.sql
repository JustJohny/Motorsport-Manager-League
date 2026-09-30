-- Phase 3: HQ orders. Members order a new building or an upgrade at any time; the price is
-- MM's own and is paid when the organizer applies it (`mmsave pull`), which starts the
-- construction in game with MM's build time (weeks) times league_settings.hq_speed.
-- Runs in one transaction.

begin;

alter table public.league_settings add column hq_speed numeric not null default 1;

create table public.hq_orders (
  id bigint generated always as identity primary key,
  team text not null,
  snapshot_id bigint not null references public.snapshots,
  building_type int not null,
  building_name text not null,
  to_level int not null,               -- 1 = build it; otherwise the level after the upgrade
  cost numeric not null,
  weeks int not null,                  -- MM's build time, before hq_speed
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
-- One queued order per building.
create unique index one_queued_order on public.hq_orders (team, building_type) where status = 'queued';

-- What a team's queued HQ orders will cost.
create function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(cost), 0) from public.hq_orders where team = team_name and status = 'queued'
$$;

-- What a team's leading bids in the running window commit.
create function public.bids_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(b.cost), 0) from public.transfer_windows w, public.leading_bids(w.id) b
  where w.status = 'open' and b.team = team_name
$$;

create function public.order_hq(building_type int) returns bigint
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
  if b ->> 'state' in ('BuildingInProgress', 'Upgrading') then raise exception '% is already under construction', b ->> 'name'; end if;
  if exists (select 1 from public.hq_orders o where o.team = me.team and o.building_type = order_hq.building_type and o.status = 'queued') then
    raise exception '% already has a queued order', b ->> 'name';
  end if;

  lvl := (b ->> 'level')::int;
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

create function public.cancel_hq(order_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  update public.hq_orders set status = 'cancelled'
    where id = cancel_hq.order_id and status = 'queued' and (team = me.team or public.is_organizer());
  if not found then raise exception 'No queued order to cancel'; end if;
end
$$;

-- Bids now also count queued HQ orders against the budget.
create or replace function public.place_bid(auction_id bigint, yearly_wage numeric, years int, replacing_guid text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  s public.league_settings := public.league_settings_row();
  a public.auctions;
  w public.transfer_windows;
  game_date text;
  budget numeric;
  replaced record;
  required numeric;
  cost numeric;
  committed numeric;
  bid_id bigint;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  -- Lock the auction so two bids on it can't both pass the minimum check.
  select * into a from public.auctions where id = place_bid.auction_id for update;
  if a.id is null then raise exception 'Unknown auction'; end if;
  select * into w from public.transfer_windows where id = a.window_id;
  if w.status <> 'open' or now() >= w.closes_at then raise exception 'The transfer window is closed'; end if;
  if years < 1 or years > s.max_contract_years then raise exception 'Contract length must be 1 to % seasons', s.max_contract_years; end if;
  if a.leading_team = me.team then raise exception 'You are already the highest bidder'; end if;

  required := case when a.leading_wage is null then a.min_wage
                   else ceil(a.leading_wage * (1 + s.min_increment_pct) / 1000) * 1000 end;
  if yearly_wage < required then raise exception 'The minimum bid is $%', to_char(required, 'FM999,999,999'); end if;

  -- The replaced person must be in the bidder's team, in the same role.
  select st -> 'person' ->> 'name' as name, (st -> 'person' -> 'contract' ->> 'yearlyWages')::numeric as wage
    into replaced
    from public.snapshots sn, jsonb_array_elements(sn.public -> 'teams') t, jsonb_array_elements(t -> 'staff') st
    where sn.id = w.snapshot_id and t ->> 'name' = me.team and st -> 'person' ->> 'guid' = replacing_guid
      and st ->> 'job' = case a.kind when 'Engineer' then 'EngineerLead' else a.kind end;
  if replaced.name is null then raise exception 'Choose a % from your team to replace', lower(a.kind); end if;
  if exists (select 1 from public.leading_bids(w.id) b
             where b.team = me.team and b.auction_id <> a.id and b.replacing_guid = place_bid.replacing_guid) then
    raise exception '% is already being replaced by another auction you lead', replaced.name;
  end if;

  -- Budget: everything this team would pay if every auction it leads closed now.
  select sn.public ->> 'gameDate' into game_date from public.snapshots sn where sn.id = w.snapshot_id;
  select (ts.private ->> 'budget')::numeric into budget from public.team_snapshots ts
    where ts.snapshot_id = w.snapshot_id and ts.team = me.team;
  cost := public.bid_cost(yearly_wage, a.buyout, replaced.wage, game_date);
  -- Other leading bids plus queued HQ orders (003).
  select coalesce(sum(b.cost), 0) + public.hq_committed(me.team) into committed
    from public.leading_bids(w.id) b where b.team = me.team and b.auction_id <> a.id;
  if committed + cost > coalesce(budget, 0) then
    raise exception 'Not enough budget: this bid needs $% and your leading bids and HQ orders already commit $% of $%',
      to_char(cost, 'FM999,999,999'), to_char(committed, 'FM999,999,999'), to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;

  insert into public.bids (auction_id, team, yearly_wage, years, replacing_guid, replacing_name, replacing_wage, cost)
    values (a.id, me.team, yearly_wage, years, replacing_guid, replaced.name, replaced.wage, cost)
    returning id into bid_id;
  update public.auctions set leading_team = me.team, leading_wage = yearly_wage, leading_years = years,
    bid_count = bid_count + 1, updated_at = now() where id = a.id;
  return bid_id;
end
$$;

revoke execute on function public.order_hq(int), public.cancel_hq(bigint) from public, anon;
grant execute on function public.order_hq(int), public.cancel_hq(bigint) to authenticated;
revoke execute on function public.hq_committed(text), public.bids_committed(text) from public, anon, authenticated;

alter table public.hq_orders enable row level security;
-- HQ plans are private, like HQ itself.
create policy "own orders or organizer" on public.hq_orders for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());

alter publication supabase_realtime add table public.hq_orders;

commit;
