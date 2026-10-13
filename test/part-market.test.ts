import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { num, pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import { extractLeague } from "../src/extract.ts";
import type { Obj } from "../src/graph.ts";
import type { LeagueState } from "../src/league-types.ts";
import { Save } from "../src/model.ts";
import { designOptions, removeUnorderedParts } from "../src/ops/design.ts";
import { partFloor } from "../src/ops/part-market.ts";
import { CUSTOMER_GUID_PREFIX, customerStat, isCustomerPart } from "../src/part-market.ts";
import { purchaseChanges, type PurchaseRow } from "../src/part-market-orders.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_FF20_LEAGUE_SAVE ?? join(defaultSavesDir(), "SaveFF20 F1 League R2 Pre (league).sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Kubica GrandPrix", discord: "alice" },
    { member: "bob", team: "DCT Racing Project", discord: "bob" },
  ],
};

function reload(save: Save): Save {
  save.prepareForWrite();
  const f = save.file;
  const raw = unpack(pack({ version: f.version, headerText: stringifyLossless(f.header), dataText: stringifyLossless(f.data) }));
  return new Save({ version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) });
}

const guid = (n: number) => `${CUSTOMER_GUID_PREFIX}0000-4000-8000-${String(n).padStart(12, "0")}`;
const best = (save: Save, team: string, type: "Brakes") =>
  save.parts(save.team(team), type).filter((p) => p.components?.length).sort((a, b) => b.mStats.level - a.mStats.level)[0];

describe.skipIf(!existsSync(SAVE))("part market: customer copies in the save", () => {
  it("copies a part at customer spec without opening the buyer's design slots", () => {
    const save = Save.load(SAVE);
    const source = best(save, "Scuderia Ferrari", "Brakes");
    const slotsBefore = designOptions(save, save.team("Alpine Racing"), "Brakes").ctx.slots;
    const log = applyChanges(save, { changes: [
      { op: "copyPart", from: "Scuderia Ferrari", part: source.id, type: "Brakes", to: "Alpine Racing", guid: guid(1), fitToCar: 0 },
      { op: "copyPart", from: "Scuderia Ferrari", part: source.id, type: "Brakes", to: "Alpine Racing", guid: guid(2) },
    ] });
    expect(log[0]).toContain("customer Brakes");

    const r = reload(save);
    expect(r.g.validate()).toEqual([]);
    const alpine = r.team("Alpine Racing");
    const copies = r.parts(alpine, "Brakes").filter((p) => isCustomerPart(p.id));
    expect(copies).toHaveLength(2);
    const src = r.parts(r.team("Scuderia Ferrari"), "Brakes").find((p) => p.id === source.id)!;
    const floor = partFloor(r, r.championship(alpine), "Brakes");
    expect(num(copies[0].mStats.mStat)).toBe(customerStat(num(src.mStats.mStat) + num(src.mStats.mPerformance), floor));
    expect(num(copies[0].mStats.mStat)).toBeLessThan(num(src.mStats.mStat));
    expect(num(copies[0].mStats.mReliability)).toBeCloseTo(num(src.mStats.mReliability), 5);
    expect(r.g.list<Obj>(copies[0].components).map((c) => c.id)).toEqual(r.g.list<Obj>(src.components).map((c) => c.id));
    expect(copies[0].isFitted).toBe(true);
    expect(r.g.deref(copies[0].fittedCar)).toBe(r.cars(alpine)[0]);
    // The seller keeps their part, and the buyer's own design slots don't move.
    expect(src.isFitted || r.parts(r.team("Scuderia Ferrari"), "Brakes").includes(src)).toBe(true);
    expect(designOptions(r, alpine, "Brakes").ctx.slots).toBe(slotsBefore);
    // The site sees them as customer parts.
    const state = extractLeague(r, { members: [{ member: "x", team: "Alpine Racing", discord: "x" }] });
    expect(state.teams.find((t) => t.name === "Alpine Racing")!.parts.Brakes.filter((p) => p.customer)).toHaveLength(2);
    expect(state.championship.partFloor?.Brakes).toBe(floor);

    // Not mistaken for an AI-built part, and kept mid-season.
    expect(removeUnorderedParts(r, { op: "removeUnorderedParts", teams: ["Alpine Racing"], keep: [], since: "2000-01-01" }).join()).not.toContain("removed Brakes");
    expect(applyChanges(r, { changes: [{ op: "removeCustomerParts" }] })).toEqual(["No customer parts due back"]);
  }, 120_000);

  it("takes copies back at the season's end and refits the team's own part", () => {
    const save = Save.load(SAVE);
    const source = best(save, "Scuderia Ferrari", "Brakes");
    applyChanges(save, { changes: [{ op: "copyPart", from: "Scuderia Ferrari", part: source.id, type: "Brakes", to: "Alpine Racing", guid: guid(3), fitToCar: 1 }] });
    const log = applyChanges(save, { changes: [{ op: "removeCustomerParts", force: true }] });
    expect(log.join("\n")).toContain("returned (season over)");
    const alpine = save.team("Alpine Racing");
    expect(save.parts(alpine, "Brakes").some((p) => isCustomerPart(p.id))).toBe(false);
    expect(save.g.deref<Obj>(save.cars(alpine)[1].mCurrentPart)).toBeDefined();
    expect(save.parts(alpine, "Brakes").filter((p) => p.isFitted)).toHaveLength(2);
    expect(reload(save).g.validate()).toEqual([]);
  }, 120_000);

  it("refuses to sell a copy on, or a banned part", () => {
    const save = Save.load(SAVE);
    const source = best(save, "Scuderia Ferrari", "Brakes");
    applyChanges(save, { changes: [{ op: "copyPart", from: "Scuderia Ferrari", part: source.id, type: "Brakes", to: "Alpine Racing", guid: guid(4) }] });
    expect(() => applyChanges(save, { changes: [{ op: "copyPart", from: "Alpine Racing", part: guid(4), type: "Brakes", to: "Haas Formula Racing", guid: guid(5) }] }))
      .toThrow(/customer part/);
  }, 120_000);
});

describe("part market: pull", () => {
  const row = (over: Partial<PurchaseRow> = {}): PurchaseRow => ({
    id: 1, buyer: "B", seller: "S", part_type: "Gearbox", part_guid: "g1", copies: 2, price_each: 3_000_000, materials_each: 900_000,
    guids: [guid(1), guid(2)], fit_cars: [1], ...over,
  });
  it("delivers the copies and moves the money, less materials", () => {
    const parts = new Map([["S|Gearbox", [{ guid: "g1" } as never]]]);
    const { changes, delivered, dropped } = purchaseChanges([row()], parts);
    expect(delivered).toHaveLength(1);
    expect(dropped).toHaveLength(0);
    expect(changes).toEqual([
      { op: "copyPart", from: "S", part: "g1", type: "Gearbox", to: "B", guid: guid(1), fitToCar: 1 },
      { op: "copyPart", from: "S", part: "g1", type: "Gearbox", to: "B", guid: guid(2) },
      { op: "adjustBudget", team: "B", delta: -6_000_000, reason: "Customer Gearbox x2 from S" },
      { op: "adjustBudget", team: "S", delta: 4_200_000, reason: "Gearbox x2 sold to B (less materials)" },
    ]);
  });
  it("drops a purchase whose part is gone or banned", () => {
    expect(purchaseChanges([row()], new Map()).dropped).toHaveLength(1);
    expect(purchaseChanges([row()], new Map([["S|Gearbox", [{ guid: "g1", banned: true } as never]]])).changes).toEqual([]);
  });
});

describe.skipIf(!existsSync(SAVE))("database: part market", () => {
  let state: LeagueState;
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const org = () => t.member("org"), alice = () => t.member("alice"), bob = () => t.member("bob");
  const BUDGET = 20_000_000;
  const tatraGearbox = () => state.teams.find((x) => x.name === "Tatra Racing")!.parts.Gearbox.find((p) => p.componentIds.length)!;

  beforeAll(async () => {
    state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    const r = await t.service("select public.publish_snapshot($1, $2) as id", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))]);
    expect(r.error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '${BUDGET}')
                     where team in ('Tatra Racing', 'Kubica GrandPrix', 'DCT Racing Project')`);
  }, 120_000);

  it("keeps listed parts off the market, as the organizer sets them", async () => {
    const wing = state.teams.find((x) => x.name === "Tatra Racing")!.parts.FrontWing[0];
    const r = await org().query("select public.list_part('FrontWing', $1, 5000000)", [wing.guid]);
    expect(r.error).toMatch(/listed this season/);
    expect((await alice().query("select public.set_listed_parts(2020, '{Gearbox}')")).error).toMatch(/Only the organizer/);
    expect((await org().query("select public.set_listed_parts(2020, '{Gearbox,FrontWing}')")).error).toBeNull();
    expect((await org().query("select public.list_part('Gearbox', $1, 5000000)", [tatraGearbox().guid])).error).toMatch(/listed this season/);
    expect((await org().query("select public.set_listed_parts(2020, '{FrontWing,RearWing}')")).error).toBeNull();
    expect((await alice().query<{ l: string[] }>("select public.listed_parts() as l")).rows[0].l.sort()).toEqual(["FrontWing", "RearWing"]);
  });

  it("lists a part with the customer spec, and a buyer reserves the money", async () => {
    const part = tatraGearbox();
    const materials = state.teams.find((x) => x.name === "Tatra Racing")!.design!.types.Gearbox.ctx.settings.materialsCost;
    expect((await org().query("select public.list_part('Gearbox', $1, $2)", [part.guid, materials - 1])).error).toMatch(/cover the materials/);
    const listed = await org().query<{ id: number }>("select public.list_part('Gearbox', $1, 3000000) as id", [part.guid]);
    expect(listed.error).toBeNull();
    const id = listed.rows[0].id;
    const preview = (await bob().query<{ preview: { stat: number } }>("select preview from part_listings where id = $1", [id])).rows[0].preview;
    expect(preview.stat).toBe(customerStat(part.stat! + (part.performance ?? 0), state.championship.partFloor!.Gearbox));

    expect((await org().query("select public.buy_part($1, 1)", [id])).error).toMatch(/your own part/);
    expect((await bob().query("select public.buy_part($1, 2, '{0,0}')", [id])).error).toMatch(/different car/);
    const bought = await bob().query<{ id: number }>("select public.buy_part($1, 2, '{1}') as id", [id]);
    expect(bought.error).toBeNull();
    // Reserved like an order: 2 x $3M.
    const committed = await t.db.query<{ c: string }>("select public.hq_committed('DCT Racing Project') as c");
    expect(Number(committed.rows[0].c)).toBe(6_000_000);
    // Only the two teams (and the organizer) see the deal.
    expect((await alice().query("select * from part_purchases")).rows).toHaveLength(0);
    expect((await org().query("select * from part_purchases")).rows).toHaveLength(1);

    const [p] = (await t.service<PurchaseRow>("select * from part_purchases where id = $1", [bought.rows[0].id])).rows;
    expect(p.guids).toHaveLength(2);
    expect(p.guids.every(isCustomerPart)).toBe(true);
    expect(Number(p.materials_each)).toBe(materials);
    expect((await t.service("select public.mark_purchases_applied($1)", [[p.id]])).error).toBeNull();
    const fit = await t.service<{ part_guid: string }>("select part_guid from part_fitting where team = 'DCT Racing Project' and car = 1 and part_type = 'Gearbox'");
    expect(fit.rows[0].part_guid).toBe(p.guids[0]);
  });

  it("withdrawing a listing cancels its open purchases", async () => {
    const part = state.teams.find((x) => x.name === "Kubica GrandPrix")!.parts.Suspension.find((x) => x.componentIds.length)!;
    const id = (await alice().query<{ id: number }>("select public.list_part('Suspension', $1, 2000000) as id", [part.guid])).rows[0].id;
    expect((await bob().query("select public.buy_part($1, 1)", [id])).error).toBeNull();
    expect((await bob().query("select public.buy_part($1, 1)", [id])).error).toMatch(/already bought/);
    expect((await bob().query("select public.withdraw_listing($1)", [id])).error).toMatch(/No active listing/);
    expect((await alice().query("select public.withdraw_listing($1)", [id])).error).toBeNull();
    const rows = (await bob().query<{ status: string }>("select status from part_purchases where listing_id = $1", [id])).rows;
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("closes once the season's last race is run", async () => {
    await t.service(`update snapshots set public = jsonb_set(public, '{championship,calendar}',
      (select jsonb_agg(e || '{"ended": true}') from jsonb_array_elements(public -> 'championship' -> 'calendar') e))`);
    const part = tatraGearbox();
    const r = await org().query("select public.list_part('Gearbox', $1, 3000000)", [part.guid]);
    expect(r.error).toMatch(/closed until next season/);
  });
});
