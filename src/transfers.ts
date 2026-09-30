import type { ChangeSet } from "./apply.ts";
import type { Person } from "./league-types.ts";
import { contractEnd, type LeagueSettings } from "./league-rules.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

// Rows as the database returns them (numeric columns may arrive as strings).
export interface WindowRow { id: number; snapshot_id: number; closes_at: string; status: string }
export interface AuctionRow {
  id: number; person_guid: string; person: Person; kind: string; from_team: string | null;
  buyout: number | string; leading_team: string | null;
}
export interface BidRow {
  id: number; auction_id: number; team: string; yearly_wage: number | string; years: number;
  replacing_guid: string; replacing_name: string; created_at: string;
}

export interface Signing {
  person: Person;
  team: string;
  fromTeam: string | null;
  replacingName: string;
  wage: number;
  years: number;
  signOnFee: number;
  buyout: number;
}

/** The winning bid of every auction that got one, in the order the winning bids were placed. */
export function winners(auctions: AuctionRow[], bids: BidRow[], settings: Pick<LeagueSettings, "sign_on_fee_pct">) {
  const out: (Signing & { bid: BidRow })[] = [];
  for (const a of auctions) {
    if (!a.leading_team) continue;
    // A team can't bid while leading, so the leader's latest bid is the winning one.
    const bid = bids.filter((b) => b.auction_id === a.id && b.team === a.leading_team)
      .sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id - x.id)[0];
    if (!bid) throw new Error(`auction ${a.id}: no bid from leader ${a.leading_team}`);
    const wage = Number(bid.yearly_wage);
    out.push({
      bid, person: a.person, team: bid.team, fromTeam: a.from_team, replacingName: bid.replacing_name,
      wage, years: bid.years, signOnFee: Math.round(wage * Number(settings.sign_on_fee_pct)), buyout: Number(a.buyout),
    });
  }
  return out.sort((x, y) => x.bid.created_at.localeCompare(y.bid.created_at) || x.bid.id - y.bid.id);
}

/**
 * The save changes for a closed window: each winner is hired in place of the person the bid
 * named (a swap when they come from an AI team), then the sign-on fee and any buyout are taken
 * from the budget. Wages are paid by the game from then on.
 */
export function windowChanges(windowId: number, gameDate: string, auctions: AuctionRow[], bids: BidRow[], settings: Pick<LeagueSettings, "sign_on_fee_pct">): ChangeSet {
  const changes: ChangeSet["changes"] = [];
  for (const w of winners(auctions, bids, settings)) {
    changes.push({
      op: "hire", team: w.team, person: w.person.guid, replacing: w.bid.replacing_guid,
      yearlyWages: w.wage, endDate: contractEnd(gameDate, w.years),
    });
    changes.push({ op: "adjustBudget", team: w.team, delta: -w.signOnFee, reason: `Sign-on fee: ${w.person.name}` });
    if (w.buyout > 0) {
      changes.push({ op: "adjustBudget", team: w.team, delta: -w.buyout, reason: `Buyout: ${w.person.name} (${w.fromTeam})` });
    }
  }
  return { description: `Transfer window #${windowId}`, changes };
}

/** The open (or closed, not yet applied) window and its results, or null if there is none. */
export async function fetchWindow(env: SupabaseEnv) {
  const [window] = await rest<WindowRow[]>(env, "GET", "transfer_windows?status=eq.open&select=*");
  if (!window) return null;
  const [snap] = await rest<{ game_date: string }[]>(env, "GET", `snapshots?id=eq.${window.snapshot_id}&select=game_date`);
  const [settings] = await rest<LeagueSettings[]>(env, "GET", "league_settings?select=*");
  const auctions = await rest<AuctionRow[]>(env, "GET", `auctions?window_id=eq.${window.id}&select=*&order=id`);
  const ids = auctions.map((a) => a.id);
  const bids = ids.length ? await rest<BidRow[]>(env, "GET", `bids?auction_id=in.(${ids.join(",")})&select=*&order=id`) : [];
  return { window, gameDate: snap.game_date, settings, auctions, bids };
}

export async function markApplied(env: SupabaseEnv, windowId: number) {
  await rest(env, "PATCH", `transfer_windows?id=eq.${windowId}`, { status: "applied" });
}
