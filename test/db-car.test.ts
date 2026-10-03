import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { carChanges } from "../src/car-orders.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = { members: [
  { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
  { member: "alice", team: "Garuda Racing", discord: "alice" },
] };

describe.skipIf(!existsSync(SAVE))("database: next year's chassis and car fund", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const alice = () => t.member("alice"), org = () => t.member("org");
  const car = (chassisDesign: boolean, options: boolean) => ({ state: "waiting", season: 2017, current: {}, options: options ? { Engine: [{ id: 1, type: "Engine", name: "E", tier: 1, price: 1, stats: {} }] } : {}, chassisDesign });
  const setCar = (c: object) => t.service(`update team_snapshots set private = jsonb_set(private, '{design,nextYearCar}', $1::jsonb) where team = 'Garuda Racing'`, [JSON.stringify(c)]);

  beforeAll(async () => {
    const state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
  }, 120_000);

  it("sets the car fund level any time; not for the career team", async () => {
    expect((await alice().query("select public.set_car_investment(2)")).error).toBeNull();
    expect((await alice().query("select public.set_car_investment(5)")).error).toMatch(/Low|0/);
    expect((await alice().query<{ level: number }>("select level from car_investment")).rows).toEqual([{ level: 2 }]);
    expect((await org().query("select public.set_car_investment(1)")).error).toMatch(/career team/);
  });

  it("stores the chassis sliders in the supplier window, main championship only", async () => {
    await setCar(car(true, false));
    expect((await alice().query("select public.set_chassis(0.8, 0.3)")).error).toMatch(/after the final race/);
    await setCar(car(false, true));
    expect((await alice().query("select public.set_chassis(0.8, 0.3)")).error).toMatch(/main championship/);
    await setCar(car(true, true));
    expect((await alice().query("select public.set_chassis(0.8, 0.3)")).error).toBeNull();
    expect((await alice().query("select public.set_chassis(0.9, 0.3)")).error).toBeNull();
    const rows = (await alice().query<{ season: number; nose: number }>("select season, nose from chassis_choices")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].season).toBe(2017);
    expect(Number(rows[0].nose)).toBeCloseTo(0.9);
  });

  it("turns choices into changes: the fund always, the chassis once MM designs the car", () => {
    const cars = new Map([["Garuda Racing", { ...car(true, true), state: "designing" } as never]]);
    const out = carChanges([{ team: "Garuda Racing", season: 2017, nose: "0.9", rear: 0.3 }], [{ team: "Garuda Racing", level: 2 }], cars, ["Garuda Racing"]);
    expect(out.changes).toEqual([
      { op: "setCarInvestment", team: "Garuda Racing", level: 2 },
      { op: "setChassis", team: "Garuda Racing", nose: 0.9, rear: 0.3 },
    ]);
    const waiting = carChanges([{ team: "Garuda Racing", season: 2017, nose: 0.9, rear: 0.3 }], [], new Map([["Garuda Racing", car(true, true) as never]]), ["Garuda Racing"]);
    expect(waiting.changes).toEqual([]);
    expect(waiting.waiting).toEqual(["Garuda Racing"]);
  });
});
