import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { personName, Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { setFitting, teamDesign } from "../src/ops/design.ts";
import { carInvestment, supplierOptions } from "../src/ops/suppliers.ts";
import { abilities } from "../src/ops/contracts.ts";
import type { Obj } from "../src/graph.ts";
import { planDesign, TO_THE_BACK } from "../src/part-design.ts";
import { loadBaseColourTable } from "../src/team-colours.ts";

// A new FIRE Fantasy 20 career (2020, before round 1). Set MM_FF20_SAVE to point at your own.
const SAVE = process.env.MM_FF20_SAVE ?? join(defaultSavesDir(), "SaveFF20 F1 Test.sav");

describe.skipIf(!existsSync(SAVE))("FIRE Fantasy 20 save", () => {
  const save = Save.load(SAVE);
  const league = { championship: "Formula 1", members: [{ member: "a", team: "Williams Grand Prix" }] };

  it("is typed by FF20's schema and writes back unchanged", () => {
    expect(save.game).toBe("ff20");
    save.prepareForWrite();
    expect(save.g.validate()).toEqual([]);
  });

  it("extracts FF20's colours, 0-1000 part stats and sponsor tiers", () => {
    const state = extractLeague(save, league);
    const team = state.teams.find((t) => t.name === "Williams Grand Prix")!;
    const base = loadBaseColourTable("ff20");
    const row = base.rows.find((r) => Number(r[0]) === team.look!.colorID)!;
    expect(team.look!.colours?.primary).toBe(row[base.header.indexOf("Primary")].toLowerCase());
    const stats = Object.values(team.parts).flat().map((p) => p.stat ?? 0);
    expect(Math.max(...stats)).toBeGreaterThan(100);
    for (const s of team.sponsors ?? []) expect(s.category).toMatch(/tier/);
  });

  it("designs parts with FF20's rules: no development rates, x2 improvability, AI 1 % and 10 days faster", () => {
    const team = save.team("Williams Grand Prix");
    const brakes = teamDesign(save, team).types.Brakes!;
    expect(brakes.ctx.rules).toBe("ff20");
    expect(brakes.base.developmentRate).toBe(1);
    const comp = brakes.components.find((c) => !c.engineer && c.days === 0 && c.level === 1)!;
    const ai = planDesign(brakes.ctx, [comp]);
    const player = planDesign({ ...brakes.ctx, isPlayer: true }, [comp]);
    expect(player.days - ai.days).toBe(Math.min(10, player.days));
    expect(ai.gameCost).toBeLessThan(player.cost);
  });

  it("describes components with the game's texts, {Stat} as the part's stat", () => {
    const design = teamDesign(save, save.team("Williams Grand Prix"));
    const comps = Object.values(design.types).flatMap((t) => t!.components);
    // FF20 components have no custom name ("0"); their text is the localised name ID.
    expect(comps.filter((c) => !c.summary || c.summary === "0" || /[{}]|<font/.test(c.summary))).toEqual([]);
    expect(design.types.Brakes!.components.some((c) => c.summary.includes("<b>Braking:</b>"))).toBe(true);
  });

  it("uses FF20's scale: car fund per race, drivers' ability / 41.4 with stats up to 25", () => {
    const team = save.team("Williams Grand Prix");
    const inv = carInvestment(save, team);
    const races = save.g.list(save.championship(team).calendar).length;
    expect(inv.per).toBe("race");
    expect(inv.monthly[1]).toBe(Math.round(15e6 / races / 1000) * 1000);
    const hamilton = save.teams().flatMap((t) => save.slots(t)).map((s) => s.personHired && save.g.deref<Obj>(s.personHired))
      .find((p) => p && personName(p) === "Lewis Hamilton")!;
    expect(abilities(save, hamilton).ability).toBeLessThan(5);
    expect(abilities(save, hamilton).ability).toBeGreaterThan(3.5);
  });

  it("offers FF20's liveries as renders of its F1 car, named and with the teams that run them", () => {
    const state = extractLeague(save, league);
    const liveries = state.championship.liveries!;
    const mercedes = state.teams.find((t) => t.name === "Mercedes AMG Motorsport")!;
    const own = liveries.find((l) => l.id === mercedes.look!.liveryID)!;
    expect(own).toMatchObject({ model: "ff20-f1", name: "FF20 design 1", mask: "ff20-f1-liverybase_1--liverydetail_1.png", texture: "ff20-uv-liverybase_1--liverydetail_1.png" });
    expect(own.usedBy).toContain("Mercedes AMG Motorsport");
    expect(liveries.every((l) => l.model === "ff20-f1" && l.texture)).toBe(true);
  });

  it("offers every supplier of the series' tier the team may buy (no draw)", () => {
    const williams = supplierOptions(save, save.team("Williams Grand Prix"));
    const haas = supplierOptions(save, save.team("Haas Formula Racing"));
    expect(williams.Engine?.length).toBeGreaterThan(2);
    // Each FF20 team has its own engine list.
    expect(williams.Engine!.map((e) => e.name)).not.toEqual(haas.Engine!.map((e) => e.name));
  });
});

// The same career after round 1 (Sydney), where FF20's scrutineers caught a part.
const POST = process.env.MM_FF20_POST_SAVE ?? join(defaultSavesDir(), "SaveFF20 F1 Test Post race.sav");

describe.skipIf(!existsSync(POST))("FIRE Fantasy 20 save after a race", () => {
  const save = Save.load(POST);
  const league = { championship: "Formula 1", members: [] };

  it("publishes FF20's scrutineering: to the back, $250K per offence, the part banned and kept off the car", () => {
    const state = extractLeague(save, league);
    expect(state.championship.game).toBe("ff20");
    const bust = state.championship.rulesBreaches![0];
    expect(bust.placesLost).toBe(TO_THE_BACK);
    expect(bust.fine % 250_000).toBe(0);
    const team = save.team(bust.team!);
    const banned = (["FrontWing", "RearWing", "Brakes", "Suspension", "Engine", "Gearbox"] as const)
        .flatMap((t) => save.parts(team, t).map((p) => ({ t, p }))).find(({ p }) => p.isBanned)!;
    expect(banned).toBeTruthy();
    expect(Object.values(state.teams.find((t) => t.name === team.name)!.parts).flat().find((p) => p.guid === banned.p.id)?.banned).toBe(true);
    const log = setFitting(save, { op: "setFitting", team: team.name, fitting: [{ car: 0, type: banned.t, part: banned.p.id }] });
    expect(log.join()).toMatch(/is banned/);
    expect(banned.p.isFitted).toBeFalsy();
  });
});
