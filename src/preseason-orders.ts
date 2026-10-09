import type { Change } from "./apply.ts";
import type { PublicSnapshot } from "./league-types.ts";
import { replay, type PreseasonMove } from "./preseason.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface PreseasonSupplierRow {
  team: string; supplier_type: string; supplier_id: number | string; supplier_name: string; applied_at: string | null;
}

/** Before migration 022 the tables don't exist (PostgREST PGRST205). */
const orMissing = <T>(p: Promise<T>) => p.catch((e: Error) => {
  if (/PGRST205/.test(e.message)) return null;
  throw e;
});

export async function fetchPreseason(env: SupabaseEnv) {
  const [moves, suppliers, snaps] = await Promise.all([
    orMissing(rest<PreseasonMove[]>(env, "GET", "preseason_moves?status=eq.queued&select=*&order=created_at,id")),
    orMissing(rest<PreseasonSupplierRow[]>(env, "GET", "preseason_suppliers?applied_at=is.null&select=*")),
    rest<{ public: PublicSnapshot }[]>(env, "GET", "snapshots?select=public&order=id.desc&limit=1"),
  ]);
  return { moves: moves ?? [], suppliers: suppliers ?? [], snapshot: snaps[0]?.public ?? null, missing: moves === null };
}

/**
 * Every team's moves replayed over its published staff (src/preseason.ts), then this season's
 * suppliers. Moves that no longer fit and releases from seats MM needs filled are reported.
 */
export function preseasonChanges(moves: PreseasonMove[], suppliers: PreseasonSupplierRow[], snapshot: PublicSnapshot | null) {
  const changes: Change[] = [];
  const warnings: string[] = [];
  /** Moves that didn't fit (and weren't applied). */
  const skipped = new Set<number>();
  const teams = [...new Set(moves.map((m) => m.team))];
  for (const team of teams) {
    const staff = snapshot?.teams.find((t) => t.name === team)?.staff;
    if (!staff) {
      warnings.push(`${team}: not in the latest snapshot, pre-season moves skipped`);
      for (const m of moves) if (m.team === team) skipped.add(m.id);
      continue;
    }
    const l = replay(team, staff, moves.filter((m) => m.team === team));
    changes.push(...l.changes);
    for (const [id, why] of l.invalid) { warnings.push(`${team}: move #${id} skipped: ${why}`); skipped.add(id); }
    for (const p of l.kept) warnings.push(`${team}: ${p.name} stays: nobody was signed into the seat`);
  }
  for (const s of suppliers) {
    changes.push({ op: "setCurrentSupplier", team: s.team, type: s.supplier_type as never, id: Number(s.supplier_id) });
  }
  return { changes, warnings, teams, skipped };
}

export async function markPreseasonApplied(env: SupabaseEnv, moveIds: number[], suppliers: PreseasonSupplierRow[]) {
  const now = new Date().toISOString();
  if (moveIds.length) await rest(env, "PATCH", `preseason_moves?id=in.(${moveIds.join(",")})`, { status: "applied", applied_at: now });
  for (const s of suppliers) {
    await rest(env, "PATCH", `preseason_suppliers?team=eq.${encodeURIComponent(s.team)}&supplier_type=eq.${encodeURIComponent(s.supplier_type)}&applied_at=is.null`, { applied_at: now });
  }
}
