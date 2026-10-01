-- Phase 4: part design, fitting and improvement. Rules agreed with the user (see HANDOFF.md):
-- - The game builds designs: `mmsave pull` turns a queued design into `startDesign`, MM's own
--   design screen logic, and MM finishes the part with its own stats and time.
-- - One design at a time per team, as in MM. Paid upfront at MM's player price.
-- - Members choose fitting and improvement; the last choice is re-applied on every pull, so the
--   in-game AI's refits and picks between checkpoints never last.
-- The snapshot's private `design` (TeamDesign in src/league-types.ts) holds each team's options.
-- Runs in one transaction.

begin;

create table public.design_orders (
  id bigint generated always as identity primary key,
  team text not null,
  snapshot_id bigint not null references public.snapshots,
  part_type text not null,             -- "FrontWing"
  components int[] not null,           -- component ids from the team's design options
  cost numeric not null,               -- MM's player price, see planDesign in src/part-design.ts
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
-- MM designs one part at a time.
create unique index one_queued_design on public.design_orders (team) where status = 'queued';

-- Which part each car runs. A missing row leaves the car as the game has it.
create table public.part_fitting (
  team text not null,
  car int not null check (car in (0, 1)),
  part_type text not null,
  part_guid text not null,
  updated_at timestamptz not null default now(),
  primary key (team, car, part_type)
);

-- The parts the mechanics improve, and their split (MM's slider: share on performance).
create table public.part_improvement (
  team text primary key,
  performance text[] not null default '{}',
  reliability text[] not null default '{}',
  split numeric not null default 0.5 check (split >= 0 and split <= 1),
  updated_at timestamptz not null default now()
);

-- Queued HQ orders and part designs both commit budget; bids and HQ orders count them through
-- this function (002/003), so it now includes designs.
create or replace function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cost) from public.hq_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(cost) from public.design_orders where team = team_name and status = 'queued'), 0)
$$;

create function public.sorted_ints(a int[]) returns int[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(x order by x), '{}') from unnest(a) x
$$;

-- A design the in-game AI started on a member team after the league began: cancelled and
-- refunded at the next apply, so it doesn't block an order.
create function public.unordered_design(team_name text, cur jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(cur ->> 'start', '') > coalesce(public.league_start(), '9999')
    and not exists (
      select 1 from public.design_orders o
      where o.team = team_name and o.status = 'applied' and o.part_type = cur ->> 'type'
        and public.sorted_ints(o.components) = public.sorted_ints(array(select jsonb_array_elements_text(cur -> 'components')::int)))
$$;

-- Price of a design, as planDesign in src/part-design.ts: materials plus each component's own
-- cost, or (non-engineer components) its slot level's cost. Also checks MM's slot rules.
create function public.design_cost(opts jsonb, ids int[]) returns numeric
language plpgsql stable set search_path = '' as $$
declare
  c jsonb;
  b jsonb;
  slots int[] := array_fill(0, array[(opts -> 'ctx' ->> 'slots')::int]);
  bonus_levels int[] := '{}';
  bonus_used boolean[] := '{}';
  lvl int;
  i int;
  placed boolean;
  total numeric := (opts -> 'ctx' -> 'settings' ->> 'materialsCost')::numeric;
begin
  if coalesce(array_length(ids, 1), 0) = 0 then raise exception 'Choose at least one component'; end if;
  if array_length(ids, 1) <> (select count(distinct x) from unnest(ids) x) then raise exception 'A component is chosen twice'; end if;
  -- Engineer components first (they open bonus slots), then the highest level down.
  for c in
    select x from jsonb_array_elements(opts -> 'components') x
    where (x ->> 'id')::int = any(ids)
    order by (x ->> 'engineer')::boolean desc, (x ->> 'level')::int desc
  loop
    lvl := (c ->> 'level')::int;
    if exists (select 1 from jsonb_array_elements(c -> 'bonuses') y where y ->> 'type' = 'BonusAddRandomLevelComponent') then
      raise exception 'That component isn''t supported by the league';
    end if;
    placed := false;
    for i in 1 .. coalesce(array_length(bonus_levels, 1), 0) loop
      if bonus_levels[i] >= lvl and not bonus_used[i] then bonus_used[i] := true; placed := true; exit; end if;
    end loop;
    if not placed then
      for i in lvl .. coalesce(array_length(slots, 1), 0) loop
        if slots[i] = 0 then slots[i] := (c ->> 'id')::int; placed := true; exit; end if;
      end loop;
    end if;
    if not placed then raise exception 'No free slot for a level % component', lvl; end if;
    for b in select * from jsonb_array_elements(c -> 'bonuses') loop
      if b ->> 'type' in ('BonusUnlockExtraSlot', 'BonusSpecificLevelComponentAddNoDays', 'BonusPerSpecificLevelComponentUsed') then
        bonus_levels := bonus_levels || (b ->> 'value')::numeric::int; bonus_used := bonus_used || false;
      elsif b ->> 'type' in ('BonusCreateTwoParts', 'BonusExtraReliabilityPerDayInProduction') then
        bonus_levels := bonus_levels || lvl; bonus_used := bonus_used || false;
      end if;
    end loop;
    total := total + case
      when (c ->> 'cost')::numeric <> 0 then (c ->> 'cost')::numeric
      when (c ->> 'engineer')::boolean then 0
      else coalesce((opts -> 'ctx' -> 'settings' -> 'costPerLevel' ->> (lvl - 1))::numeric, 0) end;
  end loop;
  if (select count(*) from jsonb_array_elements(opts -> 'components') x where (x ->> 'id')::int = any(ids)) <> array_length(ids, 1) then
    raise exception 'A chosen component isn''t available to your team';
  end if;
  return round(greatest(total, 0));
end
$$;

create function public.order_design(part_type text, components int[]) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  snap bigint := public.latest_snapshot_id();
  priv jsonb;
  opts jsonb;
  cur jsonb;
  budget numeric;
  cost numeric;
  oid bigint;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  select ts.private into priv from public.team_snapshots ts where ts.snapshot_id = snap and ts.team = me.team;
  opts := priv -> 'design' -> 'types' -> order_design.part_type;
  if opts is null then raise exception 'Your team can''t design that part'; end if;
  budget := (priv ->> 'budget')::numeric;

  -- One design at a time: a queued one, one running in game, or one applied since the last publish.
  if exists (select 1 from public.design_orders o where o.team = me.team and o.status = 'queued') then
    raise exception 'You already have a design queued (MM designs one part at a time)';
  end if;
  cur := priv -> 'design' -> 'current';
  if cur is not null and jsonb_typeof(cur) = 'object' and not public.unordered_design(me.team, cur) then
    raise exception 'Your team is still designing a part until %', left(cur ->> 'end', 10);
  end if;
  if exists (select 1 from public.design_orders o, public.snapshots s
             where o.team = me.team and o.status = 'applied' and s.id = snap and o.applied_at > s.created_at) then
    raise exception 'Your last design was started after the latest publish; wait for the next one';
  end if;

  cost := public.design_cost(opts, order_design.components);
  if public.hq_committed(me.team) + public.bids_committed(me.team) + cost > coalesce(budget, 0) then
    raise exception 'Not enough budget: this design costs $% and your orders and leading bids already commit $% of $%',
      to_char(cost, 'FM999,999,999'), to_char(public.hq_committed(me.team) + public.bids_committed(me.team), 'FM999,999,999'),
      to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;

  insert into public.design_orders (team, snapshot_id, part_type, components, cost)
    values (me.team, snap, order_design.part_type, order_design.components, cost)
    returning id into oid;
  return oid;
end
$$;

create function public.cancel_design(order_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  update public.design_orders set status = 'cancelled'
    where id = cancel_design.order_id and status = 'queued' and (team = me.team or public.is_organizer());
  if not found then raise exception 'No queued design to cancel'; end if;
end
$$;

-- A part of the caller's team in the latest snapshot.
create function public.my_part(part_type text, guid text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select p from public.team_snapshots ts, jsonb_array_elements(ts.private -> 'parts' -> part_type) p
  where ts.snapshot_id = public.latest_snapshot_id() and ts.team = (public.my_member()).team and p ->> 'guid' = guid
$$;

create function public.set_fitting(car int, part_type text, part_guid text) returns void
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
  insert into public.part_fitting (team, car, part_type, part_guid) values (me.team, set_fitting.car, set_fitting.part_type, set_fitting.part_guid)
    on conflict on constraint part_fitting_pkey do update set part_guid = excluded.part_guid, updated_at = now();
end
$$;

create function public.set_improvement(performance text[], reliability text[], split numeric) returns void
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
  insert into public.part_improvement (team, performance, reliability, split) values (me.team, performance, reliability, split)
    on conflict (team) do update set performance = excluded.performance, reliability = excluded.reliability,
      split = excluded.split, updated_at = now();
end
$$;

revoke execute on function public.order_design(text, int[]), public.cancel_design(bigint),
  public.set_fitting(int, text, text), public.set_improvement(text[], text[], numeric) from public, anon;
grant execute on function public.order_design(text, int[]), public.cancel_design(bigint),
  public.set_fitting(int, text, text), public.set_improvement(text[], text[], numeric) to authenticated;
revoke execute on function public.unordered_design(text, jsonb), public.my_part(text, text) from public, anon, authenticated;

alter table public.design_orders enable row level security;
alter table public.part_fitting enable row level security;
alter table public.part_improvement enable row level security;
-- Private, like parts themselves.
create policy "own designs or organizer" on public.design_orders for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());
create policy "own fitting or organizer" on public.part_fitting for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());
create policy "own improvement or organizer" on public.part_improvement for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());

alter publication supabase_realtime add table public.design_orders, public.part_fitting, public.part_improvement;

commit;
