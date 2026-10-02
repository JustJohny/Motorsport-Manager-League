import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { improvementEstimate } from "../src/part-improvement.ts";

const saves = ["SaveLeague Test 10.sav", "SaveLeague Test 5.sav", "SaveJonatan Sulik - Tatra Racing 2 (3).sav"]
  .map((f) => join(defaultSavesDir(), f)).filter(existsSync);
const IMPROVE = { reliability: 1, performance: 3 } as const;

describe("part improvement estimate", () => {
  it.each(saves)("matches MM's own end dates from the published data (%s)", (path) => {
    const save = Save.load(path);
    const state = extractLeague(save, { members: [{ member: "org", team: "Tatra Racing", discord: "org" }] });
    let checked = 0;
    for (const t of state.teams) {
      const imp = t.design?.improvement;
      if (!imp) continue;
      const pi = save.g.deref<any>(save.g.deref<any>(save.team(t.name).carManager).partImprovement);
      const mm = (k: number) => pi.partWorkEndDate.find((e: any) => e.Key === k).Value as string;
      const est = improvementEstimate(imp, Object.values(t.parts).flat(), imp, state.gameDate);
      for (const list of ["performance", "reliability"] as const) {
        const e = est[list];
        if (!e?.end || !e.workDays) continue;
        // MM's own split, which the AI sets by hand, may differ from the published split's rounding.
        if (e.mechanics !== pi.mechanics.find((m: any) => m.Key === IMPROVE[list]).Value) continue;
        const diff = Math.abs(e.end.getTime() - new Date(mm(IMPROVE[list]).slice(0, 19) + "Z").getTime());
        // Float drift over hundreds of working days stays within seconds.
        expect(diff, `${t.name} ${list}`).toBeLessThan(10_000);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  }, 60_000);
});
