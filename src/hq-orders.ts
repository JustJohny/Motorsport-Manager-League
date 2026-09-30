import type { ChangeSet } from "./apply.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface HqOrderRow {
  id: number; team: string; building_type: number; building_name: string; to_level: number;
  cost: number | string; weeks: number; status: string; created_at: string;
}

/**
 * Queued HQ orders as save changes: start the construction in game (MM's own time, scaled by
 * the league's hq_speed) and take the price from the budget.
 */
export function hqChanges(orders: HqOrderRow[], speed: number): ChangeSet["changes"] {
  return orders.flatMap((o) => [
    { op: "startBuilding" as const, team: o.team, building: o.building_type, ...(speed !== 1 ? { speed } : {}) },
    {
      op: "adjustBudget" as const, team: o.team, delta: -Number(o.cost),
      reason: o.to_level === 1 ? `HQ: build ${o.building_name}` : `HQ: ${o.building_name} to level ${o.to_level}`,
    },
  ]);
}

export async function fetchQueuedOrders(env: SupabaseEnv) {
  return rest<HqOrderRow[]>(env, "GET", "hq_orders?status=eq.queued&select=*&order=created_at");
}

export async function markOrdersApplied(env: SupabaseEnv, ids: number[]) {
  if (!ids.length) return;
  await rest(env, "PATCH", `hq_orders?id=in.(${ids.join(",")})`, { status: "applied", applied_at: new Date().toISOString() });
}

/**
 * The change that cancels and refunds HQ projects the in-game AI started on member teams:
 * everything under construction after the league began that no applied or queued order covers.
 */
export function cancelUnorderedChange(memberTeams: string[], orders: HqOrderRow[], leagueStart: string) {
  return {
    op: "cancelUnorderedHq" as const,
    teams: memberTeams,
    keep: orders.map((o) => ({ team: o.team, building: o.building_type, toLevel: o.to_level })),
    since: leagueStart,
  };
}

/** Member teams, orders the league has applied or queued, and the first published game date. */
export async function fetchHqContext(env: SupabaseEnv) {
  const [members, orders, [first]] = await Promise.all([
    rest<{ team: string }[]>(env, "GET", "league_members?select=team"),
    rest<HqOrderRow[]>(env, "GET", "hq_orders?status=in.(queued,applied)&select=*"),
    rest<{ game_date: string }[]>(env, "GET", "snapshots?select=game_date&order=game_date.asc&limit=1"),
  ]);
  return { memberTeams: [...new Set(members.map((m) => m.team))], orders, leagueStart: first?.game_date ?? null };
}
