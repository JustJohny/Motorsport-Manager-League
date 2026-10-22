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
 * The changes that cancel and refund HQ projects the in-game AI started on member teams:
 * everything under construction since a member took the team over (`starts`, team -> game date,
 * from `team_starts()`) that no applied or queued order covers. Teams without a start are left alone.
 */
export function cancelUnorderedChange(starts: Record<string, string>, orders: HqOrderRow[]) {
  return Object.entries(starts).map(([team, since]) => ({
    op: "cancelUnorderedHq" as const,
    teams: [team],
    keep: orders.filter((o) => o.team === team).map((o) => ({ team: o.team, building: o.building_type, toLevel: o.to_level })),
    since,
  }));
}

/** Member teams, orders the league has applied or queued, and when each member team was taken over. */
export async function fetchHqContext(env: SupabaseEnv) {
  const [members, orders, starts] = await Promise.all([
    rest<{ team: string }[]>(env, "GET", "league_members?select=team"),
    rest<HqOrderRow[]>(env, "GET", "hq_orders?status=in.(queued,applied)&select=*"),
    rest<{ team: string; start: string | null }[]>(env, "POST", "rpc/team_starts", {}),
  ]);
  return {
    memberTeams: [...new Set(members.map((m) => m.team))],
    orders,
    teamStarts: Object.fromEntries(starts.filter((s) => s.start).map((s) => [s.team, s.start!])) as Record<string, string>,
  };
}
