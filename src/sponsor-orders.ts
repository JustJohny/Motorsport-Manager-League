import type { ChangeSet } from "./apply.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface SponsorOrderRow {
  id: number; team: string; kind: "sign" | "drop" | "keep"; slot: number; sponsor_id: string; sponsor_name: string;
  amount: number | string; expires: string | null; status: string; created_at: string;
}

/**
 * Members' queued sponsor choices as changes. Drops go first, so a sign can take the slot a drop
 * frees. A sign whose offer lapsed by the save's date is left out (MM withdrew it) and reported.
 */
export function sponsorChanges(orders: SponsorOrderRow[], gameDate: string) {
  const expired = orders.filter((o) => o.kind === "sign" && o.expires != null && o.expires <= gameDate);
  const live = orders.filter((o) => !expired.includes(o));
  const changes: ChangeSet["changes"] = [
    ...live.filter((o) => o.kind === "drop").flatMap((o) => [
      { op: "dropSponsor" as const, team: o.team, slot: o.slot, sponsorId: o.sponsor_id },
      ...(Number(o.amount) ? [{ op: "adjustBudget" as const, team: o.team, delta: -Number(o.amount), reason: `${o.sponsor_name} - Upfront payment returned (league)` }] : []),
    ]),
    ...live.filter((o) => o.kind === "sign").flatMap((o) => [
      { op: "signSponsor" as const, team: o.team, slot: o.slot, sponsorId: o.sponsor_id },
      ...(Number(o.amount) ? [{ op: "adjustBudget" as const, team: o.team, delta: Number(o.amount), reason: `${o.sponsor_name} - Upfront payment` }] : []),
    ]),
  ];
  return { changes, applied: live, expired };
}

export async function fetchSponsorOrders(env: SupabaseEnv) {
  const [orders, [latest]] = await Promise.all([
    rest<SponsorOrderRow[]>(env, "GET", "sponsor_orders?status=eq.queued&kind=in.(sign,drop)&select=*&order=created_at").catch((e: Error) => {
      // Before migration 016 the table doesn't exist (PostgREST PGRST205): no sponsor choices yet.
      if (/PGRST205/.test(e.message)) return null;
      throw e;
    }),
    rest<{ game_date: string }[]>(env, "GET", "snapshots?select=game_date&order=id.desc&limit=1"),
  ]);
  return { orders: orders ?? [], gameDate: latest?.game_date ?? "", missing: orders === null };
}

export async function markSponsorOrders(env: SupabaseEnv, applied: number[], expired: number[]) {
  if (applied.length) await rest(env, "PATCH", `sponsor_orders?id=in.(${applied.join(",")})`, { status: "applied", applied_at: new Date().toISOString() });
  if (expired.length) await rest(env, "PATCH", `sponsor_orders?id=in.(${expired.join(",")})`, { status: "expired" });
}
