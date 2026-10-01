-- Next season's suppliers, round 2 (migration 010 is already live):
-- - Choices are keyed by the season the car is for (the snapshot's design.nextYearCar.season), not
--   the game date's year: MM's pre-season straddles New Year (ERS: 13 Dec 2016 to 5 Mar 2017).
-- - The window opens once 3 races or fewer remain (src/supplier-rules.ts) or MM is designing the
--   car, and closes once it's built.
-- - clear_supplier_choice: back to the default, keep this season's supplier.
-- Runs in one transaction, and can be run again safely.

begin;

-- Choices made so far were keyed by this season's year; they're for next season's car. Only on the
-- first run (clear_supplier_choice doesn't exist yet), so running this file again is safe.
do $$
begin
  if to_regprocedure('public.clear_supplier_choice(text)') is null then
    update public.supplier_choices set season = season + 1;
  end if;
end
$$;

-- The team's next-year car in the latest snapshot, if the window is open: it opens once 3 races
-- or fewer remain (src/supplier-rules.ts) or MM is designing the car, and closes once it's built.
create or replace function public.supplier_window_car(team_name text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  car jsonb;
  races_left int;
begin
  select ts.private -> 'design' -> 'nextYearCar' into car from public.team_snapshots ts
    where ts.snapshot_id = public.latest_snapshot_id() and ts.team = team_name;
  if car is null or car -> 'season' is null then raise exception 'Next season''s suppliers appear after the organizer''s next publish'; end if;
  if car ->> 'state' = 'complete' then raise exception 'Next season''s car is already built'; end if;
  select count(*) into races_left from public.snapshots sn, jsonb_array_elements(sn.public -> 'championship' -> 'calendar') e
    where sn.id = public.latest_snapshot_id() and not (e ->> 'ended')::boolean;
  if car ->> 'state' <> 'designing' and races_left > 3 then
    raise exception 'Choosing next season''s suppliers opens when 3 races remain (% to go)', races_left;
  end if;
  return car;
end
$$;

create or replace function public.choose_supplier(supplier_type text, supplier_id int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  car jsonb;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  car := public.supplier_window_car(me.team);
  if not exists (select 1 from jsonb_array_elements(car -> 'options' -> supplier_type) o
                 where (o ->> 'id')::int = choose_supplier.supplier_id) then
    raise exception 'That supplier isn''t available to your team';
  end if;
  insert into public.supplier_choices (team, season, supplier_type, supplier_id)
    values (me.team, (car ->> 'season')::int, choose_supplier.supplier_type, choose_supplier.supplier_id)
    on conflict on constraint supplier_choices_pkey do update set supplier_id = excluded.supplier_id, updated_at = now();
end
$$;

-- Back to the default: keep this season's supplier.
create or replace function public.clear_supplier_choice(supplier_type text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  car jsonb;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  car := public.supplier_window_car(me.team);
  delete from public.supplier_choices sc where sc.team = me.team and sc.season = (car ->> 'season')::int
    and sc.supplier_type = clear_supplier_choice.supplier_type;
end
$$;

revoke execute on function public.supplier_window_car(text) from public, anon, authenticated;
revoke execute on function public.choose_supplier(text, int) from public, anon;
grant execute on function public.choose_supplier(text, int) to authenticated;
revoke execute on function public.clear_supplier_choice(text) from public, anon;
grant execute on function public.clear_supplier_choice(text) to authenticated;

commit;
