-- `mmsave archive` reads the series a page of one table at a time: export_series() builds the whole
-- backup in one statement, which hits Supabase's statement timeout once snapshots and race data grow.
begin;

-- Rows `skip`..`skip + take` of one series table, in the shape export_series() gives them.
create function public.export_series_rows(t text, skip int, take int) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  s text := public.current_series();
  rows jsonb;
begin
  if s is null then raise exception 'No series: send x-series'; end if;
  if not t = any(public.series_tables()) then raise exception 'Not a series table: %', t; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(r) - ''series''), ''[]'') from '
                 || '(select * from league.%I where series = $1 order by ctid offset $2 limit $3) r', t)
    into rows using s, skip, take;
  return rows;
end
$$;

revoke execute on function public.export_series_rows(text, int, int) from public, anon, authenticated;
grant execute on function public.export_series_rows(text, int, int) to service_role;

commit;
