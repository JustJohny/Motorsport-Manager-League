-- Phase 2: staff auction in a fixed transfer window.
-- Members open auctions on free agents or AI teams' staff and bid a yearly wage, a contract length
-- and who the signing replaces. All rules are enforced here; `mmsave pull` turns the winners
-- into `hire` + `adjustBudget` changes. Runs in one transaction.

begin;

-- Tunable league rules (one row). The site reads these to show prices before bidding.
create table public.league_settings (
  id int primary key default 1 check (id = 1),
  sign_on_fee_pct numeric not null default 0.25,     -- of the yearly wage, paid when the window closes
  min_increment_pct numeric not null default 0.05,   -- each bid beats the leader by at least this
  -- Opening price = base[kind] * (stat average / 10) ^ exponent, rounded to $10K, at least the floor.
  min_wage_base jsonb not null default '{"Driver": 1500000, "Engineer": 250000, "Mechanic": 300000}',
  min_wage_exponent numeric not null default 2,
  min_wage_floor numeric not null default 50000,
  max_contract_years int not null default 3
);
insert into public.league_settings default values;

create table public.transfer_windows (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references public.snapshots,
  opens_at timestamptz not null default now(),
  closes_at timestamptz not null,
  -- open: bidding until closes_at. applied: the organizer has pulled the results into a save.
  status text not null default 'open' check (status in ('open', 'applied'))
);
-- At most one window that hasn't been applied yet.
create unique index one_active_window on public.transfer_windows ((true)) where status = 'open';

create table public.auctions (
  id bigint generated always as identity primary key,
  window_id bigint not null references public.transfer_windows on delete cascade,
  person_guid text not null,
  person jsonb not null,               -- the Person as published, frozen when the auction opened
  kind text not null check (kind in ('Driver', 'Engineer', 'Mechanic')),
  from_team text,                      -- null: free agent; otherwise the AI team they leave
  min_wage numeric not null,
  buyout numeric not null default 0,   -- remaining contract value, paid to the AI team
  opened_by text not null,
  created_at timestamptz not null default now(),
  -- The leader, kept here so every member gets live updates through this table's RLS.
  leading_team text,
  leading_wage numeric,
  leading_years int,
  bid_count int not null default 0,
  updated_at timestamptz not null default now(),
  unique (window_id, person_guid)
);

create table public.bids (
  id bigint generated always as identity primary key,
  auction_id bigint not null references public.auctions on delete cascade,
  team text not null,
  yearly_wage numeric not null,
  years int not null,
  replacing_guid text not null,        -- private: only the bidding team and the organizer see it
  replacing_name text not null,
  replacing_wage numeric not null,
  cost numeric not null,               -- what this bid commits from the budget (see bid_cost)
  created_at timestamptz not null default now()
);
create index on public.bids (auction_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Helpers

create function public.league_settings_row() returns public.league_settings
language sql stable security definer set search_path = '' as $$
  select * from public.league_settings where id = 1
$$;

create function public.latest_snapshot_id() returns bigint
language sql stable security definer set search_path = '' as $$
  select max(id) from public.snapshots
$$;

-- Game dates look like "2016-08-11T06:00:00.0000000".
create function public.game_ts(d text) returns timestamp
language sql immutable set search_path = '' as $$
  select left(d, 19)::timestamp
$$;

-- Fraction of the game year left after `game_date` (wages are yearly; seasons end 31 Dec).
create function public.season_left(game_date text) returns numeric
language sql immutable set search_path = '' as $$
  select greatest(0, extract(epoch from (make_timestamp(extract(year from public.game_ts(game_date))::int, 12, 31, 0, 0, 0)
                                         - public.game_ts(game_date))) / (365 * 86400))::numeric
$$;

create function public.stat_average(person jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(avg(value::numeric), 0) from jsonb_each_text(person -> 'stats') where value is not null
$$;

create function public.min_wage(person jsonb) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(s.min_wage_floor,
                  round((s.min_wage_base ->> (person ->> 'kind'))::numeric
                        * power(public.stat_average(person) / 10, s.min_wage_exponent), -4))
  from public.league_settings s where s.id = 1
$$;

-- Remaining contract value: yearly wage times the years left until the contract ends.
create function public.buyout(person jsonb, game_date text) returns numeric
language sql immutable set search_path = '' as $$
  select round(greatest(0, (person -> 'contract' ->> 'yearlyWages')::numeric
               * extract(epoch from (public.game_ts(person -> 'contract' ->> 'end') - public.game_ts(game_date)))
               / (365.25 * 86400)), -3)
$$;

-- What a bid commits: sign-on fee + buyout + the extra wage over the replaced person for the
-- rest of this season.
create function public.bid_cost(wage numeric, buyout numeric, replacing_wage numeric, game_date text) returns numeric
language sql stable set search_path = '' as $$
  select round(wage * (public.league_settings_row()).sign_on_fee_pct
               + buyout
               + greatest(0, wage - replacing_wage) * public.season_left(game_date))
$$;

-- A person in a snapshot: free agent (team null) or staff of a league team.
create function public.find_person(snap_id bigint, guid text, out person jsonb, out team text, out job text)
language sql stable security definer set search_path = '' as $$
  select p, null::text, 'Unemployed' from public.market_snapshots m, jsonb_array_elements(m.free_agents) p
    where m.snapshot_id = snap_id and p ->> 'guid' = guid
  union all
  select s -> 'person', t ->> 'name', s ->> 'job'
    from public.snapshots sn, jsonb_array_elements(sn.public -> 'teams') t, jsonb_array_elements(t -> 'staff') s
    where sn.id = snap_id and s -> 'person' ->> 'guid' = guid
  limit 1
$$;

-- The bid currently leading each auction of a window. A team can't bid while it leads, so the
-- leader's latest bid is the leading one.
create function public.leading_bids(win_id bigint) returns setof public.bids
language sql stable security definer set search_path = '' as $$
  select b.* from public.auctions a
  join lateral (select * from public.bids b where b.auction_id = a.id and b.team = a.leading_team
                order by b.created_at desc, b.id desc limit 1) b on true
  where a.window_id = win_id
$$;

create function public.open_window_row() returns public.transfer_windows
language sql stable security definer set search_path = '' as $$
  select * from public.transfer_windows where status = 'open'
$$;

-- ---------------------------------------------------------------------------------------------
-- Actions (called by the site)

create function public.open_window(closes_at timestamptz) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare wid bigint;
begin
  if not public.is_organizer() then raise exception 'Only the organizer can open a transfer window'; end if;
  if closes_at <= now() then raise exception 'The deadline must be in the future'; end if;
  if public.latest_snapshot_id() is null then raise exception 'Publish a snapshot first'; end if;
  if exists (select 1 from public.transfer_windows where status = 'open') then
    raise exception 'A transfer window is already open or waiting to be applied';
  end if;
  insert into public.transfer_windows (snapshot_id, closes_at) values (public.latest_snapshot_id(), closes_at)
    returning id into wid;
  return wid;
end
$$;

-- Move the deadline, e.g. to close bidding now. Only while the window hasn't been applied.
create function public.set_window_deadline(closes_at timestamptz) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_organizer() then raise exception 'Only the organizer can change the deadline'; end if;
  update public.transfer_windows w set closes_at = set_window_deadline.closes_at where w.status = 'open';
  if not found then raise exception 'No open transfer window'; end if;
end
$$;

create function public.open_auction(person_guid text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  w public.transfer_windows := public.open_window_row();
  found_person record;
  game_date text;
  aid bigint;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if w.id is null or now() >= w.closes_at then raise exception 'The transfer window is closed'; end if;
  select id into aid from public.auctions a where a.window_id = w.id and a.person_guid = open_auction.person_guid;
  if aid is not null then return aid; end if;

  select * into found_person from public.find_person(w.snapshot_id, person_guid);
  if found_person.person is null then raise exception 'Unknown person'; end if;
  if found_person.job not in ('Unemployed', 'Driver', 'EngineerLead', 'Mechanic') then
    raise exception 'Only drivers, lead engineers and mechanics can be signed';
  end if;
  if found_person.team = me.team then raise exception '% already works for you', found_person.person ->> 'name'; end if;
  if exists (select 1 from public.league_members m where m.team = found_person.team) then
    raise exception '% is under contract at a member team', found_person.person ->> 'name';
  end if;

  select public ->> 'gameDate' into game_date from public.snapshots where id = w.snapshot_id;
  insert into public.auctions (window_id, person_guid, person, kind, from_team, min_wage, buyout, opened_by)
    values (w.id, person_guid, found_person.person, found_person.person ->> 'kind', found_person.team,
            public.min_wage(found_person.person),
            case when found_person.team is null then 0 else public.buyout(found_person.person, game_date) end,
            me.team)
    returning id into aid;
  return aid;
end
$$;

create function public.place_bid(auction_id bigint, yearly_wage numeric, years int, replacing_guid text) returns bigint
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
  select coalesce(sum(b.cost), 0) into committed
    from public.leading_bids(w.id) b where b.team = me.team and b.auction_id <> a.id;
  if committed + cost > coalesce(budget, 0) then
    raise exception 'Not enough budget: this bid needs $% and your leading bids already commit $% of $%',
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

-- Bid history without who each team would release.
create view public.bid_history with (security_invoker = false) as
  select id, auction_id, team, yearly_wage, years, created_at from public.bids where public.is_member();

-- ---------------------------------------------------------------------------------------------
-- Permissions

revoke execute on function public.open_window(timestamptz), public.set_window_deadline(timestamptz),
  public.open_auction(text), public.place_bid(bigint, numeric, int, text) from public, anon;
grant execute on function public.open_window(timestamptz), public.set_window_deadline(timestamptz),
  public.open_auction(text), public.place_bid(bigint, numeric, int, text) to authenticated;
revoke execute on function public.find_person(bigint, text), public.leading_bids(bigint) from public, anon, authenticated;

alter table public.league_settings enable row level security;
alter table public.transfer_windows enable row level security;
alter table public.auctions enable row level security;
alter table public.bids enable row level security;

create policy "members see settings" on public.league_settings for select to authenticated using (public.is_member());
create policy "members see windows" on public.transfer_windows for select to authenticated using (public.is_member());
create policy "members see auctions" on public.auctions for select to authenticated using (public.is_member());
create policy "own bids or organizer" on public.bids for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());

revoke all on public.bid_history from anon;
grant select on public.bid_history to authenticated;

-- Live updates: the site listens to auction and window changes.
alter publication supabase_realtime add table public.auctions, public.transfer_windows;

commit;
