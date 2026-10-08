-- FIRE Fantasy 20's numbers for the auction (see src/game-rules.ts and src/league-rules.ts, which
-- mirror this; test/db.test.ts checks they agree):
-- 1. Buyout: FF20's ContractPerson.GetContractTerminationCost charges the yearly wage / 8 per month
--    left (1..6), where Rebirth charged / 12. It's a setting, buyout_wage_divisor.
-- 2. The opening price's bases become the median wage FF20's AI teams pay per skill in Formula 1
--    (they were the ERS medians of the 2016 career, migration 007).
-- 3. The liveries bucket also holds FF20's car models for the 3D livery view
--    (tools/ff20-car-renders.py): glTF binaries of a few MB.
-- Runs in one transaction.

begin;

alter table league.league_settings add column buyout_wage_divisor numeric not null default 8 check (buyout_wage_divisor > 0);
-- The series view lists the table's columns as they were when it was made; add the new one.
create or replace view public.league_settings with (security_invoker = true) as
  select * from league.league_settings where series = public.current_series() with local check option;

alter table league.league_settings alter column min_wage_base
  set default '{"Driver": 6000000, "Engineer": 4500000, "Mechanic": 730000}';
update league.league_settings set min_wage_base = '{"Driver": 6000000, "Engineer": 4500000, "Mechanic": 730000}';

create or replace function public.buyout(person jsonb, game_date text) returns numeric
language sql stable set search_path = '' as $$
  select round((person -> 'contract' ->> 'yearlyWages')::numeric / (public.league_settings_row()).buyout_wage_divisor
               * least(6, greatest(1, round(floor(extract(epoch from (public.game_ts(person -> 'contract' ->> 'end') - public.game_ts(game_date))) / 86400)
                                            / 365 * 12))), -3)
$$;

-- Storage exists only on Supabase (the test database has none).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    update storage.buckets set file_size_limit = 8388608, allowed_mime_types = array['image/png', 'model/gltf-binary']
      where id = 'liveries';
  end if;
end
$$;

commit;
