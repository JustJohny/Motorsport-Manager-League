-- Bigger stickers (the user, 2026-10-09: "they are small at 100%"): the size goes up to 2 (200 % of
-- the spot); above 1 the sticker is cut off at the decal's edges. Runs in one transaction.

begin;

alter table league.team_stickers drop constraint team_stickers_scale_check,
  add constraint team_stickers_scale_check check (scale between 0.25 and 2);

create or replace function public.set_sticker_scale(sticker_id bigint, scale real) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_sticker_team();
begin
  if scale is null or scale < 0.25 or scale > 2 then raise exception 'The size is 25%% to 200%%'; end if;
  update public.team_stickers x set scale = set_sticker_scale.scale
    where x.id = sticker_id and x.team = t and x.status in ('approved', 'pending');
  if not found then raise exception 'No such sticker on your car'; end if;
end
$$;

commit;
