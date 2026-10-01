-- Works engine programmes (see src/engine-rules.ts and HANDOFF.md, phase 5). Members found a
-- programme, pick a concept each season, buy development points and research projects, and
-- sell their engine to other members. Spending is reserved like HQ orders and charged at the
-- next apply; the engine itself is built into the save at the season change.
-- Runs in one transaction.

begin;

create table public.engine_programmes (
  team text primary key,
  name text not null check (length(name) between 2 and 40),
  founded_season int not null,
  -- Customer offer for next season.
  offering boolean not null default false,
  customer_price numeric not null default 0 check (customer_price >= 0),
  customer_detuned boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.engine_plans (
  team text not null references public.engine_programmes on delete cascade,
  season int not null,
  concept text not null default 'balanced' check (concept in ('power', 'efficient', 'balanced')),
  points jsonb not null default '{"power": 0, "fuel": 0, "improvability": 0, "tyres": 0}',
  projects text[] not null default '{}',
  primary key (team, season)
);

-- Engines built at season changes: the legal engine customers get, and the works engine (with
-- illegal gains). Private to the owner, like parts.
create table public.engine_builds (
  team text not null references public.engine_programmes on delete cascade,
  season int not null,
  legal jsonb not null,
  works jsonb not null,
  outcomes jsonb not null default '[]',
  primary key (team, season)
);

-- Research projects and their price, as in src/engine-rules.ts (a test checks they agree).
create table public.engine_projects (id text primary key, cost numeric not null, illegal boolean not null);
insert into public.engine_projects values
  ('combustion', 5000000, false), ('lightweight', 4000000, false), ('thermal', 3000000, false), ('fuelflow', 6000000, true);

-- Money spent on a programme, reserved until pull charges it.
create table public.engine_spend (
  id bigint generated always as identity primary key,
  team text not null,
  season int not null,
  kind text not null check (kind in ('founding', 'points', 'project', 'engine')),
  description text not null,
  amount numeric not null,
  -- Who receives it (an engine purchase pays the owner).
  payee text,
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now()
);

-- Engines bought for next season from another member's programme.
create table public.engine_customers (
  customer text not null,
  season int not null,
  owner text not null references public.engine_programmes on delete cascade,
  price numeric not null,
  detuned boolean not null,
  primary key (customer, season)
);

-- Queued HQ orders, part designs and engine spending all commit budget.
create or replace function public.hq_committed(team_name text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cost) from public.hq_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(cost) from public.design_orders where team = team_name and status = 'queued'), 0)
       + coalesce((select sum(amount) from public.engine_spend where team = team_name and status = 'queued'), 0)
$$;

create function public.engine_season() returns int
language sql stable security definer set search_path = '' as $$
  select left(game_date, 4)::int from public.snapshots where id = public.latest_snapshot_id()
$$;

-- Reserve money if the budget allows (with HQ orders, designs and leading bids).
create function public.engine_reserve(team_name text, kind text, description text, amount numeric, payee text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare budget numeric;
begin
  select (ts.private ->> 'budget')::numeric into budget from public.team_snapshots ts
    where ts.snapshot_id = public.latest_snapshot_id() and ts.team = team_name;
  if public.hq_committed(team_name) + public.bids_committed(team_name) + amount > coalesce(budget, 0) then
    raise exception 'Not enough budget: this costs $% and your orders and leading bids already commit $% of $%',
      to_char(amount, 'FM999,999,999'), to_char(public.hq_committed(team_name) + public.bids_committed(team_name), 'FM999,999,999'),
      to_char(coalesce(budget, 0), 'FM999,999,999');
  end if;
  insert into public.engine_spend (team, season, kind, description, amount, payee)
    values (team_name, public.engine_season(), kind, description, amount, payee);
end
$$;

create function public.found_engine_programme(name text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if exists (select 1 from public.engine_programmes p where p.team = me.team) then raise exception 'Your team already has an engine programme'; end if;
  perform public.engine_reserve(me.team, 'founding', 'Engine programme founded', 30000000);
  insert into public.engine_programmes (team, name, founded_season) values (me.team, found_engine_programme.name, public.engine_season());
  insert into public.engine_plans (team, season) values (me.team, public.engine_season());
end
$$;

create function public.my_engine_plan() returns public.engine_plans
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  plan public.engine_plans;
begin
  if not exists (select 1 from public.engine_programmes p where p.team = me.team) then raise exception 'Your team has no engine programme'; end if;
  insert into public.engine_plans (team, season) values (me.team, public.engine_season()) on conflict do nothing;
  select * into plan from public.engine_plans p where p.team = me.team and p.season = public.engine_season();
  return plan;
end
$$;

create function public.set_engine_concept(concept text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare plan public.engine_plans := public.my_engine_plan();
begin
  if concept not in ('power', 'efficient', 'balanced') then raise exception 'Unknown concept'; end if;
  update public.engine_plans p set concept = set_engine_concept.concept where p.team = plan.team and p.season = plan.season;
end
$$;

-- The n-th point of a season costs n x $1M (src/engine-rules.ts pointsCost).
create function public.buy_engine_points(area text, n int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  plan public.engine_plans := public.my_engine_plan();
  bought int;
  cost numeric;
begin
  if area not in ('power', 'fuel', 'improvability', 'tyres') then raise exception 'Unknown area'; end if;
  if n < 1 or n > 20 then raise exception 'Buy 1 to 20 points at a time'; end if;
  select coalesce(sum(value::int), 0) into bought from jsonb_each_text(plan.points);
  cost := 1000000 * (n * (2 * bought + n + 1) / 2.0);
  perform public.engine_reserve(plan.team, 'points', format('Engine development: %s %s point%s', n, area, case when n > 1 then 's' else '' end), cost);
  update public.engine_plans p set points = jsonb_set(p.points, array[area], to_jsonb((p.points ->> area)::int + n))
    where p.team = plan.team and p.season = plan.season;
end
$$;

create function public.choose_engine_project(project_id text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  plan public.engine_plans := public.my_engine_plan();
  pr public.engine_projects;
begin
  select * into pr from public.engine_projects where id = project_id;
  if pr.id is null then raise exception 'Unknown project'; end if;
  if project_id = any(plan.projects) then raise exception 'That project is already running this season'; end if;
  perform public.engine_reserve(plan.team, 'project', 'Engine research: ' || project_id, pr.cost);
  update public.engine_plans p set projects = p.projects || project_id where p.team = plan.team and p.season = plan.season;
end
$$;

create function public.set_engine_offer(offering boolean, price numeric, detuned boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if price < 0 then raise exception 'The price can''t be negative'; end if;
  update public.engine_programmes p set offering = set_engine_offer.offering, customer_price = price, customer_detuned = detuned
    where p.team = me.team;
  if not found then raise exception 'Your team has no engine programme'; end if;
end
$$;

-- A member buys another member's engine for next season (paid at the next apply).
create function public.buy_engine(owner text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  prog public.engine_programmes;
  next_season int := public.engine_season() + 1;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  select * into prog from public.engine_programmes p where p.team = owner;
  if prog.team is null or not prog.offering then raise exception '% doesn''t sell engines', owner; end if;
  if prog.team = me.team then raise exception 'That is your own engine'; end if;
  if exists (select 1 from public.engine_customers c where c.customer = me.team and c.season = next_season) then
    raise exception 'You already bought an engine for next season';
  end if;
  perform public.engine_reserve(me.team, 'engine', format('%s engine supply %s', prog.name, next_season), prog.customer_price, prog.team);
  insert into public.engine_customers (customer, season, owner, price, detuned) values (me.team, next_season, prog.team, prog.customer_price, prog.customer_detuned);
end
$$;

revoke execute on function public.found_engine_programme(text), public.set_engine_concept(text), public.buy_engine_points(text, int),
  public.choose_engine_project(text), public.set_engine_offer(boolean, numeric, boolean), public.buy_engine(text) from public, anon;
grant execute on function public.found_engine_programme(text), public.set_engine_concept(text), public.buy_engine_points(text, int),
  public.choose_engine_project(text), public.set_engine_offer(boolean, numeric, boolean), public.buy_engine(text) to authenticated;
revoke execute on function public.engine_reserve(text, text, text, numeric, text), public.my_engine_plan(), public.engine_season() from public, anon, authenticated;

alter table public.engine_programmes enable row level security;
alter table public.engine_plans enable row level security;
alter table public.engine_projects enable row level security;
alter table public.engine_spend enable row level security;
alter table public.engine_builds enable row level security;
alter table public.engine_customers enable row level security;
-- Programmes and their offers are public within the league; plans and spending are private.
create policy "league members" on public.engine_programmes for select to authenticated
  using ((public.my_member()).team is not null or public.is_organizer());
create policy "league members" on public.engine_projects for select to authenticated using (true);
create policy "league members" on public.engine_customers for select to authenticated
  using ((public.my_member()).team is not null or public.is_organizer());
create policy "own plan or organizer" on public.engine_plans for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());
create policy "own builds or organizer" on public.engine_builds for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());
create policy "own spending or organizer" on public.engine_spend for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());

alter publication supabase_realtime add table public.engine_programmes, public.engine_plans, public.engine_spend, public.engine_customers;

commit;
