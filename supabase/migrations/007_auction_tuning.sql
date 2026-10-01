-- Auction tuning, agreed with the user on 2026-10-01 after looking at the real league save:
-- 1. Buyout = MM's own contract termination cost (ContractPerson.GetContractTerminationCost):
--    the months of wage left, at least 1 and at most 6. It used to be the whole rest of the
--    contract (an $18M buyout for one driver).
-- 2. Someone under contract at an AI team opens at no less than their current wage; nobody moves
--    for a pay cut. Free agents still open at the stats formula.
-- 3. The formula's bases are calibrated to the median wage MM's AI teams pay per skill in the ERS.
-- src/league-rules.ts mirrors all of this; test/db.test.ts checks they agree.
-- Runs in one transaction.

begin;

alter table public.league_settings alter column min_wage_base
  set default '{"Driver": 2240000, "Engineer": 740000, "Mechanic": 370000}';
update public.league_settings set min_wage_base = '{"Driver": 2240000, "Engineer": 740000, "Mechanic": 370000}' where id = 1;

create or replace function public.min_wage(person jsonb) returns numeric
language sql stable security definer set search_path = '' as $$
  select greatest(s.min_wage_floor,
                  round((s.min_wage_base ->> (person ->> 'kind'))::numeric
                        * power(public.stat_average(person) / 10, s.min_wage_exponent), -4),
                  -- Under contract (an AI team's staff): at least what they earn now.
                  case when person -> 'contract' ->> 'team' is not null
                       then (person -> 'contract' ->> 'yearlyWages')::numeric else 0 end)
  from public.league_settings s where s.id = 1
$$;

-- MM's termination cost: monthly wage times the months left, clamped to 1..6, rounded to $1K.
create or replace function public.buyout(person jsonb, game_date text) returns numeric
language sql immutable set search_path = '' as $$
  select round((person -> 'contract' ->> 'yearlyWages')::numeric / 12
               * least(6, greatest(1, round(floor(extract(epoch from (public.game_ts(person -> 'contract' ->> 'end') - public.game_ts(game_date))) / 86400)
                                            / 365 * 12))), -3)
$$;

commit;
