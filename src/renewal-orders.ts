import type { ChangeSet } from "./apply.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface RenewalRow {
  id: number; team: string; person_guid: string; person_name: string; kind: string; years: number;
  yearly_wage: number | string; sign_on_fee: number | string; end_before: string; new_end: string; status: string; created_at: string;
}

/** Members' queued renewals as changes: the renewed contract, then the sign-on fee. */
export function renewalChanges(rows: RenewalRow[]): ChangeSet["changes"] {
  return rows.flatMap((r) => [
    {
      op: "renewContract" as const, team: r.team, person: r.person_guid, yearlyWages: Number(r.yearly_wage),
      endDate: r.new_end, expectedEnd: r.end_before, signOnFee: Number(r.sign_on_fee),
    },
    ...(Number(r.sign_on_fee) ? [{ op: "adjustBudget" as const, team: r.team, delta: -Number(r.sign_on_fee), reason: `Sign-on fee: ${r.person_name} (renewal)` }] : []),
  ]);
}

export async function fetchRenewals(env: SupabaseEnv) {
  const rows = await rest<RenewalRow[]>(env, "GET", "contract_renewals?status=eq.queued&select=*&order=created_at").catch((e: Error) => {
    // Before migration 018 the table doesn't exist (PostgREST PGRST205): no renewals yet.
    if (/PGRST205/.test(e.message)) return null;
    throw e;
  });
  return { rows: rows ?? [], missing: rows === null };
}

export async function markRenewalsApplied(env: SupabaseEnv, ids: number[]) {
  if (ids.length) await rest(env, "PATCH", `contract_renewals?id=in.(${ids.join(",")})`, { status: "applied", applied_at: new Date().toISOString() });
}
