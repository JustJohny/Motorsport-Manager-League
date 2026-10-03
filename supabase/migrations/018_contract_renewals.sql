-- Expiring contracts: members renew their staff at MM's terms.
--
-- The latest snapshot holds each team's expiring contracts with MM's renewal terms
-- (TeamPrivate.contracts, from src/ops/contracts.ts): asking wage, sign-on fee, and whether MM
-- says they'd talk. Members queue renewals here; `mmsave pull` turns them into renewContract plus
-- the sign-on fee (src/renewal-orders.ts).
-- Rules (the user's, 2026-10-03): renew in the contract's final 12 months, until MM's pre-season
-- starts (contracts.deadline), at MM's asking wage and sign-on fee, for 1..max_contract_years
-- seasons; someone MM says won't talk can't be renewed; no decision = the contract expires; only
-- the sign-on fee is reserved against the budget.
-- Runs in one transaction.

begin;

create table league.contract_renewals (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  person_guid text not null,
  person_name text not null,
  kind text not null,
  years int not null check (years between 1 and 5),
  yearly_wage numeric not null,
  sign_on_fee numeric not null default 0,
  -- The contract's end when ordered (the op refuses if MM changed it since), and the new end.
  end_before text not null,
  new_end text not null,
  snapshot_id bigint not null,
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create unique index one_open_renewal on league.contract_renewals (series, team, person_guid) where status = 'queued';

create view public.contract_renewals with (security_invoker = true) as
  select * from league.contract_renewals where series = public.current_series() with local check option;
revoke all on public.contract_renewals from anon;
grant select on league.contract_renewals to authenticated;
grant all on league.contract_renewals to service_role;
alter table league.contract_renewals enable row level security;
create policy "own team or organizer" on league.contract_renewals for select to authenticated using (public.own_or_organizer(series, team));
alter publication supabase_realtime add table league.contract_renewals;

-- The member's team, if MM's AI runs it (the career team renews in game).
create function public.my_contract_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if exists (select 1 from public.snapshots s, jsonb_array_elements(s.public -> 'teams') t
             where s.id = public.latest_snapshot_id() and t ->> 'name' = me.team and (t ->> 'isPlayerTeam')::boolean) then
    raise exception 'The career team renews its contracts in game';
  end if;
  return me.team;
end
$$;

create function public.renew_contract(person_guid text, years int) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_contract_team();
  contracts jsonb;
  r jsonb;
  today text;
  max_years int := (public.league_settings_row()).max_contract_years;
  fee numeric;
  budget numeric;
  new_end text;
  oid bigint;
begin
  select ts.private -> 'contracts', (ts.private ->> 'budget')::numeric into contracts, budget
    from public.team_snapshots ts where ts.snapshot_id = public.latest_snapshot_id() and ts.team = t;
  select x into r from jsonb_array_elements(coalesce(contracts -> 'renewals', '[]')) x where x ->> 'guid' = renew_contract.person_guid;
  if r is null then raise exception 'That person''s contract isn''t up for renewal'; end if;
  select s.game_date into today from public.snapshots s where s.id = public.latest_snapshot_id();
  if today >= contracts ->> 'deadline' then
    raise exception 'Renewals closed when MM''s pre-season began (%)', left(contracts ->> 'deadline', 10);
  end if;
  if r ->> 'refusal' is not null then raise exception '% won''t renew: %', r ->> 'name', r ->> 'refusal'; end if;
  if years < 1 or years > max_years then raise exception 'A renewal runs 1 to % seasons', max_years; end if;
  if exists (select 1 from public.contract_renewals o where o.team = t and o.person_guid = renew_contract.person_guid and o.status = 'queued') then
    raise exception 'You already renewed %; cancel it first to change it', r ->> 'name';
  end if;
  if exists (select 1 from public.contract_renewals o, public.snapshots s
             where o.team = t and o.person_guid = renew_contract.person_guid and o.status = 'applied'
               and s.id = public.latest_snapshot_id() and o.applied_at > s.created_at) then
    raise exception '% was renewed after the latest publish; wait for the next one', r ->> 'name';
  end if;
  fee := coalesce((r ->> 'signOnFee')::numeric, 0);
  if public.hq_committed(t) + public.bids_committed(t) + fee > coalesce(budget, 0) then
    raise exception 'Not enough budget: the sign-on fee is $% and your orders and leading bids already commit $% of $%',
      to_char(fee, 'FM999,999,999'), to_char(public.hq_committed(t) + public.bids_committed(t), 'FM999,999,999'),
      to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;
  -- The new contract ends on 31 December, `years` seasons after the current end.
  new_end := (left(r ->> 'end', 4)::int + years)::text || '-12-31T00:00:00.0000000';
  insert into public.contract_renewals (team, person_guid, person_name, kind, years, yearly_wage, sign_on_fee, end_before, new_end, snapshot_id)
    values (t, renew_contract.person_guid, r ->> 'name', r ->> 'kind', years, (r ->> 'askingWage')::numeric, fee, r ->> 'end', new_end, public.latest_snapshot_id())
    returning id into oid;
  return oid;
end
$$;

create function public.cancel_renewal(order_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_contract_team();
begin
  update public.contract_renewals o set status = 'cancelled' where o.id = order_id and o.team = t and o.status = 'queued';
  if not found then raise exception 'No such queued renewal'; end if;
end
$$;

-- Queued HQ orders, part designs, engine spending, crew costs, sponsor pay-backs and renewal fees all commit budget.
create or replace function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cost) from public.hq_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(cost) from public.design_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.engine_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.crew_spend where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.sponsor_orders where team = team_name and kind = 'drop' and status = 'queued'), 0)
       + coalesce((select sum(sign_on_fee) from public.contract_renewals where team = team_name and status = 'queued'), 0)
$$;

grant execute on function public.renew_contract(text, int), public.cancel_renewal(bigint) to authenticated;

-- Archive and restore include renewals.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders', 'chassis_choices', 'car_investment', 'contract_renewals']
$$;

commit;
