import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { teamDesign } from "../src/ops/design.ts";
import { supplierOptions } from "../src/ops/suppliers.ts";
import { planDesign } from "../src/part-design.ts";
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

  it("offers every supplier of the series' tier the team may buy (no draw)", () => {
    const williams = supplierOptions(save, save.team("Williams Grand Prix"));
    const haas = supplierOptions(save, save.team("Haas Formula Racing"));
    expect(williams.Engine?.length).toBeGreaterThan(2);
    // Each FF20 team has its own engine list.
    expect(williams.Engine!.map((e) => e.name)).not.toEqual(haas.Engine!.map((e) => e.name));
  });
});
