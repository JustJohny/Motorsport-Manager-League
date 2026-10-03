import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { chassisStats, sliderRange, type ChassisSupplier } from "../src/chassis.ts";
import { num } from "../src/codec/sav.ts";
import { Save } from "../src/model.ts";
import { carInvestment, pendingSuppliers } from "../src/ops/suppliers.ts";
import { defaultSavesDir } from "../src/paths.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");

describe("MM's chassis design maths", () => {
  const sups: ChassisSupplier[] = [
    { type: "Engine", stats: { 2: 2, 3: 14 }, minBound: { 0: 0, 1: 0.05 } },
    { type: "Brakes", stats: { 0: 1 }, maxBound: { 0: 0.1, 1: 0.15 } },
    { type: "Fuel", stats: { 2: 3 }, minBound: { 0: 0.2, 1: 0.1 } },
    { type: "Materials", stats: { 1: 2 }, maxBound: { 0: 0.05, 1: 0 } },
  ];

  it("the middle of both sliders is the AI's default chassis (the suppliers' stats)", () => {
    expect(chassisStats(sups)).toEqual({ tyreWear: 1, tyreHeating: 2, fuelEfficiency: 5, improvability: 14 });
  });

  it("each slider trades ±5 between its pair, floored at 0 after every supplier", () => {
    // Nose all the way to fuel efficiency: +5 fuel; tyre wear −5, floored to 0 after the engine, then the brakes' +1.
    expect(chassisStats(sups, 1, 0.5)).toMatchObject({ fuelEfficiency: 10, tyreWear: 1 });
    // Rear all the way to tyre heating: improvability −5 + 14, tyre heating +5 + 2.
    expect(chassisStats(sups, 0.5, 0)).toMatchObject({ improvability: 9, tyreHeating: 7 });
  });

  it("the suppliers narrow each slider from both ends", () => {
    const r = sliderRange(sups);
    expect(r.nose[0]).toBeCloseTo(0.15); expect(r.nose[1]).toBeCloseTo(0.85);
    expect(r.rear[0]).toBeCloseTo(0.2); expect(r.rear[1]).toBeCloseTo(0.85);
  });
});

describe.skipIf(!existsSync(SAVE))("chassis and investment on a save", () => {
  it("rebuilds a WMC team's pending chassis from its sliders; not outside the main championship", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    const team = save.team("Steinmann Motorsport");
    expect(() => applyChanges(save, { changes: [{ op: "setChassis", team: team.name as string, nose: 1, rear: 0 }] })).toThrow(/pre-season/);
    // As MM's AI does at pre-season: a pending design with a chassis like this season's.
    const ny = g.deref<any>(g.deref<any>(team.carManager).nextYearCarDesign);
    ny.mChassisStats = g.clone({ ...g.deref<any>(save.cars(team)[0].chassisStats) });
    ny.state = 0;
    const sups = Object.values(pendingSuppliers(save, team));
    const range = sliderRange(sups);
    applyChanges(save, { changes: [{ op: "setChassis", team: team.name as string, nose: 1, rear: 0 }] });
    const cs = g.deref<any>(ny.mChassisStats);
    const want = chassisStats(sups, range.nose[1], range.rear[0]);
    expect(num(cs.mFuelEfficiency)).toBeCloseTo(want.fuelEfficiency, 4);
    expect(num(cs.mTyreWear)).toBeCloseTo(want.tyreWear, 4);
    expect(num(cs.mImprovability)).toBeCloseTo(want.improvability, 4);
    expect(num(cs.mTyreHeating)).toBeCloseTo(want.tyreHeating, 4);
    expect(() => applyChanges(save, { changes: [{ op: "setChassis", team: "Garuda Racing", nose: 1, rear: 0 }] })).toThrow(/main championship/);
  }, 120_000);

  it("sets the car fund level", () => {
    const save = Save.load(SAVE);
    const team = save.team("Garuda Racing");
    applyChanges(save, { changes: [{ op: "setCarInvestment", team: "Garuda Racing", level: 2 }] });
    const inv = carInvestment(save, team);
    expect(inv.level).toBe(2);
    expect(inv.monthly[0] < inv.monthly[1] && inv.monthly[1] < inv.monthly[2]).toBe(true);
  }, 120_000);
});
