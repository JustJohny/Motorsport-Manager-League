-- A person's stats at every publish of the series, for the site's growth trend (FF20 driver
-- development, src/development.ts). Read from the snapshots already stored: team staff in the
-- public snapshot and the free-agent market. Public data only, for members of the series.
-- Runs in one transaction.

begin;

create function public.person_history(guid text)
returns table (snapshot_id bigint, game_date text, round int, team text, stats jsonb, growth jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.in_series(public.current_series()) then raise exception 'You are not in this league'; end if;
  return query
    select sn.id, sn.game_date, sn.round, x.team, x.person -> 'stats', x.person -> 'growth'
    from public.snapshots sn
    cross join lateral (
      select t ->> 'name' as team, s -> 'person' as person
        from jsonb_array_elements(sn.public -> 'teams') t, jsonb_array_elements(t -> 'staff') s
        where s -> 'person' ->> 'guid' = person_history.guid
      union all
      select null, p from public.market_snapshots m, jsonb_array_elements(m.free_agents) p
        where m.snapshot_id = sn.id and p ->> 'guid' = person_history.guid
      limit 1
    ) x
    order by sn.id;
end
$$;

revoke execute on function public.person_history(text) from public, anon;
grant execute on function public.person_history(text) to authenticated;

commit;
