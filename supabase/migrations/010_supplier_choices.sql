-- Next season's car: members choose MM's suppliers on the site (see src/ops/suppliers.ts). MM's AI
-- starts next year's design when pre-season starts; the pull at a pre-season checkpoint then
-- replaces its picks with these (`setSuppliers`). No choice = keep this season's suppliers.
-- Choices are private until pre-season, when the new season's suppliers show in MM anyway.
-- Runs in one transaction.

begin;

create table public.supplier_choices (
  team text not null,
  season int not null,
  supplier_type text not null,
  supplier_id int not null,
  updated_at timestamptz not null default now(),
  primary key (team, season, supplier_type)
);

create function public.choose_supplier(supplier_type text, supplier_id int) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  me public.league_members := public.my_member();
  priv jsonb;
  v_season int := public.engine_season();
begin
  if me.team is null then raise exception 'You are not in the league'; end if;
  select ts.private into priv from public.team_snapshots ts where ts.snapshot_id = public.latest_snapshot_id() and ts.team = me.team;
  if not exists (select 1 from jsonb_array_elements(priv -> 'design' -> 'nextYearCar' -> 'options' -> supplier_type) o
                 where (o ->> 'id')::int = choose_supplier.supplier_id) then
    raise exception 'That supplier isn''t available to your team';
  end if;
  insert into public.supplier_choices (team, season, supplier_type, supplier_id) values (me.team, v_season, choose_supplier.supplier_type, choose_supplier.supplier_id)
    on conflict on constraint supplier_choices_pkey do update set supplier_id = excluded.supplier_id, updated_at = now();
end
$$;

revoke execute on function public.choose_supplier(text, int) from public, anon;
grant execute on function public.choose_supplier(text, int) to authenticated;

alter table public.supplier_choices enable row level security;
create policy "own choices or organizer" on public.supplier_choices for select to authenticated
  using (team = (public.my_member()).team or public.is_organizer());

alter publication supabase_realtime add table public.supplier_choices;

commit;
