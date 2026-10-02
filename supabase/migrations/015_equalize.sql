-- Equalizing the field (usually at the start of a league): the organizer queues HQ levels, part
-- stats, lead designer and mechanic stats, pit crew and budget for every team in the championship,
-- and the next pull applies them (`equalizeTeams`, src/ops/equalize.ts) before members' orders.
-- Member teams' site-run pit crews restart at the given skill at that pull.
-- Runs in one transaction.

begin;

create table league.equalize_orders (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  -- EqualizeSettings (src/league-types.ts).
  settings jsonb not null check (jsonb_typeof(settings) = 'object'),
  status text not null default 'queued' check (status in ('queued', 'applied', 'cancelled')),
  created_at timestamptz not null default now()
);
create unique index one_queued_equalize on league.equalize_orders (series) where status = 'queued';

create view public.equalize_orders with (security_invoker = true) as
  select * from league.equalize_orders where series = public.current_series() with local check option;
revoke all on public.equalize_orders from anon;
grant select on league.equalize_orders to authenticated;
grant all on league.equalize_orders to service_role;
alter table league.equalize_orders enable row level security;
create policy "organizer" on league.equalize_orders for select to authenticated
  using ((public.member_in(series)).role = 'organizer');
alter publication supabase_realtime add table league.equalize_orders;

-- Queue (or replace the queued) equalization.
create function public.queue_equalize(settings jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_organizer() then raise exception 'Only the organizer can equalize the field'; end if;
  if jsonb_typeof(settings) <> 'object' or settings = '{}'::jsonb then raise exception 'Nothing to equalize'; end if;
  update public.equalize_orders o set settings = queue_equalize.settings, created_at = now() where o.status = 'queued';
  if not found then insert into public.equalize_orders (settings) values (queue_equalize.settings); end if;
end
$$;

create function public.cancel_equalize() returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_organizer() then raise exception 'Only the organizer can equalize the field'; end if;
  update public.equalize_orders o set status = 'cancelled' where o.status = 'queued';
end
$$;

grant execute on function public.queue_equalize(jsonb), public.cancel_equalize() to authenticated;

create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders']
$$;

commit;
