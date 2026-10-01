import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { extractLeague } from "../src/extract.ts";
import type { LeagueState } from "../src/league-types.ts";
import { Save } from "../src/model.ts";
import { carPartDesign } from "../src/ops/design.ts";
import { planDesign } from "../src/part-design.ts";
import { choiceChanges, designChanges, undoAiParts, type DesignOrderRow, type FittingRow, type ImprovementRow } from "../src/part-orders.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const BUDGET = 20_000_000;
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: part design, fitting and improvement", () => {
  let state: LeagueState;
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const org = () => t.member("org"), alice = () => t.member("alice"), bob = () => t.member("bob");
  const team = (name: string) => state.teams.find((x) => x.name === name)!;
  const order = (who: ReturnType<typeof org>, type: string, ids: number[]) =>
    who.query<{ id: number }>("select public.order_design($1, $2) as id", [type, ids]);

  beforeAll(async () => {
    state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    const r = await t.service("select public.publish_snapshot($1, $2) as id", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))]);
    expect(r.error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '${BUDGET}')
                     where team in ('Tatra Racing', 'Garuda Racing', 'Octane Racing')`);
  }, 120_000);

  it("prices a design like the site, with MM's slot rules", async () => {
    const opts = team("Garuda Racing").design!.types.FrontWing;
    const comp = (id: number) => opts.components.find((c) => c.id === id)!;
    const engineer = opts.components.find((c) => c.engineer && c.bonuses.some((b) => b.type === "BonusSpecificLevelComponentAddNoDays"))!;
    const l2 = opts.components.filter((c) => !c.engineer && c.level === 2).map((c) => c.id);
    const l1 = opts.components.filter((c) => !c.engineer && c.level === 1).map((c) => c.id);
    // The engineer's component opens a bonus slot, so four components fit three slots.
    const ids = [engineer.id, l2[0], l2[1], l1[0]];
    const plan = planDesign(opts.ctx, ids.map(comp));
    expect(plan.bonusSlots).toHaveLength(1);

    // Too many: three level-1 parts and a level 2 in three slots.
    expect((await order(alice(), "FrontWing", [l1[0], l1[1], l1[2], l2[0]])).error).toMatch(/No free slot/);
    expect((await order(alice(), "FrontWing", [l1[0], l1[0]])).error).toMatch(/chosen twice/);
    expect((await order(alice(), "FrontWing", [999])).error).toMatch(/isn't available/);
    expect((await order(alice(), "Engine", [l1[0]])).error).toMatch(/isn't available/);

    const { rows, error } = await order(alice(), "FrontWing", ids);
    expect(error).toBeNull();
    const row = (await alice().query<{ cost: string }>("select cost from design_orders where id = $1", [rows[0].id])).rows[0];
    expect(Number(row.cost)).toBe(plan.cost);
    // MM designs one part at a time.
    expect((await order(alice(), "Brakes", [l1[0]])).error).toMatch(/already have a design queued/);
  });

  it("blocks ordering while the team's design runs, keeps orders private, cancellable and in budget", async () => {
    // Tatra's design in the save started before the league: it runs on.
    const tatra = team("Tatra Racing").design!;
    expect(tatra.current).not.toBeNull();
    const id = tatra.types.FrontWing.components.find((c) => !c.engineer && c.level === 1)!.id;
    expect((await order(org(), "FrontWing", [id])).error).toMatch(/still designing a part until/);

    expect((await bob().query("select team from design_orders")).rows).toEqual([]);
    expect((await org().query("select team from design_orders")).rows).toEqual([{ team: "Garuda Racing" }]);
    const mine = (await alice().query<{ id: number; cost: string }>("select id, cost from design_orders")).rows[0];
    expect((await bob().query("select public.cancel_design($1)", [mine.id])).error).toMatch(/No queued design/);

    // The queued design commits budget: an HQ order for more than what's left is refused.
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', $1::text::jsonb) where team = 'Garuda Racing'`,
      [String(Number(mine.cost) + 1000)]);
    const building = team("Garuda Racing").hq.find((b) => b.state === "NotBuilt" && b.initialCost && b.dependencies.length === 0)!;
    expect((await alice().query("select public.order_hq($1)", [building.type])).error).toMatch(/Not enough budget/);
    expect((await alice().query("select public.cancel_design($1)", [mine.id])).error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '${BUDGET}') where team = 'Garuda Racing'`);

    // A design the AI started after the league began doesn't block: the next apply cancels it.
    await t.service(`update team_snapshots set private = jsonb_set(private, '{design,current,start}', '"2099-01-01T00:00:00.0000000"') where team = 'Tatra Racing'`);
    const ordered = await order(org(), "FrontWing", [id]);
    expect(ordered.error).toBeNull();
    expect((await org().query("select public.cancel_design($1)", [ordered.rows[0].id])).error).toBeNull();
  });

  it("stores fitting and improvement, without stripping a car or overfilling a list", async () => {
    const parts = team("Octane Racing").parts.FrontWing;
    const onCar0 = parts.find((p) => p.fittedToCar === 0)!;
    const spare = parts.find((p) => p.fittedToCar === null)!;
    const fit = (car: number, guid: string) => bob().query("select public.set_fitting($1, 'FrontWing', $2)", [car, guid]);
    // Car 1 can't take car 0's wing unless car 0 gets another one.
    expect((await fit(1, onCar0.guid)).error).toMatch(/is on car 1/);
    expect((await fit(0, spare.guid)).error).toBeNull();
    expect((await fit(1, onCar0.guid)).error).toBeNull();
    expect((await fit(0, team("Garuda Racing").parts.FrontWing[0].guid)).error).toMatch(/no such part/);
    expect((await alice().query("select * from part_fitting")).rows).toEqual([]);

    const imp = team("Octane Racing").design!.improvement;
    const guids = Object.values(team("Octane Racing").parts).flat().map((p) => p.guid);
    const set = (perf: string[], rel: string[], split = 0.5) =>
      bob().query("select public.set_improvement($1, $2, $3)", [perf, rel, split]);
    expect((await set(guids.slice(0, imp.slots + 1), [])).error).toMatch(/At most/);
    expect((await set([guids[0], guids[0]], [])).error).toMatch(/listed twice/);
    expect((await set([guids[0]], [], 2)).error).toMatch(/between 0 and 1/);
    expect((await set([guids[0]], [guids[1]], 0.25)).error).toBeNull();
    expect((await set([guids[0]], [guids[1]], 0.4)).error).toBeNull();
    const row = (await bob().query<ImprovementRow>("select * from part_improvement")).rows;
    expect(row).toMatchObject([{ team: "Octane Racing", performance: [guids[0]], reliability: [guids[1]] }]);
    expect(Number(row[0].split)).toBe(0.4);
  });

  it("turns designs, fitting and improvement into save changes that apply to the real save", async () => {
    const opts = team("Garuda Racing").design!.types.Brakes;
    const ids = [opts.components.find((c) => !c.engineer && c.level === 2)!.id, opts.components.find((c) => !c.engineer && c.level === 1)!.id];
    expect((await order(alice(), "Brakes", ids)).error).toBeNull();
    const orders = (await t.service<DesignOrderRow>("select * from design_orders where status = 'queued'")).rows;
    const fitting = (await t.service<FittingRow>("select * from part_fitting")).rows;
    const improvement = (await t.service<ImprovementRow>("select * from part_improvement")).rows;
    const changes = [
      ...undoAiParts(["Tatra Racing", "Garuda Racing", "Octane Racing"], orders, state.gameDate),
      ...designChanges(orders),
      ...choiceChanges(fitting, improvement),
    ];
    const save = Save.load(SAVE);
    const garuda = save.team("Garuda Racing");
    const budget = Number(save.finance(garuda).currentBudget);
    const log = applyChanges(save, { changes });
    expect(log.join("\n")).toMatch(/Garuda Racing: designing Brakes/);
    expect(Number(save.finance(garuda).currentBudget)).toBe(budget - Number(orders[0].cost));
    expect(carPartDesign(save, garuda).mStage).toBe(1);
    const octane = save.team("Octane Racing");
    const fitted = (car: number) => save.parts(octane, "FrontWing").find((p) => p.isFitted && save.g.deref(p.fittedCar) === save.cars(octane)[car])!.id;
    for (const f of fitting) expect(fitted(f.car)).toBe(f.part_guid);
    save.prepareForWrite();
    expect(save.g.validate()).toEqual([]);
  }, 120_000);
});
