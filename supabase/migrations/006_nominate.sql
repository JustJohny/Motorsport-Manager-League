-- Nominating someone for auction places the nominator's opening bid in the same step (the
-- user's UX choice, 2026-10-01). One function, so a refused bid (minimum, budget, who is
-- replaced) leaves no empty auction behind. If someone else nominated the same person a moment
-- earlier, this becomes a normal bid on that auction.
-- Runs in one transaction.

begin;

create function public.nominate(person_guid text, yearly_wage numeric, years int, replacing_guid text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  aid bigint;
begin
  aid := public.open_auction(nominate.person_guid);
  perform public.place_bid(aid, nominate.yearly_wage, nominate.years, nominate.replacing_guid);
  return aid;
end
$$;

revoke execute on function public.nominate(text, numeric, int, text) from public, anon;
grant execute on function public.nominate(text, numeric, int, text) to authenticated;

commit;
