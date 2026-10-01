-- Next season's suppliers, round 3: members choose from the deals MM draws for next season (as in
-- MM's car design screen) instead of every deal of the tier. MM draws them after the final race,
-- so the window opens when the published snapshot has offers, not with 3 races left
-- (src/supplier-rules.ts). Runs in one transaction, and can be run again safely.

begin;

-- The team's next-year car in the latest snapshot, if the window is open.
create or replace function public.supplier_window_car(team_name text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  car jsonb;
begin
  select ts.private -> 'design' -> 'nextYearCar' into car from public.team_snapshots ts
    where ts.snapshot_id = public.latest_snapshot_id() and ts.team = team_name;
  if car is null or car -> 'season' is null then raise exception 'Next season''s suppliers appear after the organizer''s next publish'; end if;
  if car ->> 'state' = 'complete' then raise exception 'Next season''s car is already built'; end if;
  if not exists (select 1 from jsonb_each(coalesce(car -> 'options', '{}')) o where jsonb_array_length(o.value) > 0) then
    raise exception 'MM offers next season''s suppliers after the final race';
  end if;
  return car;
end
$$;

revoke execute on function public.supplier_window_car(text) from public, anon, authenticated;

commit;
