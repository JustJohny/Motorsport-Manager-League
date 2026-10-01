import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { num } from "../src/codec/sav.ts";
import { Save } from "../src/model.ts";
import { currentSuppliers, supplierOptions } from "../src/ops/suppliers.ts";
import { defaultSavesDir } from "../src/paths.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");

describe.skipIf(!existsSync(SAVE))("next season's suppliers", () => {
  it("swaps MM's AI picks for a member's choice in next year's design", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    const team = save.team("Garuda Racing");
    const opts = supplierOptions(save, team);
    expect(Object.keys(opts)).toEqual(expect.arrayContaining(["Engine", "Brakes", "Fuel", "Materials"]));
    // Before pre-season there's no design to change.
    const engine = opts.Engine!.find((s) => s.id !== currentSuppliers(save, team).Engine?.id)!;
    expect(() => applyChanges(save, { changes: [{ op: "setSuppliers", team: "Garuda Racing", suppliers: { Engine: engine.id } }] })).toThrow(/pre-season/);

    // As MM's AI does at pre-season: a pending design with a chassis like this season's.
    const ny = g.deref<any>(g.deref<any>(team.carManager).nextYearCarDesign);
    const current = g.deref<any>(save.cars(team)[0].chassisStats);
    ny.mChassisStats = g.clone({ ...current });
    ny.state = 0;
    const cs = g.deref<any>(ny.mChassisStats);
    const old = g.deref<any>(cs.supplierEngine);
    const fuelBefore = num(cs.mFuelEfficiency);
    const budget = Number(save.finance(team).currentBudget);
    const log = applyChanges(save, { changes: [{ op: "setSuppliers", team: "Garuda Racing", suppliers: { Engine: engine.id } }] });
    expect(log.join("\n")).toMatch(new RegExp(`→ ${engine.name}`));
    expect(g.deref<any>(cs.supplierEngine).id).toBe(engine.id);
    const statOf = (s: any, k: number) => {
      const d = s.supplierStats; const e = Array.isArray(d) ? d.find((x: any) => x.Key === k) : null;
      return e ? num(e.Value) : 0;
    };
    expect(num(cs.mFuelEfficiency)).toBeCloseTo(fuelBefore + (engine.stats[2] ?? 0) - statOf(old, 2), 4);
    const oldPrice = currentSuppliers(save, team).Engine ? opts.Engine!.find((s) => s.id === old.id)?.price ?? 0 : 0;
    if (oldPrice) expect(Number(save.finance(team).currentBudget)).toBe(budget + oldPrice - engine.price);
    save.prepareForWrite();
    expect(save.g.validate()).toEqual([]);
  }, 120_000);
});
