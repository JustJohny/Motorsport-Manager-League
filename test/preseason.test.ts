import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { num } from "../src/codec/sav.ts";
import { Save } from "../src/model.ts";
import { nextYearDesignState, pendingSuppliers, supplierOptions } from "../src/ops/suppliers.ts";
import { defaultSavesDir } from "../src/paths.ts";

// A real ERS save from the day MM's pre-season started (13 Dec 2016): the AI teams are designing
// next year's car, and every part was rebuilt by MM's season reset.
const SAVE = process.env.MM_PRESEASON_SAVE ?? join(defaultSavesDir(), "SaveLeague Test 12 (1).sav");

describe.skipIf(!existsSync(SAVE))("a real pre-season save", () => {
  const save = existsSync(SAVE) ? Save.load(SAVE) : (null as never);

  it("has MM's supplier draw and the AI's pending designs", () => {
    const garuda = save.team("Garuda Racing");
    expect(nextYearDesignState(save, garuda)).toBe("designing");
    const opts = supplierOptions(save, garuda);
    expect(opts.Engine?.length).toBeGreaterThan(0);
    expect(opts.Materials?.length).toBeGreaterThan(0);
    // The AI picked from what it may buy.
    for (const [type, s] of Object.entries(pendingSuppliers(save, garuda))) {
      if (type === "Battery" || type === "ERSAdvanced") continue;
      expect(opts[type as keyof typeof opts]!.map((o) => o.id), type).toContain(s!.id);
    }
  });

  it("keeps the chassis stats at MM's floor of 0 when suppliers change", () => {
    const g = save.g;
    const garuda = save.team("Garuda Racing");
    const ny = g.deref<any>(g.deref<any>(garuda.carManager).nextYearCarDesign);
    const cs = g.deref<any>(ny.mChassisStats);
    // Steinmann X, Micronix #40, Imperial #43, Tectra #45 plus the AI's +4 fuel efficiency.
    expect([cs.mTyreWear, cs.mTyreHeating, cs.mFuelEfficiency, cs.mImprovability].map(num)).toEqual([0, 3, 5, 0]);
    applyChanges(save, { changes: [{ op: "setSuppliers", team: "Garuda Racing", suppliers: { Brakes: 41, Fuel: 42, Materials: 47 } }] });
    // Brakes #41 and XCT take tyre wear and heating below 0, MM floors them; the AI's +4 stays.
    expect([cs.mTyreWear, cs.mTyreHeating, cs.mFuelEfficiency, cs.mImprovability].map(num)).toEqual([0, 0, 6, 0]);
  });

  it("doesn't take MM's season-reset parts for AI designs", () => {
    const log = applyChanges(save, { changes: [{ op: "removeUnorderedParts", teams: ["Octane Racing"], since: "2016-03-01T00:00:00.0000000", keep: [] }] });
    expect(log).toEqual(["No unordered parts on member teams"]);
  });
}, 120_000);

// The same career at season end (6 Dec 2016): MM has picked each tier's champion and last place,
// and swaps them when pre-season starts (Eastwood up from the ERS, Krüger down from the APSC).
const SEASON_END = process.env.MM_SEASON_END_SAVE ?? join(defaultSavesDir(), "SaveLeague Test 12.sav");

describe.skipIf(!existsSync(SEASON_END))("holding promotions at season end", () => {
  it("marks the league's championship and the one below as done, as MM's refusal does", () => {
    const save = Save.load(SEASON_END);
    const champs = save.g.list<any>(save.data.championshipManager.mEntities);
    const byId = (id: number) => champs.find((c) => c.championshipID === id);
    const promo = (id: number) => save.g.deref<any>(byId(id).mChampionshipPromotions);
    expect(save.g.deref<any>(promo(2).champion).name).toBe("Eastwood Motorsport");

    // ERS (bottom tier): only its champion's promotion is held.
    const log = applyChanges(save, { changes: [{ op: "holdPromotions", team: "Tatra Racing" }] });
    expect(log[0]).toMatch(/European Racing Series ↔ Asia-Pacific Super Cup/);
    expect(byId(2).completedPromotions).toBe(true);
    expect([promo(2).championStatus, promo(1).championStatus]).toEqual([3, 4]);
    expect(byId(1).completedPromotions).toBe(false);
    // Idempotent: every pull sends it.
    expect(applyChanges(save, { changes: [{ op: "holdPromotions", team: "Tatra Racing" }] })[0]).toMatch(/already held/);

    // WMC (top tier): its last place stays, through the APSC below.
    expect(applyChanges(save, { changes: [{ op: "holdPromotions", team: "Panther Race Team" }] })[0]).toMatch(/Asia-Pacific Super Cup ↔ World Motorsport Championship/);
    expect(byId(1).completedPromotions).toBe(true);
    expect(byId(0).completedPromotions).toBe(false);
  });
}, 120_000);
