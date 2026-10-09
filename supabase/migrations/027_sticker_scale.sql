-- Sticker size (the user's request, 2026-10-09): each sticker has a scale, 0.25..1 of its decal
-- spot (1 = fitted to the spot, as uploaded). The team changes it at any time without a new
-- approval; the site's 3D car and the league game patch shrink the sticker around its centre.
-- Runs in one transaction.

begin;

alter table league.team_stickers add column scale real not null default 1 check (scale between 0.25 and 1);

-- The view was created with the table's columns at the time: add the new one.
create or replace view public.team_stickers with (security_invoker = true) as
  select * from league.team_stickers where series = public.current_series() with local check option;

-- Size of the team's own approved or pending sticker.
create function public.set_sticker_scale(sticker_id bigint, scale real) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_sticker_team();
begin
  if scale is null or scale < 0.25 or scale > 1 then raise exception 'The size is 25%% to 100%%'; end if;
  update public.team_stickers x set scale = set_sticker_scale.scale
    where x.id = sticker_id and x.team = t and x.status in ('approved', 'pending');
  if not found then raise exception 'No such sticker on your car'; end if;
end
$$;
revoke execute on function public.set_sticker_scale(bigint, real) from public, anon;
grant execute on function public.set_sticker_scale(bigint, real) to authenticated;

-- For `mmsave stickers`: now with each sticker's scale.
drop function public.all_team_stickers();
create function public.all_team_stickers() returns table (series text, team text, team_id int, slot int, sponsor_name text, path text, scale real)
language sql stable security definer set search_path = '' as $$
  select m.series, m.team, (t ->> 'teamID')::int, s.slot, s.sponsor_name, s.path, s.scale
  from league.league_members m
  join lateral (select sn.public from league.snapshots sn where sn.series = m.series order by sn.id desc limit 1) sn on true
  cross join lateral jsonb_array_elements(sn.public -> 'teams') t
  left join league.team_stickers s on s.series = m.series and s.team = m.team and s.status = 'approved'
  where t ->> 'name' = m.team and m.team is not null
$$;
revoke execute on function public.all_team_stickers() from public, anon, authenticated;
grant execute on function public.all_team_stickers() to service_role;

commit;
