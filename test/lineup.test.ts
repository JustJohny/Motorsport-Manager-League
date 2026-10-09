import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { num, pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import type { Obj } from "../src/graph.ts";
import { personName, Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { engineLevel } from "../src/ops/suppliers.ts";
import { DRIVER_STATUS } from "../src/ops/staff.ts";

// A new FIRE Fantasy 20 career (2020, before round 1). Set MM_FF20_SAVE to point at your own.
const SAVE = process.env.MM_FF20_SAVE ?? join(defaultSavesDir(), "SaveFF20 F1 Test.sav");
const TEAM = "Williams Grand Prix";

function reload(save: Save): Save {
  save.prepareForWrite();
  const f = save.file;
  const raw = unpack(pack({ version: f.version, headerText: stringifyLossless(f.header), dataText: stringifyLossless(f.data) }));
  return new Save({ version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) });
}

const drivers = (save: Save) => save.slots(save.team(TEAM)).filter((s) => s.jobType === 0)
  .map((s) => (s.personHired ? save.g.deref<Obj>(s.personHired) : null));
const mechanics = (save: Save) => save.slots(save.team(TEAM)).filter((s) => s.jobType === 7 && s.personHired)
  .map((s) => save.g.deref<Obj>(s.personHired));

describe.skipIf(!existsSync(SAVE))("pre-season line-up and supplier ops (FF20)", () => {
  it("promotes the reserve, swaps cars and mechanics, releases the reserve", () => {
    const save = Save.load(SAVE);
    const [d1, d2, reserve] = drivers(save);
    const mechanicCars = mechanics(save).map((m) => m.driver);
    const standings = () => save.g.list<Obj>(save.g.deref<Obj>(save.championship(save.team(TEAM)).standings).mDrivers)
      .map((r) => save.g.deref<Obj>(r.mEntity));
    expect(standings()).toContain(d2);
    expect(standings()).not.toContain(reserve);
    const status = save.contract(d2!).mCurrentStatus;

    applyChanges(save, { changes: [
      { op: "promoteDriver", team: TEAM, reserve: reserve!.id, driver: d2!.id },
      { op: "swapCarDrivers", team: TEAM },
      { op: "swapMechanics", team: TEAM },
    ] });
    const r = reload(save);
    expect(r.g.validate()).toEqual([]);
    const [a, b, c] = drivers(r);
    expect([a, b, c].map((p) => personName(p!))).toEqual([personName(reserve!), personName(d1!), personName(d2!)]);
    expect(r.contract(a!).mCurrentStatus).toBe(status);
    expect(r.contract(c!).mCurrentStatus).toBe(DRIVER_STATUS.Reserve);
    const st = r.g.list<Obj>(r.g.deref<Obj>(r.championship(r.team(TEAM)).standings).mDrivers).map((x) => r.g.deref<Obj>(x.mEntity).id);
    expect(st).toContain(reserve!.id);
    expect(st).not.toContain(d2!.id);
    const [n1, n2] = mechanics(r);
    expect([n1.driver, n2.driver]).toEqual([mechanicCars[1], mechanicCars[0]]);
    // Each mechanic knows the new race driver.
    for (const m of [n1, n2]) expect(Object.keys(m.mDictDriversRelationships)).toContain(reserve!.name);

    applyChanges(r, { changes: [{ op: "releasePerson", team: TEAM, person: d2!.id }] });
    expect(drivers(r)[2]).toBeNull();
    expect(r.isFreeAgent(r.person(d2!.id))).toBe(true);
    expect(() => applyChanges(r, { changes: [{ op: "releasePerson", team: TEAM, person: d1!.id }] })).toThrow(/only the reserve/);
    expect(reload(r).g.validate()).toEqual([]);
  }, 180_000);

  it("signs a free agent into an empty reserve seat as the reserve", () => {
    const save = Save.load(SAVE);
    const reserve = drivers(save)[2]!;
    const free = save.people().find((p) => save.isFreeAgent(p) && p.mCarID !== undefined && !p.mRetired)!;
    applyChanges(save, { changes: [{ op: "releasePerson", team: TEAM, person: reserve.id }] });
    applyChanges(save, { changes: [
      { op: "hire", team: TEAM, person: free.id, slotID: save.slots(save.team(TEAM)).find((s) => s.jobType === 0 && !s.personHired)!.slotID, yearlyWages: 1_000_000, endDate: "2021-12-31T00:00:00.0000000" },
    ] });
    expect(drivers(save)[2]).toBe(free);
    expect(save.contract(free).mCurrentStatus).toBe(DRIVER_STATUS.Reserve);
    expect(reload(save).g.validate()).toEqual([]);
  }, 180_000);

  it("switches this season's engine: chassis rebuilt, engine parts shifted by the level difference", () => {
    const save = Save.load(SAVE);
    const team = save.team(TEAM);
    const g = save.g;
    const cs = () => g.deref<Obj>(save.cars(team)[0].chassisStats);
    const engines = g.list<Obj>(save.data.supplierManager.engineSuppliers);
    const old = g.deref<Obj>(cs().supplierEngine);
    const renault = engines.find((s) => s.name === "Renault A" && s.mTier === old.mTier)!;
    const partsBefore = save.parts(team, "Engine").map((p) => num(p.mStats.mStat));
    const fe = num(cs().mFuelEfficiency), im = num(cs().mImprovability);
    const budget = num(g.deref<Obj>(team.financeController).finance.mCurrentBudget ?? 0);
    const log = applyChanges(save, { changes: [{ op: "setCurrentSupplier", team: TEAM, type: "Engine", id: renault.id }] });
    expect(log.join("\n")).toMatch(/Mercedes A → Renault A/);
    for (const car of save.cars(team)) expect(g.deref<Obj>(g.deref<Obj>(car.chassisStats).supplierEngine)).toBe(renault);
    const shift = engineLevel(renault) - engineLevel(old);
    expect(shift).toBe(93 - 128);
    expect(save.parts(team, "Engine").map((p) => num(p.mStats.mStat))).toEqual(partsBefore.map((v) => v + shift));
    // Renault A: fuel efficiency 6, improvability 6 (Mercedes A: 10, 2).
    expect(num(cs().mFuelEfficiency)).toBeCloseTo(fe - 10 + 6, 3);
    expect(num(cs().mImprovability)).toBeCloseTo(im - 2 + 6, 3);
    expect(num(g.deref<Obj>(team.financeController).finance.mCurrentBudget ?? 0)).toBe(budget);
    // Picking it again changes nothing.
    expect(applyChanges(save, { changes: [{ op: "setCurrentSupplier", team: TEAM, type: "Engine", id: renault.id }] })[0]).toMatch(/already on/);
    expect(reload(save).g.validate()).toEqual([]);
  }, 180_000);
});
