import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pointsCost, PROJECTS } from "../src/engine-rules.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: works engine programmes", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const alice = () => t.member("alice"), bob = () => t.member("bob");
  const spent = async (who: ReturnType<typeof alice>) =>
    (await who.query<{ s: string }>("select coalesce(sum(amount), 0) as s from engine_spend where status = 'queued'")).rows[0].s;

  beforeAll(async () => {
    const state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '60000000') where team = 'Garuda Racing'`);
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '20000000') where team = 'Octane Racing'`);
  }, 120_000);

  it("prices projects like the site", async () => {
    const rows = (await t.service<{ id: string; cost: string; illegal: boolean }>("select * from engine_projects order by id")).rows;
    expect(rows.map((r) => ({ id: r.id, cost: Number(r.cost), illegal: r.illegal })))
      .toEqual(PROJECTS.map((p) => ({ id: p.id, cost: p.cost, illegal: !!p.illegal })).sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("founds a programme within the budget and prices points rising", async () => {
    expect((await bob().query("select public.found_engine_programme('Octane Power')")).error).toMatch(/Not enough budget/);
    expect((await alice().query("select public.found_engine_programme('Garuda Motori')")).error).toBeNull();
    expect((await alice().query("select public.found_engine_programme('Again')")).error).toMatch(/already has/);
    expect(Number(await spent(alice()))).toBe(30_000_000);
    expect((await alice().query("select public.buy_engine_points('power', 3)")).error).toBeNull();
    expect((await alice().query("select public.buy_engine_points('fuel', 2)")).error).toBeNull();
    expect(Number(await spent(alice()))).toBe(30_000_000 + pointsCost(0, 3) + pointsCost(3, 2));
    expect((await alice().query("select public.set_engine_concept('power')")).error).toBeNull();
    expect((await alice().query("select public.choose_engine_project('fuelflow')")).error).toBeNull();
    expect((await alice().query("select public.choose_engine_project('fuelflow')")).error).toMatch(/already running/);
    const plan = (await alice().query<{ concept: string; points: Record<string, number>; projects: string[] }>("select concept, points, projects from engine_plans")).rows[0];
    expect(plan).toMatchObject({ concept: "power", points: { power: 3, fuel: 2 }, projects: ["fuelflow"] });
    // Plans and spending are private; the programme itself is public.
    expect((await bob().query("select * from engine_plans")).rows).toEqual([]);
    expect((await bob().query("select * from engine_spend")).rows).toEqual([]);
    expect((await bob().query<{ name: string }>("select name from engine_programmes")).rows).toEqual([{ name: "Garuda Motori" }]);
  });

  it("sells engines to other members for next season", async () => {
    expect((await bob().query("select public.buy_engine('Garuda Racing')")).error).toMatch(/doesn't sell/);
    expect((await alice().query("select public.set_engine_offer(true, 4000000, true)")).error).toBeNull();
    expect((await bob().query("select public.buy_engine('Garuda Racing')")).error).toBeNull();
    expect((await bob().query("select public.buy_engine('Garuda Racing')")).error).toMatch(/already bought/);
    expect(Number(await spent(bob()))).toBe(4_000_000);
    const sale = (await t.service<{ payee: string; amount: string }>("select payee, amount from engine_spend where kind = 'engine'")).rows[0];
    expect(sale).toMatchObject({ payee: "Garuda Racing" });
    // Queued engine spending counts against HQ orders too.
    expect(Number((await t.db.query<{ c: string }>("select public.hq_committed('Octane Racing') as c")).rows[0].c)).toBe(4_000_000);
  });
});
