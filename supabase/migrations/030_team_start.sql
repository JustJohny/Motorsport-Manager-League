-- A member who takes over an AI team mid-season keeps what MM's AI built for it before then.
-- "After the league began" becomes "since a member took this team over": the first publish of
-- the team's current run with a member (a team that went back to the AI and was taken over again
-- starts over). Before 030 every team counted from the league's first publish.

create function public.team_managed(snapshot jsonb, team_name text) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from jsonb_array_elements(snapshot -> 'teams') t
                 where t ->> 'name' = team_name and t ->> 'member' is not null)
$$;

-- Null while no publish shows the team with a member (nothing is undone then).
create function public.team_start(team_name text) returns text
language sql stable security definer set search_path = '' as $$
  select min(s.game_date) from public.snapshots s
  where public.team_managed(s.public, team_name)
    and s.game_date > coalesce((select max(u.game_date) from public.snapshots u
                                where not public.team_managed(u.public, team_name)), '')
$$;

create or replace function public.unordered_project(team_name text, b jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select b ->> 'state' in ('BuildingInProgress', 'Upgrading')
    and coalesce(b ->> 'progressStart', '') > coalesce(public.team_start(team_name), '9999')
    and not exists (select 1 from public.hq_orders o
                    where o.team = team_name and o.status = 'applied'
                      and o.building_type = (b ->> 'type')::int and o.to_level = public.target_level(b))
$$;

create or replace function public.unordered_design(team_name text, cur jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(cur ->> 'start', '') > coalesce(public.team_start(team_name), '9999')
    and not exists (
      select 1 from public.design_orders o
      where o.team = team_name and o.status = 'applied' and o.part_type = cur ->> 'type'
        and public.sorted_ints(o.components) = public.sorted_ints(array(select jsonb_array_elements_text(cur -> 'components')::int)))
$$;

create or replace function public.ai_sponsor_deal(team_name text, deal jsonb) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(deal ->> 'offerDate', '') >= coalesce(public.team_start(team_name), '9999')
    and not exists (
      select 1 from public.sponsor_orders o
      where o.team = team_name and o.kind = 'sign' and o.status = 'applied'
        and o.slot = (deal ->> 'slot')::int and o.sponsor_id = deal ->> 'sponsorId')
$$;

create or replace function public.sellable_part(team_name text, part_type text, guid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb;
begin
  select x into p from jsonb_array_elements(coalesce(public.team_private(team_name) -> 'parts' -> part_type, '[]')) x where x ->> 'guid' = guid;
  if p is null then raise exception 'That part isn''t in the latest publish'; end if;
  if guid like 'c0c0c0c0-%' then raise exception 'Customer parts can''t be sold on'; end if;
  if coalesce((p ->> 'banned')::boolean, false) then raise exception 'That part is banned'; end if;
  if p ->> 'buildDate' > coalesce(public.team_start(team_name), '9999') and jsonb_array_length(coalesce(p -> 'componentIds', '[]')) > 0
     and not exists (select 1 from public.design_orders o
                     where o.team = team_name and o.status <> 'cancelled' and o.part_type = sellable_part.part_type
                       and public.sorted_ints(o.components) = public.sorted_ints(array(select jsonb_array_elements_text(p -> 'componentIds')::int))) then
    raise exception 'That part was built by MM''s AI and goes at the next apply';
  end if;
  return p;
end
$$;

-- The site and `mmsave pull` read every team's start in one call.
create function public.team_starts() returns table (team text, start text)
language sql stable security definer set search_path = '' as $$
  select m.team, public.team_start(m.team) from (select distinct team from public.league_members) m
$$;

revoke execute on function public.team_managed(jsonb, text) from public, anon, authenticated;
grant execute on function public.team_start(text), public.team_starts() to authenticated;
