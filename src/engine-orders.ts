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

export interface SupplierChoiceRow { team: string; season: number; supplier_type: string; supplier_id: number }

/**
 * Members' supplier choices as `setSuppliers`, for teams whose next-year design MM has started
 * (pre-season). Others wait for a later pull.
 */
export function supplierChanges(rows: SupplierChoiceRow[], designing: Set<string>): { changes: ChangeSet["changes"]; waiting: string[] } {
  const teams = [...new Set(rows.map((r) => r.team))];
  return {
    changes: teams.filter((t) => designing.has(t)).map((team) => ({
      op: "setSuppliers" as const, team,
      suppliers: Object.fromEntries(rows.filter((r) => r.team === team).map((r) => [r.supplier_type, r.supplier_id])),
    })),
    waiting: teams.filter((t) => !designing.has(t)),
  };
}

export async function fetchSupplierContext(env: SupabaseEnv) {
  const [rows, [snap]] = await Promise.all([
    rest<SupplierChoiceRow[]>(env, "GET", "supplier_choices?select=*"),
    rest<{ game_date: string }[]>(env, "GET", "snapshots?select=game_date&order=id.desc&limit=1"),
  ]);
  const season = Number(String(snap?.game_date ?? "").slice(0, 4));
  return rows.filter((r) => r.season === season);
}
