import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { supplierChanges, type NextYearCar } from "../src/engine-orders.ts";
import { extractLeague } from "../src/extract.ts";
import type { LeagueState } from "../src/league-types.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { SUPPLIER_WINDOW_RACES, supplierWindow } from "../src/supplier-rules.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: next season's suppliers", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  let state: LeagueState;
  const alice = () => t.member("alice"), bob = () => t.member("bob");
  const car = (team: string) => state.teams.find((x) => x.name === team)!.design!.nextYearCar!;
  const choices = async (who: ReturnType<typeof alice>) =>
    (await who.query<{ team: string; season: number; supplier_type: string; supplier_id: number }>(
      "select team, season, supplier_type, supplier_id from supplier_choices order by supplier_type")).rows;

  beforeAll(async () => {
    state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
  }, 120_000);

  it("keys choices by the season the car is for", () => {
    // Base save: ERS 2016, pre-season ends in March 2017.
    expect(car("Garuda Racing").season).toBe(2017);
    expect(car("Garuda Racing").state).toBe("waiting");
  });

  it("opens the window when 3 races remain", async () => {
    const engine = car("Garuda Racing").options.Engine[0];
    const left = state.championship.calendar.filter((e) => !e.ended).length;
    expect(left).toBeGreaterThan(SUPPLIER_WINDOW_RACES);
    expect(supplierWindow(state.championship.calendar, "waiting").status).toBe("closed");
    expect((await alice().query("select public.choose_supplier('Engine', $1)", [engine.id])).error).toMatch(/opens when 3 races remain/);
    // Play on to the last 3 races.
    await t.service(`update snapshots set public = jsonb_set(public, '{championship,calendar}',
      (select jsonb_agg(case when (e ->> 'round')::int <= $1 then jsonb_set(e, '{ended}', 'true') else e end)
       from jsonb_array_elements(public -> 'championship' -> 'calendar') e))`, [state.championship.calendar.length - SUPPLIER_WINDOW_RACES]);
    expect((await alice().query("select public.choose_supplier('Engine', $1)", [engine.id])).error).toBeNull();
    expect(await choices(alice())).toEqual([{ team: "Garuda Racing", season: 2017, supplier_type: "Engine", supplier_id: engine.id }]);
  });

  it("only takes the team's own options, and changes or clears a choice", async () => {
    const opts = car("Garuda Racing").options;
    expect((await alice().query("select public.choose_supplier('Engine', -1)")).error).toMatch(/isn't available/);
    expect((await alice().query("select public.choose_supplier('Engine', $1)", [opts.Brakes[0].id])).error).toMatch(/isn't available/);
    expect((await alice().query("select public.choose_supplier('Engine', $1)", [opts.Engine[1].id])).error).toBeNull();
    expect((await alice().query("select public.choose_supplier('Fuel', $1)", [opts.Fuel[0].id])).error).toBeNull();
    expect((await choices(alice())).map((c) => [c.supplier_type, c.supplier_id])).toEqual([["Engine", opts.Engine[1].id], ["Fuel", opts.Fuel[0].id]]);
    expect((await alice().query("select public.clear_supplier_choice('Fuel')")).error).toBeNull();
    expect((await choices(alice())).map((c) => c.supplier_type)).toEqual(["Engine"]);
  });

  it("keeps choices private and refuses once the car is built", async () => {
    expect(await choices(bob())).toEqual([]);
    expect((await t.as("anon", null, "select * from supplier_choices")).rows).toEqual([]);
    expect((await t.member("org").query("select team from supplier_choices")).rows).toEqual([{ team: "Garuda Racing" }]);
    expect((await alice().query("select public.supplier_window_car('Octane Racing')")).error).toMatch(/permission denied/);
    await t.service(`update team_snapshots set private = jsonb_set(private, '{design,nextYearCar,state}', '"complete"') where team = 'Garuda Racing'`);
    expect((await alice().query("select public.clear_supplier_choice('Engine')")).error).toMatch(/already built/);
  });
});

describe("pull: next season's suppliers", () => {
  const offer = (id: number, type: string) => ({ id, type, name: `${type} ${id}`, tier: 2, price: 1, stats: {} });
  const car = (state: NextYearCar["state"], season = 2017): NextYearCar => ({
    state, season,
    current: { Engine: offer(1, "Engine"), Brakes: offer(10, "Brakes"), Fuel: offer(99, "Fuel") },
    options: { Engine: [offer(1, "Engine"), offer(2, "Engine")], Brakes: [offer(10, "Brakes"), offer(11, "Brakes")], Fuel: [offer(20, "Fuel")] },
  });
  const row = (team: string, supplier_type: string, supplier_id: number, season = 2017) => ({ team, season, supplier_type, supplier_id });

  it("applies choices once MM designs the car, and keeps current suppliers otherwise", () => {
    const r = supplierChanges(
      [row("A", "Engine", 2), row("A", "Brakes", 11, 2016), row("B", "Engine", 2), row("C", "Brakes", 99)],
      new Map([["A", car("designing")], ["B", car("waiting")], ["C", car("designing")], ["AI", car("designing")]]),
      ["A", "B", "C"],
    );
    expect(r.changes).toEqual([
      // Last season's brakes choice doesn't count; this season's fuel isn't offered any more, so MM's pick stays.
      { op: "setSuppliers", team: "A", suppliers: { Engine: 2, Brakes: 10 } },
      { op: "setSuppliers", team: "C", suppliers: { Engine: 1, Brakes: 10 } },
    ]);
    expect(r.waiting).toEqual(["B"]);
    expect(r.unavailable).toEqual(["C Brakes 99"]);
  });
});
