import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { typeMismatches } from "../src/schema.ts";

// Uses a real mid-season save (ERS, round 6). Set MM_TEST_SAVE to point at your own.
const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const league = { members: [{ member: "alice", team: "Garuda Racing" }, { member: "bob", team: "Octane Racing" }] };

/** Serialize and parse again, as writing and reloading the file would. */
function reload(save: Save): Save {
  save.prepareForWrite();
  const f = save.file;
  const raw = unpack(pack({ version: f.version, headerText: stringifyLossless(f.header), dataText: stringifyLossless(f.data) }));
  return new Save({ version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) });
}

/**
 * After a reload every definition must still have a known type: either its slot's declared
 * type or an explicit "$type".
 */
function typeProblems(save: Save): string[] {
  const out: string[] = [];
  save.types.walk(save.data, (o, declared) => {
    if (typeof o.$id !== "string") return;
    if (!declared && typeof o.$type !== "string") out.push(`untyped #${o.$id}`);
  });
  return out;
}

describe.skipIf(!existsSync(SAVE))("operations on a real save", () => {
  it("applies HQ, budget, part and staff changes that survive a reload", () => {
    const save = Save.load(SAVE);
    const before = extractLeague(save, league);
    const garuda = before.teams.find((t) => t.name === "Garuda Racing")!;
    const octane = before.teams.find((t) => t.name === "Octane Racing")!;
    const staff = (t: typeof garuda, job: string) => t.staff.filter((s) => s.job === job && s.person).map((s) => s.person!);
    const freeEngineer = before.freeAgents.find((p) => p.kind === "Engineer")!;
    const freeMechanic = before.freeAgents.find((p) => p.kind === "Mechanic")!;
    const freeDriver = before.freeAgents.find((p) => p.kind === "Driver")!;
    const octaneDriver = staff(octane, "Driver")[0];
    const [gDriver0, gDriver1] = staff(garuda, "Driver");

    applyChanges(save, {
      changes: [
        { op: "setBuilding", team: "Garuda Racing", building: "Wind Tunnel", level: 2 },
        { op: "setBudget", team: "Garuda Racing", amount: 12_345_678 },
        { op: "addPart", team: "Garuda Racing", type: "FrontWing", name: "F-TEST", stat: 42, reliability: 0.9, fitToCar: 1 },
        { op: "hire", team: "Garuda Racing", person: freeEngineer.guid, replacing: staff(garuda, "EngineerLead")[0].guid },
        { op: "hire", team: "Garuda Racing", person: freeMechanic.guid, replacing: staff(garuda, "Mechanic")[0].guid },
        { op: "hire", team: "Garuda Racing", person: freeDriver.guid, replacing: gDriver1.guid },
        { op: "hire", team: "Garuda Racing", person: octaneDriver.guid, replacing: gDriver0.guid },
      ],
    });
    save.prepareForWrite();
    expect(typeMismatches(save.types, save.data)).toEqual([]);
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);

    const after = extractLeague(reloaded, league);
    const g2 = after.teams.find((t) => t.name === "Garuda Racing")!;
    const o2 = after.teams.find((t) => t.name === "Octane Racing")!;
    expect(g2.budget).toBe(12_345_678);
    expect(g2.hq.find((b) => b.name === "Wind Tunnel")!.level).toBe(2);
    const wing = g2.parts.FrontWing.find((p) => p.name === "F-TEST")!;
    expect(wing).toMatchObject({ stat: 42, reliability: 0.9, fittedToCar: 1 });
    expect(g2.parts.FrontWing.filter((p) => p.fittedToCar === 1)).toHaveLength(1);
    expect(staff(g2, "EngineerLead")[0].guid).toBe(freeEngineer.guid);
    expect(staff(g2, "Driver").map((p) => p.guid)).toEqual(expect.arrayContaining([freeDriver.guid, octaneDriver.guid]));
    expect(staff(o2, "Driver").map((p) => p.guid)).toContain(gDriver0.guid);
    expect(after.freeAgents.map((p) => p.guid)).toContain(gDriver1.guid);
    expect(after.championship.standings.drivers.map((d) => d.guid)).toContain(freeDriver.guid);

    // Every employed person needs an open career entry at their current team.
    for (const name of ["Garuda Racing", "Octane Racing"]) {
      const t = reloaded.team(name);
      for (const slot of reloaded.slots(t).filter((s) => s.personHired)) {
        const p = reloaded.g.deref<any>(slot.personHired);
        const last = reloaded.g.rawList(reloaded.g.deref<any>(p.careerHistory).mCareer).at(-1);
        expect(last, `${p.name} career`).toBeTruthy();
        expect(reloaded.g.deref(last.team), `${p.name} career team`).toBe(t);
      }
    }

    // Employed people have a contract-end calendar event aimed at their own contract; free agents none.
    const events = reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents);
    for (const guid of [freeEngineer.guid, freeMechanic.guid, freeDriver.guid, octaneDriver.guid, gDriver0.guid]) {
      const p = reloaded.person(guid);
      const c = reloaded.contract(p);
      const ev = reloaded.g.deref<any>(c.mCalendarEvent);
      expect(ev, `${p.name} contract event`).toBeTruthy();
      expect(reloaded.g.deref(ev.OnEventTrigger.targets[0])).toBe(c);
      expect(ev.triggerDate).toBe(c.mEndDate);
      expect(events.includes(ev), `${p.name} event in calendar`).toBe(true);
    }
    expect(reloaded.contract(reloaded.person(gDriver1.guid)).mCalendarEvent).toBeNull();
    const dates = events.map((e) => e.triggerDate as string);
    expect(dates).toEqual([...dates].sort());

    // Every mechanic needs a relationship record with every driver, or the race weekend crashes.
    for (const name of ["Garuda Racing", "Octane Racing"]) {
      const t = reloaded.team(name);
      const people = reloaded.slots(t).filter((s) => s.personHired).map((s) => ({ job: s.jobType, p: reloaded.g.deref<any>(s.personHired) }));
      for (const m of people.filter((x) => x.job === 7)) {
        for (const d of people.filter((x) => x.job === 0)) {
          expect(m.p.mDictDriversRelationships?.[d.p.name], `${m.p.name} -> ${d.p.name}`).toBeTruthy();
        }
      }
    }
  }, 120_000);

  it("rejects invalid changes before writing anything", () => {
    const save = Save.load(SAVE);
    expect(() => applyChanges(save, { changes: [{ op: "setBuilding", team: "Garuda Racing", building: "Wind Tunnel", level: 99 }] }))
      .toThrow(/Change #1 \(setBuilding\)/);
  }, 60_000);
});
