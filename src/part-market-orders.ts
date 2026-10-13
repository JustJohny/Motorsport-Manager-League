import type { ChangeSet } from "./apply.ts";
import type { Part } from "./league-types.ts";
import type { PartType } from "./model.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface PurchaseRow {
  id: number; buyer: string; seller: string; part_type: string; part_guid: string; copies: number;
  price_each: number | string; materials_each: number | string; guids: string[]; fit_cars: number[];
}

const ENGLISH: Record<string, string> = { FrontWing: "Front Wing", RearWing: "Rear Wing" };

/**
 * Queued purchases as changes: each copy delivered (fitted if the buyer chose a car), then the
 * money: the buyer pays the price, the seller gets it minus the materials. A purchase whose part
 * is gone or banned in the latest publish is left out (and cancelled when marked applied).
 */
export function purchaseChanges(rows: PurchaseRow[], sellerParts: Map<string, Part[]>) {
  const changes: ChangeSet["changes"] = [];
  const delivered: PurchaseRow[] = [], dropped: PurchaseRow[] = [];
  for (const r of rows) {
    const source = sellerParts.get(`${r.seller}|${r.part_type}`)?.find((p) => p.guid === r.part_guid);
    if (!source || source.banned) { dropped.push(r); continue; }
    delivered.push(r);
    const type = r.part_type as PartType;
    r.guids.forEach((guid, i) => changes.push({
      op: "copyPart", from: r.seller, part: r.part_guid, type, to: r.buyer, guid,
      ...(r.fit_cars[i] === 0 || r.fit_cars[i] === 1 ? { fitToCar: r.fit_cars[i] as 0 | 1 } : {}),
    }));
    const name = ENGLISH[r.part_type] ?? r.part_type;
    const n = r.copies > 1 ? ` x${r.copies}` : "";
    changes.push(
      { op: "adjustBudget", team: r.buyer, delta: -Number(r.price_each) * r.copies, reason: `Customer ${name}${n} from ${r.seller}` },
      { op: "adjustBudget", team: r.seller, delta: (Number(r.price_each) - Number(r.materials_each)) * r.copies, reason: `${name}${n} sold to ${r.buyer} (less materials)` },
    );
  }
  return { changes, delivered, dropped };
}

export async function fetchPurchases(env: SupabaseEnv) {
  let rows: PurchaseRow[];
  try {
    rows = await rest<PurchaseRow[]>(env, "GET", "part_purchases?status=eq.queued&select=*&order=created_at");
  } catch {
    return { rows: [] as PurchaseRow[], sellerParts: new Map<string, Part[]>(), missing: true };
  }
  const sellers = [...new Set(rows.map((r) => r.seller))];
  const sellerParts = new Map<string, Part[]>();
  if (sellers.length) {
    const [snap] = await rest<{ id: number }[]>(env, "GET", "snapshots?select=id&order=id.desc&limit=1");
    const priv = await rest<{ team: string; parts: Record<string, Part[]> | null }[]>(env, "GET",
      `team_snapshots?snapshot_id=eq.${snap.id}&select=team,parts:private->parts`);
    for (const t of priv.filter((x) => sellers.includes(x.team))) {
      for (const [type, parts] of Object.entries(t.parts ?? {})) sellerParts.set(`${t.team}|${type}`, parts);
    }
  }
  return { rows, sellerParts, missing: false };
}

/** Delivered purchases: applied, with the chosen cars' fitting moved to the copies. Dropped ones: cancelled. */
export async function markPurchases(env: SupabaseEnv, delivered: PurchaseRow[], dropped: PurchaseRow[]) {
  if (delivered.length) await rest(env, "POST", "rpc/mark_purchases_applied", { ids: delivered.map((r) => r.id) });
  if (dropped.length) await rest(env, "PATCH", `part_purchases?id=in.(${dropped.map((r) => r.id).join(",")})`, { status: "cancelled" });
}
