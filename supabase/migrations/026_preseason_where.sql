-- set_preseason updated the settings view without a WHERE clause, which Supabase's safeupdate
-- extension refuses for API calls ("UPDATE requires a WHERE clause"). The view already holds only
-- the current series' row; say so explicitly.
begin;

create or replace function public.set_preseason(open boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_organizer() then raise exception 'Only the organizer can open or close the pre-season'; end if;
  update public.league_settings set preseason = set_preseason.open where series = public.current_series();
  if not found then raise exception 'Publish a snapshot first'; end if;
end
$$;

commit;
