-- Car stickers (the user's rules, 2026-10-09): MM's sponsor deals keep paying but no longer show on
-- member teams' cars; instead each member team puts its own "stickers" (a sponsor name and logo) on
-- MM's six decal spots, which don't affect the game. The organizer approves each logo first, as team
-- logos. `mmsave stickers` writes the approved ones into MM_Data/league-stickers, where the league
-- game patch puts them on the team's cars (menus and race); empty spots stay blank.
-- Slots are MM's SponsorSlot order: 0 rear wing, 1 front wing, 2 nose, 3 side pods, 4 end plates,
-- 5 air intake. Runs in one transaction.

begin;

create table league.team_stickers (
  id bigint generated always as identity primary key,
  series text not null default public.current_series() references public.series on delete cascade,
  team text not null,
  slot int not null check (slot between 0 and 5),
  sponsor_name text not null check (length(trim(sponsor_name)) between 1 and 40),
  -- Object name in the team-stickers bucket: "<series>/<file>".
  path text not null,
  -- pending: waiting for the organizer; approved: on the car (one per spot); replaced: an earlier
  -- approved one; rejected; withdrawn: the member uploaded another first; removed: taken off the car.
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'replaced', 'removed')),
  note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create unique index one_approved_sticker on league.team_stickers (series, team, slot) where status = 'approved';
create unique index one_pending_sticker on league.team_stickers (series, team, slot) where status = 'pending';

create view public.team_stickers with (security_invoker = true) as
  select * from league.team_stickers where series = public.current_series() with local check option;
revoke all on public.team_stickers from anon;
grant select on league.team_stickers to authenticated;
grant all on league.team_stickers to service_role;
alter table league.team_stickers enable row level security;
-- Approved stickers are on the car for all to see; pending and rejected ones only to the team and the organizer.
create policy "approved, or own team or organizer" on league.team_stickers for select to authenticated
  using (public.in_series(series) and (status = 'approved' or public.own_or_organizer(series, team)));
alter publication supabase_realtime add table league.team_stickers;

-- The member's team (the career team too: the patch decorates any team's car).
create function public.my_sticker_team() returns text
language plpgsql stable security definer set search_path = '' as $$
declare me public.league_members := public.my_member();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  return me.team;
end
$$;

-- After uploading the image to the team-stickers bucket. An earlier pending one for the spot is withdrawn.
create function public.submit_sticker(slot int, sponsor_name text, path text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  t text := public.my_sticker_team();
  oid bigint;
begin
  if slot < 0 or slot > 5 then raise exception 'Spots are 0 to 5'; end if;
  if sponsor_name is null or length(trim(sponsor_name)) not between 1 and 40 then raise exception 'Give the sponsor a name (up to 40 characters)'; end if;
  if path is null or path !~ ('^' || public.current_series() || '/[A-Za-z0-9._-]+\.png$') then
    raise exception 'Upload the sticker to "%/<file>.png" first', public.current_series();
  end if;
  update public.team_stickers x set status = 'withdrawn' where x.team = t and x.slot = submit_sticker.slot and x.status = 'pending';
  insert into public.team_stickers (team, slot, sponsor_name, path) values (t, submit_sticker.slot, trim(submit_sticker.sponsor_name), submit_sticker.path)
    returning id into oid;
  return oid;
end
$$;

create function public.withdraw_sticker(sticker_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_sticker_team();
begin
  update public.team_stickers x set status = 'withdrawn' where x.id = sticker_id and x.team = t and x.status = 'pending';
  if not found then raise exception 'No such pending sticker'; end if;
end
$$;

-- Take the approved sticker off a spot (no approval needed to remove one).
create function public.remove_sticker(slot int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare t text := public.my_sticker_team();
begin
  update public.team_stickers x set status = 'removed', reviewed_at = now() where x.team = t and x.slot = remove_sticker.slot and x.status = 'approved';
  if not found then raise exception 'No sticker on that spot'; end if;
end
$$;

-- The organizer approves (replacing the spot's current sticker) or rejects, with an optional note.
create function public.review_sticker(sticker_id bigint, approve boolean, note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare l public.team_stickers;
begin
  if not public.is_organizer() then raise exception 'Only the organizer reviews stickers'; end if;
  select * into l from public.team_stickers x where x.id = sticker_id and x.status = 'pending';
  if l.id is null then raise exception 'No such pending sticker'; end if;
  if approve then
    update public.team_stickers x set status = 'replaced' where x.team = l.team and x.slot = l.slot and x.status = 'approved';
  end if;
  update public.team_stickers x set status = case when approve then 'approved' else 'rejected' end,
    note = review_sticker.note, reviewed_at = now()
    where x.id = l.id;
end
$$;

-- For `mmsave stickers`: every series' member teams with their MM teamID (from that series' latest
-- snapshot) and approved stickers. A member team with none still gets a row (slot null): its car
-- shows no MM sponsor decals.
create function public.all_team_stickers() returns table (series text, team text, team_id int, slot int, sponsor_name text, path text)
language sql stable security definer set search_path = '' as $$
  select m.series, m.team, (t ->> 'teamID')::int, s.slot, s.sponsor_name, s.path
  from league.league_members m
  join lateral (select sn.public from league.snapshots sn where sn.series = m.series order by sn.id desc limit 1) sn on true
  cross join lateral jsonb_array_elements(sn.public -> 'teams') t
  left join league.team_stickers s on s.series = m.series and s.team = m.team and s.status = 'approved'
  where t ->> 'name' = m.team and m.team is not null
$$;

revoke execute on function public.my_sticker_team(), public.all_team_stickers() from public, anon, authenticated;
grant execute on function public.all_team_stickers() to service_role;
revoke execute on function public.submit_sticker(int, text, text), public.withdraw_sticker(bigint), public.remove_sticker(int),
  public.review_sticker(bigint, boolean, text) from public, anon;
grant execute on function public.submit_sticker(int, text, text), public.withdraw_sticker(bigint), public.remove_sticker(int),
  public.review_sticker(bigint, boolean, text) to authenticated;

-- Archive and restore include stickers.
create or replace function public.series_tables() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'snapshots', 'team_snapshots', 'market_snapshots', 'league_settings', 'league_members',
    'transfer_windows', 'auctions', 'bids', 'hq_orders', 'design_orders', 'part_fitting', 'part_improvement',
    'rule_votes', 'rule_vote_results', 'next_rule_overrides',
    'engine_programmes', 'engine_plans', 'engine_builds', 'engine_spend', 'engine_customers', 'supplier_choices',
    'pit_crew_teams', 'pit_crew', 'pit_crew_applicants', 'crew_spend', 'pit_crew_log', 'equalize_orders',
    'sponsor_orders', 'chassis_choices', 'car_investment', 'contract_renewals', 'team_looks', 'team_logos',
    'race_data', 'race_data_private', 'preseason_moves', 'preseason_suppliers', 'team_stickers']
$$;

-- Storage (Supabase only; the test database has no storage schema): team-stickers, public read,
-- members upload PNGs into their series' folder (the site pads them to MM's 2:1 decal), 2 MB.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('team-stickers', 'team-stickers', true, 2097152, array['image/png'])
      on conflict (id) do nothing;
    execute $p$
      create policy "league members upload stickers" on storage.objects for insert to authenticated
        with check (bucket_id = 'team-stickers' and public.in_series((storage.foldername(name))[1]))
    $p$;
  end if;
end
$$;

commit;
