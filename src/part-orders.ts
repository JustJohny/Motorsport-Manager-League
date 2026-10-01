import type { ChangeSet } from "./apply.ts";
import type { PartType } from "./model.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface DesignOrderRow {
  id: number; team: string; part_type: string; components: number[]; cost: number | string; status: string; created_at: string;
}
export interface FittingRow { team: string; car: 0 | 1; part_type: string; part_guid: string }
export interface ImprovementRow { team: string; performance: string[]; reliability: string[]; split: number | string }

const ENGLISH: Record<string, string> = { FrontWing: "Front Wing", RearWing: "Rear Wing" };

/**
 * What the in-game AI did to member teams' parts since the last apply, undone: designs it
 * started and parts it finished that no league order covers are cancelled / removed and refunded.
 */
export function undoAiParts(memberTeams: string[], orders: DesignOrderRow[], leagueStart: string): ChangeSet["changes"] {
  const keep = orders.map((o) => ({ team: o.team, type: o.part_type as PartType, components: o.components }));
  return [
    { op: "cancelUnorderedDesigns", teams: memberTeams, keep, since: leagueStart },
    { op: "removeUnorderedParts", teams: memberTeams, keep, since: leagueStart },
  ];
}

/** Queued designs: start them in game and take MM's player price from the budget. */
export function designChanges(orders: DesignOrderRow[]): ChangeSet["changes"] {
  return orders.flatMap((o) => [
    { op: "startDesign" as const, team: o.team, type: o.part_type as PartType, components: o.components },
    { op: "adjustBudget" as const, team: o.team, delta: -Number(o.cost), reason: `${ENGLISH[o.part_type] ?? o.part_type} design (league order)` },
  ]);
}

/** Every member's standing fitting and improvement choice, re-applied on every pull. */
export function choiceChanges(fitting: FittingRow[], improvement: ImprovementRow[]): ChangeSet["changes"] {
  const teams = [...new Set(fitting.map((f) => f.team))];
  return [
    ...teams.map((team) => ({
      op: "setFitting" as const, team,
      fitting: fitting.filter((f) => f.team === team).map((f) => ({ car: f.car, type: f.part_type as PartType, part: f.part_guid })),
    })),
    ...improvement.map((i) => ({
      op: "setImprovement" as const, team: i.team, performance: i.performance, reliability: i.reliability, split: Number(i.split),
    })),
  ];
}

export async function fetchPartsContext(env: SupabaseEnv) {
  const [orders, fitting, improvement] = await Promise.all([
    rest<DesignOrderRow[]>(env, "GET", "design_orders?status=in.(queued,applied)&select=*&order=created_at"),
    rest<FittingRow[]>(env, "GET", "part_fitting?select=*&order=team,car,part_type"),
    rest<ImprovementRow[]>(env, "GET", "part_improvement?select=*"),
  ]);
  return { orders, queued: orders.filter((o) => o.status === "queued"), fitting, improvement };
}

export async function markDesignsApplied(env: SupabaseEnv, ids: number[]) {
  if (!ids.length) return;
  await rest(env, "PATCH", `design_orders?id=in.(${ids.join(",")})`, { status: "applied", applied_at: new Date().toISOString() });
}
