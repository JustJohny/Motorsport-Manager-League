import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { sponsorChanges, type SponsorOrderRow } from "../src/sponsor-orders.ts";
import { leagueDb } from "./db.ts";

const SAVE = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

const terms = (slot: number, id: string, sponsor: string, extra: Record<string, unknown> = {}) => ({
  slot, sponsorId: id, sponsor, category: "Games", prestige: 2, upfront: 0, perRace: 100000, bonus: 0, bonusTarget: 1,
  homeBonus: 1, length: 6, offerDate: "0001-01-01T00:00:00.0000000", ...extra,
});

describe.skipIf(!existsSync(SAVE))("database: sponsors", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  let gameDate = "";
  const alice = () => t.member("alice"), bob = () => t.member("bob"), org = () => t.member("org");
  const call = (who: ReturnType<typeof alice>, sql: string, params: unknown[] = []) => who.query(sql, params);
  type Order = { id: number; kind: string; slot: number; sponsor_id: string; status: string; amount: string };
  const orders = async (who = alice()) => (await who.query<Order>("select * from sponsor_orders order by id")).rows;

  beforeAll(async () => {
    const state = extractLeague(Save.load(SAVE), league);
    gameDate = state.gameDate;
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    // Known deals and offers for Garuda: one deal from the career start, one MM's AI signed since
    // the league began (dated the league's first game date), and offers.
    const sponsorship = {
      deals: [
        { ...terms(0, "old", "Old Co"), left: 4, end: "2017-01-01T00:00:00.0000000", earned: 0 },
        { ...terms(1, "ai", "AI Co", { upfront: 2000000, offerDate: gameDate }), left: 6, end: "2017-01-01T00:00:00.0000000", earned: 2000000 },
      ],
      offers: [
        { ...terms(2, "new", "New Co", { upfront: 500000 }), daysLeft: 10, expires: "2099-01-01T00:00:00.0000000" },
        { ...terms(1, "swap", "Swap Co"), daysLeft: 10, expires: "2099-01-01T00:00:00.0000000" },
        { ...terms(0, "busy", "Busy Co"), daysLeft: 10, expires: "2099-01-01T00:00:00.0000000" },
        { ...terms(3, "late", "Late Co"), daysLeft: 0, expires: "2000-01-01T00:00:00.0000000" },
      ],
    };
    await t.service(`update team_snapshots set private = jsonb_set(jsonb_set(private, '{sponsorship}', $1::jsonb), '{budget}', '10000000') where team = 'Garuda Racing'`, [JSON.stringify(sponsorship)]);
    const poor = { deals: [{ ...terms(1, "ai", "AI Co", { upfront: 2000000, offerDate: gameDate }), left: 6, end: "", earned: 0 }], offers: [] };
    await t.service(`update team_snapshots set private = jsonb_set(jsonb_set(private, '{sponsorship}', $1::jsonb), '{budget}', '100000') where team = 'Octane Racing'`, [JSON.stringify(poor)]);
  }, 120_000);

  it("publishes deals on the car as public data, terms and offers as private", async () => {
    const pub = (await bob().query<{ teams: { name: string; sponsors?: unknown[]; sponsorship?: unknown }[] }>("select public -> 'teams' as teams from snapshots")).rows[0].teams;
    const garuda = pub.find((x) => x.name === "Garuda Racing")!;
    expect(Array.isArray(garuda.sponsors)).toBe(true);
    expect(garuda.sponsorship).toBeUndefined();
    expect((await bob().query("select * from team_snapshots where team = 'Garuda Racing'")).rows).toEqual([]);
  });

  it("signs an offer for a free slot, once per slot", async () => {
    expect((await call(alice(), "select public.sign_sponsor(2, 'new')")).error).toBeNull();
    expect((await call(alice(), "select public.sign_sponsor(2, 'new')")).error).toMatch(/already chose a sponsor/);
    expect((await call(alice(), "select public.sign_sponsor(2, 'nope')")).error).toMatch(/isn't on your list/);
    expect((await call(alice(), "select public.sign_sponsor(3, 'late')")).error).toMatch(/lapsed/);
    const o = (await orders()).find((x) => x.slot === 2)!;
    expect(o).toMatchObject({ kind: "sign", sponsor_id: "new", status: "queued" });
    expect(Number(o.amount)).toBe(500000);
    // Rivals can't see it; the organizer can.
    expect(await orders(bob())).toEqual([]);
    expect((await orders(org())).length).toBe(1);
  });

  it("has no early exit: a deal from before the league runs until it ends", async () => {
    expect((await call(alice(), "select public.sign_sponsor(0, 'busy')")).error).toMatch(/already has a sponsor \(Old Co\)/);
    expect((await call(alice(), "select public.drop_sponsor(0)")).error).toMatch(/run until they end/);
    expect((await call(alice(), "select public.keep_sponsor(0)")).error).toMatch(/need a decision/);
  });

  it("drops an AI deal, paying its upfront money back, and lets an offer take the slot", async () => {
    expect((await call(alice(), "select public.sign_sponsor(1, 'swap')")).error).toMatch(/already has a sponsor/);
    expect((await call(alice(), "select public.drop_sponsor(1)")).error).toBeNull();
    expect(Number((await t.db.query<{ c: string }>("select public.hq_committed('Garuda Racing') as c")).rows[0].c)).toBe(2_000_000);
    expect((await call(alice(), "select public.sign_sponsor(1, 'swap')")).error).toBeNull();
    // Cancelling the drop takes the sign that relied on it with it.
    const drop = (await orders()).find((x) => x.kind === "drop")!;
    expect((await call(alice(), "select public.cancel_sponsor_order($1)", [drop.id])).error).toBeNull();
    expect((await orders()).filter((x) => x.slot === 1).map((x) => x.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("keeps an AI deal, cancelling a queued drop", async () => {
    expect((await call(alice(), "select public.drop_sponsor(1)")).error).toBeNull();
    expect((await call(alice(), "select public.keep_sponsor(1)")).error).toBeNull();
    const slot1 = (await orders()).filter((x) => x.slot === 1);
    expect(slot1.at(-1)).toMatchObject({ kind: "keep", status: "kept" });
    expect(slot1.filter((x) => x.status === "queued")).toEqual([]);
    // Dropping after all replaces the keep.
    expect((await call(alice(), "select public.drop_sponsor(1)")).error).toBeNull();
    expect((await orders()).find((x) => x.kind === "keep")!.status).toBe("cancelled");
  });

  it("checks the budget before a drop", async () => {
    expect((await call(bob(), "select public.drop_sponsor(1)")).error).toMatch(/Not enough budget/);
  });

  it("leaves the career team's sponsors to the game", async () => {
    expect((await call(org(), "select public.sign_sponsor(2, 'new')")).error).toMatch(/career team signs its sponsors in game/);
  });

  it("turns queued choices into changes: drops first, lapsed offers left out", () => {
    const row = (o: Partial<SponsorOrderRow>): SponsorOrderRow => ({
      id: 0, team: "Garuda Racing", kind: "sign", slot: 0, sponsor_id: "x", sponsor_name: "X", amount: 0, expires: null, status: "queued", created_at: "", ...o,
    });
    const out = sponsorChanges([
      row({ id: 1, slot: 1, sponsor_id: "swap", sponsor_name: "Swap Co", amount: 300000, expires: "2016-12-01T00:00:00.0000000" }),
      row({ id: 2, kind: "drop", slot: 1, sponsor_id: "ai", sponsor_name: "AI Co", amount: "2000000" }),
      row({ id: 3, slot: 2, sponsor_id: "late", expires: "2016-01-01T00:00:00.0000000" }),
    ], "2016-06-01T00:00:00.0000000");
    expect(out.changes).toEqual([
      { op: "dropSponsor", team: "Garuda Racing", slot: 1, sponsorId: "ai" },
      { op: "adjustBudget", team: "Garuda Racing", delta: -2000000, reason: "AI Co - Upfront payment returned (league)" },
      { op: "signSponsor", team: "Garuda Racing", slot: 1, sponsorId: "swap" },
      { op: "adjustBudget", team: "Garuda Racing", delta: 300000, reason: "Swap Co - Upfront payment" },
    ]);
    expect(out.expired.map((o) => o.id)).toEqual([3]);
  });
});
