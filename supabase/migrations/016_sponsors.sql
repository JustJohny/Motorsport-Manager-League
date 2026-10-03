-- Sponsors: members sign MM's own offers and decide on deals MM's AI signed for them.
--
-- The latest snapshot holds each team's deals and offers (TeamPrivate.sponsorship; what's on the
-- car is public in TeamPublic.sponsors). Members queue choices here; `mmsave pull` turns them into
-- signSponsor / dropSponsor changes plus the upfront money (src/sponsor-orders.ts).
-- Rules (the user's, 2026-10-03): MM's offers only; several teams may sign the same sponsor; no
-- early exit from a deal; a deal the AI signed since the league began can be kept or dropped, and
-- dropping it pays back its upfront money.
-- Runs in one transaction.

begin;

create table league.sponsor_orders (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  -- sign: an offer; drop: an AI deal, upfront paid back; keep: an AI deal the member keeps.
  kind text not null check (kind in ('sign', 'drop', 'keep')),
  slot int not null check (slot between 0 and 5),
  sponsor_id text not null,
  sponsor_name text not null,
  -- The deal's upfront money: received on sign, paid back on drop.
  amount numeric not null default 0,
  -- sign: the game date the offer lapses (SponsorOffer.expires).
  expires text,
  snapshot_id bigint not null,
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled', 'expired', 'kept')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
-- One open choice per slot.
create unique index one_open_sponsor_order on league.sponsor_orders (series, team, slot, kind) where status = 'queued';

create view public.sponsor_orders with (security_invoker = true) as
  select * from league.sponsor_orders where series = public.current_series() with local check option;
revoke all on public.sponsor_orders from anon;
grant select on league.sponsor_orders to authenticated;
grant all on league.sponsor_orders to service_role;
alter table league.sponsor_orders enable row level security;
create policy "own team or organizer" on league.sponsor_orders for select to authenticated using (public.own_or_organizer(series, team));
alter publication supabase_realtime add table league.sponsor_orders;

-- The member's team, if MM's AI runs it (the career team signs sponsors in game).
create function public.my_sponsor_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if exists (select 1 from public.snapshots s, jsonb_array_elements(s.public -> 'teams') t
             where s.id = public.latest_snapshot_id() and t ->> 'name' = me.team and (t ->> 'isPlayerTeam')::boolean) then
    raise exception 'The career team signs its sponsors in game';
  end if;
  return me.team;
end
$$;

create function public.my_sponsorship(team_name text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select ts.private -> 'sponsorship' from public.team_snapshots ts
  where ts.snapshot_id = public.latest_snapshot_id() and ts.team = team_name
$$;

-- A deal MM's AI signed: its offer is from the league's start or later and no league order signed it.
-- (Deals from the career start carry no offer date.)
create function public.ai_sponsor_deal(team_name text, deal jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(deal ->> 'offerDate', '') >= coalesce(public.league_start(), '9999')
    and not exists (
      select 1 from public.sponsor_orders o
      where o.team = team_name and o.kind = 'sign' and o.status = 'applied'
        and o.slot = (deal ->> 'slot')::int and o.sponsor_id = deal ->> 'sponsorId')
$$;

create function public.sponsor_deal_in(team_name text, slot int) returns jsonb
language sql stable security definer set search_path = '' as $$
  select d from jsonb_array_elements(coalesce(public.my_sponsorship(team_name) -> 'deals', '[]')) d where (d ->> 'slot')::int = slot
$$;

-- A slot changed by an order applied after the latest publish: the snapshot doesn't show it yet.
create function public.sponsor_slot_stale(team_name text, slot int) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sponsor_orders o, public.snapshots s
                 where o.team = team_name and o.slot = sponsor_slot_stale.slot and o.status = 'applied'
                   and s.id = public.latest_snapshot_id() and o.applied_at > s.created_at)
$$;

create function public.sign_sponsor(slot int, sponsor_id text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_sponsor_team();
  offer jsonb;
  deal jsonb := public.sponsor_deal_in(t, sign_sponsor.slot);
  today text;
  oid bigint;
begin
  select o into offer from jsonb_array_elements(coalesce(public.my_sponsorship(t) -> 'offers', '[]')) o
    where (o ->> 'slot')::int = sign_sponsor.slot and o ->> 'sponsorId' = sign_sponsor.sponsor_id;
  if offer is null then raise exception 'That offer isn''t on your list'; end if;
  select s.game_date into today from public.snapshots s where s.id = public.latest_snapshot_id();
  if offer ->> 'expires' <= today then raise exception 'That offer has lapsed'; end if;
  if public.sponsor_slot_stale(t, sign_sponsor.slot) then
    raise exception 'That slot changed after the latest publish; wait for the next one';
  end if;
  if deal is not null and not exists (select 1 from public.sponsor_orders o
      where o.team = t and o.kind = 'drop' and o.status = 'queued' and o.slot = sign_sponsor.slot) then
    raise exception 'That slot already has a sponsor (%); deals run until they end', deal ->> 'sponsor';
  end if;
  if exists (select 1 from public.sponsor_orders o where o.team = t and o.kind = 'sign' and o.status = 'queued' and o.slot = sign_sponsor.slot) then
    raise exception 'You already chose a sponsor for that slot; cancel it first';
  end if;
  insert into public.sponsor_orders (team, kind, slot, sponsor_id, sponsor_name, amount, expires, snapshot_id)
    values (t, 'sign', sign_sponsor.slot, sign_sponsor.sponsor_id, offer ->> 'sponsor', (offer ->> 'upfront')::numeric, offer ->> 'expires', public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

-- Drop a deal MM's AI signed. Its upfront money goes back, so it's reserved against the budget.
create function public.drop_sponsor(slot int) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_sponsor_team();
  deal jsonb := public.sponsor_deal_in(t, drop_sponsor.slot);
  amount numeric;
  budget numeric;
  oid bigint;
begin
  if deal is null then raise exception 'That slot has no sponsor'; end if;
  if not public.ai_sponsor_deal(t, deal) then raise exception 'Deals run until they end; only deals MM''s AI signed for you can be dropped'; end if;
  if public.sponsor_slot_stale(t, drop_sponsor.slot) then
    raise exception 'That slot changed after the latest publish; wait for the next one';
  end if;
  if exists (select 1 from public.sponsor_orders o where o.team = t and o.kind = 'drop' and o.status = 'queued' and o.slot = drop_sponsor.slot) then
    raise exception 'That deal is already being dropped';
  end if;
  amount := coalesce((deal ->> 'upfront')::numeric, 0);
  select (ts.private ->> 'budget')::numeric into budget from public.team_snapshots ts
    where ts.snapshot_id = public.latest_snapshot_id() and ts.team = t;
  if public.hq_committed(t) + public.bids_committed(t) + amount > coalesce(budget, 0) then
    raise exception 'Not enough budget: dropping % pays back $% and your orders and leading bids already commit $% of $%',
      deal ->> 'sponsor', to_char(amount, 'FM999,999,999'), to_char(public.hq_committed(t) + public.bids_committed(t), 'FM999,999,999'),
      to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;
  update public.sponsor_orders o set status = 'cancelled'
    where o.team = t and o.kind = 'keep' and o.status = 'kept' and o.slot = drop_sponsor.slot;
  insert into public.sponsor_orders (team, kind, slot, sponsor_id, sponsor_name, amount, snapshot_id)
    values (t, 'drop', drop_sponsor.slot, deal ->> 'sponsorId', deal ->> 'sponsor', amount, public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

-- Keep a deal MM's AI signed: the site stops asking.
create function public.keep_sponsor(slot int) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_sponsor_team();
  deal jsonb := public.sponsor_deal_in(t, keep_sponsor.slot);
  oid bigint;
begin
  if deal is null then raise exception 'That slot has no sponsor'; end if;
  if not public.ai_sponsor_deal(t, deal) then raise exception 'Only deals MM''s AI signed for you need a decision'; end if;
  -- Changing your mind: a queued drop (and a sign that relied on it) is cancelled.
  update public.sponsor_orders o set status = 'cancelled'
    where o.team = t and o.status = 'queued' and o.slot = keep_sponsor.slot and o.kind in ('drop', 'sign');
  select o.id into oid from public.sponsor_orders o
    where o.team = t and o.kind = 'keep' and o.status = 'kept' and o.slot = keep_sponsor.slot and o.sponsor_id = deal ->> 'sponsorId';
  if oid is not null then return oid; end if;
  insert into public.sponsor_orders (team, kind, slot, sponsor_id, sponsor_name, snapshot_id, status)
    values (t, 'keep', keep_sponsor.slot, deal ->> 'sponsorId', deal ->> 'sponsor', public.latest_snapshot_id(), 'kept')
    returning id into oid;
  return oid;
end
$$;

-- Cancel a queued sign or drop, or undo a keep (the deal is flagged again).
create function public.cancel_sponsor_order(order_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_sponsor_team();
  o public.sponsor_orders;
begin
  select * into o from public.sponsor_orders x where x.id = order_id and x.team = t and x.status in ('queued', 'kept');
  if o.id is null then raise exception 'No such open sponsor choice'; end if;
  update public.sponsor_orders x set status = 'cancelled' where x.id = o.id;
  -- A sign into a slot that was being freed goes with the drop.
  if o.kind = 'drop' then
    update public.sponsor_orders x set status = 'cancelled'
      where x.team = t and x.kind = 'sign' and x.status = 'queued' and x.slot = o.slot;
  end if;
end
$$;

-- Queued HQ orders, part designs, engine spending, crew costs and sponsor pay-backs all commit budget.
create or replace function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cost) from public.hq_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(cost) from public.design_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.engine_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.crew_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.sponsor_orders where team = team_name and kind = 'drop' and status = 'queued'), 0)
$$;

grant execute on function public.sign_sponsor(int, text), public.drop_sponsor(int), public.keep_sponsor(int),
  public.cancel_sponsor_order(bigint), public.ai_sponsor_deal(text, jsonb) to authenticated;

-- Archive and restore include sponsor choices.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders']
$$;

commit;
