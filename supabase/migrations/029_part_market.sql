-- The part market: members sell customer copies of their parts to other members.
--
-- Rules (the user's, 2026-10-13; src/part-market.ts):
-- - Listed parts: the organizer picks, per season, the part types every team must design itself
--   (Front Wing and Rear Wing until they choose). Those can't be sold or bought.
-- - A seller lists one of their own parts at a price. The listing shows the customer spec: 90 %
--   of the part's gain over the series' floor stat, the same reliability, components and risk.
-- - A buyer takes one or two copies, optionally fitted to their cars. The price is reserved from
--   their budget; `mmsave pull` delivers the copies (copyPart) and moves the money: the buyer
--   pays the price, the seller gets it minus MM's materials cost per copy.
-- - Copies are for this season: the market closes once its last race is run, and the toolkit
--   takes them back then (removeCustomerParts).
-- Runs in one transaction.

begin;

create table league.part_market_rules (
  series text not null default public.current_series() references public.series on delete cascade,
  season int not null,
  -- Part types ("FrontWing") teams must design themselves this season.
  listed text[] not null,
  updated_at timestamptz not null default now(),
  primary key (series, season)
);

create table league.part_listings (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  part_type text not null,
  part_guid text not null,
  price numeric not null check (price >= 0),
  -- What the buyer gets, as of the listing's snapshot: name, level, stat, reliability, maxReliability, risk, components.
  preview jsonb not null,
  snapshot_id bigint not null,
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  created_at timestamptz not null default now()
);
create unique index one_active_listing on league.part_listings (series, part_guid) where status = 'active';

create table league.part_purchases (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  listing_id bigint not null references league.part_listings,
  buyer text not null,
  seller text not null,
  part_type text not null,
  part_guid text not null,
  copies int not null check (copies in (1, 2)),
  price_each numeric not null,
  -- MM's materials cost (player price), paid by the seller per copy.
  materials_each numeric not null,
  -- The copies' GUIDs, chosen here so the fitting can follow them (CUSTOMER_GUID_PREFIX).
  guids text[] not null,
  -- The buyer's car for each copy, in order; fewer entries than copies leave the rest in storage.
  fit_cars int[] not null default '{}',
  snapshot_id bigint not null,
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create unique index one_open_purchase on league.part_purchases (series, listing_id, buyer) where status = 'queued';

do $$
declare t text;
begin
  foreach t in array array['part_market_rules', 'part_listings', 'part_purchases'] loop
    execute format('create view public.%I with (security_invoker = true) as select * from league.%I where series = public.current_series() with local check option', t, t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on league.%I to authenticated', t);
    execute format('grant all on league.%I to service_role', t);
    execute format('alter table league.%I enable row level security', t);
  end loop;
end
$$;
-- The market and its rules are public within the league; a deal only to its two teams.
create policy "series members" on league.part_market_rules for select to authenticated using (public.in_series(series));
create policy "series members" on league.part_listings for select to authenticated using (public.in_series(series));
create policy "buyer, seller or organizer" on league.part_purchases for select to authenticated
  using (public.own_or_organizer(series, buyer) or public.own_or_organizer(series, seller));
alter publication supabase_realtime add table league.part_market_rules, league.part_listings, league.part_purchases;

-- Queued purchases commit the buyer's budget like orders.
create or replace function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cost) from public.hq_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(cost) from public.design_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.engine_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.crew_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.sponsor_orders where team = team_name and kind = 'drop' and status = 'queued'), 0)
       + coalesce((select sum(sign_on_fee) from public.contract_renewals where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(price_each * copies) from public.part_purchases where buyer = team_name and status = 'queued'), 0)
$$;

-- The season the market is in: the published game date's year.
create function public.part_market_season() returns int
language sql stable security definer set search_path = '' as $$
  select left(game_date, 4)::int from public.snapshots where id = public.latest_snapshot_id()
$$;

-- This season's listed parts: the organizer's latest choice up to it, else the aero.
create function public.listed_parts(season int default null) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select r.listed from public.part_market_rules r
     where r.season <= coalesce(listed_parts.season, public.part_market_season()) order by r.season desc limit 1),
    array['FrontWing', 'RearWing'])
$$;

create function public.set_listed_parts(season int, listed text[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_organizer() then raise exception 'Only the organizer sets the listed parts'; end if;
  if exists (select 1 from unnest(listed) x where x not in ('Brakes', 'Engine', 'FrontWing', 'Gearbox', 'RearWing', 'Suspension')) then
    raise exception 'Unknown part type';
  end if;
  insert into league.part_market_rules (series, season, listed)
    values (public.current_series(), set_listed_parts.season, (select coalesce(array_agg(distinct x), '{}') from unnest(listed) x))
    on conflict on constraint part_market_rules_pkey do update set listed = excluded.listed, updated_at = now();
end
$$;

-- Open while this season still has a race to run (copies go back once the last one is done).
create function public.part_market_open() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(s.game_date < coalesce(s.public -> 'championship' ->> 'seasonEnd', '9999'), false)
    and exists (select 1 from jsonb_array_elements(coalesce(s.public -> 'championship' -> 'calendar', '[]')) e
                where not coalesce((e ->> 'ended')::boolean, false))
  from public.snapshots s where s.id = public.latest_snapshot_id()
$$;

create function public.team_private(team_name text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select ts.private from public.team_snapshots ts where ts.snapshot_id = public.latest_snapshot_id() and ts.team = team_name
$$;

-- A part a team can sell: its own (not a copy), not banned, and not built by MM's AI since the
-- league began (those are removed at the next apply).
create function public.sellable_part(team_name text, part_type text, guid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb;
begin
  select x into p from jsonb_array_elements(coalesce(public.team_private(team_name) -> 'parts' -> part_type, '[]')) x where x ->> 'guid' = guid;
  if p is null then raise exception 'That part isn''t in the latest publish'; end if;
  if guid like 'c0c0c0c0-%' then raise exception 'Customer parts can''t be sold on'; end if;
  if coalesce((p ->> 'banned')::boolean, false) then raise exception 'That part is banned'; end if;
  if p ->> 'buildDate' > coalesce(public.league_start(), '9999') and jsonb_array_length(coalesce(p -> 'componentIds', '[]')) > 0
     and not exists (select 1 from public.design_orders o
                     where o.team = team_name and o.status <> 'cancelled' and o.part_type = sellable_part.part_type
                       and public.sorted_ints(o.components) = public.sorted_ints(array(select jsonb_array_elements_text(p -> 'componentIds')::int))) then
    raise exception 'That part was built by MM''s AI and goes at the next apply';
  end if;
  return p;
end
$$;

create function public.check_market_type(team_name text, part_type text) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare materials numeric;
begin
  if not public.part_market_open() then raise exception 'The part market is closed until next season'; end if;
  if part_type = any(public.listed_parts()) then raise exception 'That part is listed this season: every team designs its own'; end if;
  if coalesce(public.team_private(team_name) -> 'design' -> 'specParts', '[]') ? part_type then raise exception 'That part is spec in this series'; end if;
  materials := (public.team_private(team_name) -> 'design' -> 'types' -> part_type -> 'ctx' -> 'settings' ->> 'materialsCost')::numeric;
  if materials is null then raise exception 'That part can''t be built in this series'; end if;
  return materials;
end
$$;

create function public.list_part(part_type text, part_guid text, price numeric) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  p jsonb;
  materials numeric;
  stat_floor numeric;
  oid bigint;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  materials := public.check_market_type(me.team, list_part.part_type);
  p := public.sellable_part(me.team, list_part.part_type, list_part.part_guid);
  if price < materials then
    raise exception 'The price must cover the materials, $%', to_char(materials, 'FM999,999,999');
  end if;
  if price > 1000000000 then raise exception 'That price is too high'; end if;
  if exists (select 1 from public.part_listings l where l.part_guid = list_part.part_guid and l.status = 'active') then
    raise exception 'That part is already on the market';
  end if;
  select coalesce((s.public -> 'championship' -> 'partFloor' ->> list_part.part_type)::numeric, 0) into stat_floor
    from public.snapshots s where s.id = public.latest_snapshot_id();
  insert into public.part_listings (team, part_type, part_guid, price, preview, snapshot_id)
    values (me.team, list_part.part_type, list_part.part_guid, round(price), jsonb_build_object(
      'name', p ->> 'name', 'level', (p ->> 'level')::int,
      -- customerStat in src/part-market.ts
      'stat', round(stat_floor + 0.9 * greatest(0, coalesce((p ->> 'stat')::numeric, 0) + coalesce((p ->> 'performance')::numeric, 0) - stat_floor)),
      'reliability', (p ->> 'reliability')::numeric, 'maxReliability', (p ->> 'maxReliability')::numeric,
      'risk', coalesce((p ->> 'rulesRisk')::numeric, 0), 'components', jsonb_array_length(coalesce(p -> 'componentIds', '[]')),
      'materials', materials),
      public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

-- Take a part off the market; its open purchases are cancelled (their money freed).
create function public.withdraw_listing(listing_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  update public.part_listings set status = 'withdrawn'
    where id = withdraw_listing.listing_id and status = 'active' and (team = me.team or public.is_organizer());
  if not found then raise exception 'No active listing to withdraw'; end if;
  update public.part_purchases p set status = 'cancelled' where p.listing_id = withdraw_listing.listing_id and p.status = 'queued';
end
$$;

create function public.buy_part(listing_id bigint, copies int, fit_cars int[] default '{}') returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  l public.part_listings;
  materials numeric;
  budget numeric;
  cost numeric;
  oid bigint;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  select * into l from public.part_listings x where x.id = buy_part.listing_id and x.status = 'active';
  if l.id is null then raise exception 'That part is no longer on the market'; end if;
  if l.team = me.team then raise exception 'That''s your own part'; end if;
  if copies not in (1, 2) then raise exception 'Buy one or two copies'; end if;
  if coalesce(cardinality(fit_cars), 0) > copies or exists (select 1 from unnest(fit_cars) c where c not in (0, 1))
     or cardinality(fit_cars) <> (select count(distinct c) from unnest(fit_cars) c) then
    raise exception 'Fit each copy to a different car (1 or 2)';
  end if;
  materials := public.check_market_type(l.team, l.part_type);
  perform public.check_market_type(me.team, l.part_type);
  perform public.sellable_part(l.team, l.part_type, l.part_guid);
  if exists (select 1 from public.part_purchases p where p.listing_id = l.id and p.buyer = me.team and p.status = 'queued') then
    raise exception 'You already bought this part; cancel that first to change it';
  end if;
  cost := l.price * copies;
  budget := (public.team_private(me.team) ->> 'budget')::numeric;
  if public.hq_committed(me.team) + public.bids_committed(me.team) + cost > coalesce(budget, 0) then
    raise exception 'Not enough budget: this costs $% and your orders and leading bids already commit $% of $%',
      to_char(cost, 'FM999,999,999'), to_char(public.hq_committed(me.team) + public.bids_committed(me.team), 'FM999,999,999'),
      to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;
  insert into public.part_purchases (listing_id, buyer, seller, part_type, part_guid, copies, price_each, materials_each, guids, fit_cars, snapshot_id)
    values (l.id, me.team, l.team, l.part_type, l.part_guid, copies, l.price, materials,
      array(select 'c0c0c0c0-' || substr(gen_random_uuid()::text, 10) from generate_series(1, copies)),
      coalesce(fit_cars, '{}'), public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

create function public.cancel_purchase(purchase_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  update public.part_purchases set status = 'cancelled'
    where id = cancel_purchase.purchase_id and status = 'queued' and (buyer = me.team or public.is_organizer());
  if not found then raise exception 'No queued purchase to cancel'; end if;
end
$$;

-- `mmsave pull --mark-applied`: purchases delivered, and each chosen car's fitting moved to its copy
-- (the copies' GUIDs were fixed at purchase), so the next pull keeps them on.
create function public.mark_purchases_applied(ids bigint[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare r public.part_purchases;
begin
  for r in update public.part_purchases set status = 'applied', applied_at = now()
           where id = any(ids) and status = 'queued' returning * loop
    insert into league.part_fitting (series, team, car, part_type, part_guid)
      select r.series, r.buyer, c.car, r.part_type, r.guids[c.i] from unnest(r.fit_cars) with ordinality c(car, i) where c.i <= r.copies
      on conflict on constraint part_fitting_pkey do update set part_guid = excluded.part_guid, updated_at = now();
  end loop;
end
$$;
revoke execute on function public.mark_purchases_applied(bigint[]) from public, anon, authenticated;
grant execute on function public.mark_purchases_applied(bigint[]) to service_role;

revoke execute on function public.set_listed_parts(int, text[]), public.list_part(text, text, numeric), public.withdraw_listing(bigint),
  public.buy_part(bigint, int, int[]), public.cancel_purchase(bigint), public.listed_parts(int), public.part_market_open() from public, anon;
grant execute on function public.set_listed_parts(int, text[]), public.list_part(text, text, numeric), public.withdraw_listing(bigint),
  public.buy_part(bigint, int, int[]), public.cancel_purchase(bigint), public.listed_parts(int), public.part_market_open() to authenticated;
revoke execute on function public.part_market_season(), public.team_private(text), public.sellable_part(text, text, text),
  public.check_market_type(text, text) from public, anon, authenticated;

commit;
