import type { ChangeSet } from "./apply.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface EngineSpendRow { id: number; team: string; kind: string; description: string; amount: number | string; payee: string | null }

/** Reserved engine-programme spending as budget changes: the payer pays, an engine sale pays the owner. */
export function engineSpendChanges(rows: EngineSpendRow[]): ChangeSet["changes"] {
  return rows.flatMap((r) => [
    { op: "adjustBudget" as const, team: r.team, delta: -Number(r.amount), reason: r.description },
    ...(r.payee ? [{ op: "adjustBudget" as const, team: r.payee, delta: Number(r.amount), reason: `${r.description} (sold to ${r.team})` }] : []),
  ]);
}

export async function fetchEngineSpend(env: SupabaseEnv) {
  return rest<EngineSpendRow[]>(env, "GET", "engine_spend?status=eq.queued&select=*&order=created_at");
}

export async function markEngineSpendApplied(env: SupabaseEnv, ids: number[]) {
  if (ids.length) await rest(env, "PATCH", `engine_spend?id=in.(${ids.join(",")})`, { status: "applied" });
}
