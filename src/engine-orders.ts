import type { ChangeSet } from "./apply.ts";
import type { TeamDesign } from "./league-types.ts";
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

/** A team's `design.nextYearCar` from the latest snapshot. */
export type NextYearCar = NonNullable<TeamDesign["nextYearCar"]>;

/**
 * Next year's suppliers as `setSuppliers` for member teams whose next-year design MM has started
 * (pre-season): each type gets the member's choice for that car's season, else this season's
 * supplier if it's still on offer (no choice = keep current). Re-emitted on every pull while MM
 * designs, so the AI's picks never last; `setSuppliers` skips what's already set.
 */
export function supplierChanges(rows: SupplierChoiceRow[], cars: Map<string, NextYearCar>, memberTeams: string[]) {
  const changes: ChangeSet["changes"] = [];
  const waiting: string[] = [], unavailable: string[] = [];
  for (const team of memberTeams) {
    const car = cars.get(team);
    if (!car) continue;
    const mine = rows.filter((r) => r.team === team && r.season === car.season);
    if (car.state !== "designing") {
      if (mine.length && car.state === "waiting") waiting.push(team);
      continue;
    }
    const suppliers: Record<string, number> = {};
    for (const [type, options] of Object.entries(car.options)) {
      const offered = (id: number | undefined) => id != null && options.some((o) => o.id === id);
      const choice = mine.find((r) => r.supplier_type === type)?.supplier_id;
      if (choice != null && !offered(choice)) unavailable.push(`${team} ${type} ${choice}`);
      const id = offered(choice) ? choice : offered(car.current[type]?.id) ? car.current[type].id : undefined;
      if (id != null) suppliers[type] = id;
    }
    if (Object.keys(suppliers).length) changes.push({ op: "setSuppliers" as const, team, suppliers });
  }
  return { changes, waiting, unavailable };
}

export async function fetchSupplierContext(env: SupabaseEnv) {
  const [rows, [snap]] = await Promise.all([
    rest<SupplierChoiceRow[]>(env, "GET", "supplier_choices?select=*"),
    rest<{ id: number }[]>(env, "GET", "snapshots?select=id&order=id.desc&limit=1"),
  ]);
  const privs = snap ? await rest<{ team: string; private: { design?: { nextYearCar?: NextYearCar } } }[]>(
    env, "GET", `team_snapshots?snapshot_id=eq.${snap.id}&select=team,private`) : [];
  const cars = new Map(privs.flatMap((p) => (p.private.design?.nextYearCar ? [[p.team, p.private.design.nextYearCar] as const] : [])));
  return { rows, cars };
}
