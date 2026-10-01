-- Season regulations and rule votes. MM's votes are held on the site: members vote with MM's
-- vote power, AI teams' votes are published with the snapshot (championship.regulations, by
-- MM's logic), and `mmsave pull` applies the result in place of MM's own vote. The organizer can
-- set any rule group for next season. See src/politics.ts.
-- Runs in one transaction.

begin;

create table public.rule_votes (
  team text not null,
  season int not null,
  rule_id int not null,
  choice text not null check (choice in ('yes', 'no', 'abstain')),
  extra_power int not null default 0 check (extra_power >= 0),
  updated_at timestamptz not null default now(),
  primary key (team, season, rule_id)
);

-- The league's result of each vote, written when pull applies it.
create table public.rule_vote_results (
  season int not null,
  rule_id int not null,
  yes int not null,
  no int not null,
  abstained int not null,
  accepted boolean not null,
  applied_at timestamptz not null default now(),
  primary key (season, rule_id)
);

-- The organizer's choice of rule per group for next season (overrides votes).
create table public.next_rule_overrides (
  season int not null,
  rule_group text not null,
  rule_id int not null,
  updated_at timestamptz not null default now(),
  primary key (season, rule_group)
);

create function public.latest_regulations() returns jsonb
language sql stable security definer set search_path = '' as $$
  select public -> 'championship' -> 'regulations' from public.snapshots where id = public.latest_snapshot_id()
$$;

create function public.cast_rule_vote(rule_id int, choice text, extra_power int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  regs jsonb := public.latest_regulations();
  v_season int := (regs ->> 'season')::int;
  power int;
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  if not exists (select 1 from jsonb_array_elements(regs -> 'votes') v
                 where (v ->> 'ruleId')::int = cast_rule_vote.rule_id and v ->> 'status' = 'upcoming') then
    raise exception 'That vote isn''t open';
  end if;
  if exists (select 1 from public.rule_vote_results r where r.season = v_season and r.rule_id = cast_rule_vote.rule_id) then
    raise exception 'That vote has already been decided';
  end if;
  if choice not in ('yes', 'no', 'abstain') then raise exception 'Vote yes, no or abstain'; end if;
  if choice = 'abstain' and extra_power > 0 then raise exception 'Abstaining uses no vote power'; end if;
  select (t ->> 'votingPower')::int into power from jsonb_array_elements(regs -> 'teams') t where t ->> 'team' = me.team;
  if extra_power < 0 or extra_power > coalesce(power, 0) then
    raise exception 'You can add at most % vote power', coalesce(power, 0);
  end if;
  insert into public.rule_votes (team, season, rule_id, choice, extra_power)
    values (me.team, v_season, cast_rule_vote.rule_id, choice, extra_power)
    on conflict on constraint rule_votes_pkey do update set choice = excluded.choice, extra_power = excluded.extra_power, updated_at = now();
end
$$;

-- Organizer: next season's rule for a group (rule_id null = no override).
create function public.set_next_rule(rule_group text, rule_id int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  regs jsonb := public.latest_regulations();
  v_season int := (regs ->> 'season')::int;
begin
  if not public.is_organizer() then raise exception 'Only the organizer can change next season''s rules'; end if;
  if rule_id is null then
    delete from public.next_rule_overrides o where o.season = v_season and o.rule_group = set_next_rule.rule_group;
    return;
  end if;
  if (regs -> 'rules' -> (rule_id::text) ->> 'group') is distinct from rule_group then
    raise exception 'Rule % is not in group %', rule_id, rule_group;
  end if;
  insert into public.next_rule_overrides (season, rule_group, rule_id) values (v_season, set_next_rule.rule_group, set_next_rule.rule_id)
    on conflict on constraint next_rule_overrides_pkey do update set rule_id = excluded.rule_id, updated_at = now();
end
$$;

revoke execute on function public.cast_rule_vote(int, text, int), public.set_next_rule(text, int) from public, anon;
grant execute on function public.cast_rule_vote(int, text, int), public.set_next_rule(text, int) to authenticated;
revoke execute on function public.latest_regulations() from public, anon, authenticated;

alter table public.rule_votes enable row level security;
alter table public.rule_vote_results enable row level security;
alter table public.next_rule_overrides enable row level security;
-- Politics is public within the league, like the snapshots.
create policy "league members" on public.rule_votes for select to authenticated
  using ((public.my_member()).team is not null or public.is_organizer());
create policy "league members" on public.rule_vote_results for select to authenticated
  using ((public.my_member()).team is not null or public.is_organizer());
create policy "league members" on public.next_rule_overrides for select to authenticated
  using ((public.my_member()).team is not null or public.is_organizer());

alter publication supabase_realtime add table public.rule_votes, public.rule_vote_results, public.next_rule_overrides;

commit;
