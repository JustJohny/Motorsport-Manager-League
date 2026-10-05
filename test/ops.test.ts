import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { num, pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { typeMismatches } from "../src/schema.ts";
import { carPartDesign, designOptions, improvementSlots, previewDesign } from "../src/ops/design.ts";
import { teamSponsors } from "../src/ops/sponsors.ts";
import { renewalTerms, teamRenewals } from "../src/ops/contracts.ts";
import { brokenCircuits, CIRCUIT_FIELDS, circuitTable } from "../src/ops/circuits.ts";
import { teamLiveries } from "../src/ops/team.ts";
import { brokenChampionships, championshipTable, DEFAULT_AI_DRIVER_LEVEL } from "../src/ops/old-format.ts";

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
    // Eastwood is Octane's rival team, which the cache update used to reach and corrupt.
    const eastwoodDriver = staff(before.teams.find((t) => t.name === "Eastwood Motorsport")!, "Driver")[0];
    const octaneSecond = staff(octane, "Driver")[1];

    applyChanges(save, {
      changes: [
        { op: "setBuilding", team: "Garuda Racing", building: "Wind Tunnel", level: 2 },
        { op: "setBudget", team: "Garuda Racing", amount: 12_345_678 },
        { op: "addPart", team: "Garuda Racing", type: "FrontWing", name: "F-TEST", stat: 42, reliability: 0.9, fitToCar: 1 },
        { op: "hire", team: "Garuda Racing", person: freeEngineer.guid, replacing: staff(garuda, "EngineerLead")[0].guid },
        { op: "hire", team: "Garuda Racing", person: freeMechanic.guid, replacing: staff(garuda, "Mechanic")[0].guid },
        { op: "hire", team: "Garuda Racing", person: freeDriver.guid, replacing: gDriver1.guid },
        { op: "hire", team: "Garuda Racing", person: octaneDriver.guid, replacing: gDriver0.guid },
        { op: "hire", team: "Octane Racing", person: eastwoodDriver.guid, replacing: octaneSecond.guid },
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
    expect(staff(o2, "Driver").map((p) => p.guid)).toEqual(expect.arrayContaining([gDriver0.guid, eastwoodDriver.guid]));
    expect(staff(after.teams.find((t) => t.name === "Eastwood Motorsport")!, "Driver").map((p) => p.guid)).toContain(octaneSecond.guid);
    expect(after.freeAgents.map((p) => p.guid)).toContain(gDriver1.guid);
    expect(after.championship.standings.drivers.map((d) => d.guid)).toContain(freeDriver.guid);

    // Nobody sits in two seats, and every seat holder's contract names that team. (A swap once
    // rewrote the other team's seat through partImprovement.mTeam.rivalTeam.)
    const seats = new Map<string, string>();
    for (const t of reloaded.teams()) {
      for (const slot of reloaded.slots(t).filter((s) => s.personHired)) {
        const p = reloaded.g.deref<any>(slot.personHired);
        expect(seats.get(p.id), `${p.mFirstName} ${p.mLastName} in two seats`).toBeUndefined();
        seats.set(p.id, t.name);
        expect(reloaded.employer(p), `${p.mFirstName} ${p.mLastName} contract team`).toBe(t);
      }
    }

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

  it("starts HQ construction the way the game does, with MM's week-based times", () => {
    const save = Save.load(SAVE);
    const before = extractLeague(save, league);
    const hq = (st: typeof before, name: string) => st.teams.find((t) => t.name === "Garuda Racing")!.hq.find((b) => b.name === name)!;
    const notBuilt = before.teams.find((t) => t.name === "Garuda Racing")!.hq.find((b) => b.state === "NotBuilt" && b.name !== "Road Car Factory")!;
    const built = before.teams.find((t) => t.name === "Garuda Racing")!.hq.find((b) => b.state === "Constructed" && b.level < b.maxLevel)!;
    const log = applyChanges(save, { changes: [
      { op: "startBuilding", team: "Garuda Racing", building: notBuilt.name },
      { op: "startBuilding", team: "Garuda Racing", building: built.name },
    ] });
    expect(log[0]).toMatch(/building .* to level 1/);
    save.prepareForWrite();
    expect(typeMismatches(save.types, save.data)).toEqual([]);
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);

    const after = extractLeague(reloaded, league);
    const days = (b: { progressEnd: string }) => (Date.parse(b.progressEnd.slice(0, 19) + "Z") - Date.parse(before.gameDate.slice(0, 19) + "Z")) / 86_400_000;
    const t = reloaded.team("Garuda Racing");
    const info = (name: string) => reloaded.buildingInfo(reloaded.buildings(t).find((b) => reloaded.buildingInfo(b).name === name)!);
    expect(hq(after, notBuilt.name)).toMatchObject({ state: "BuildingInProgress", progress: 0 });
    expect(days(hq(after, notBuilt.name))).toBe(info(notBuilt.name).buildTime * 7);
    expect(hq(after, built.name)).toMatchObject({ state: "Upgrading", level: built.level });
    expect(days(hq(after, built.name))).toBe(info(built.name).upgradeTime[built.level - 1] * 7);

    // Each has MM's completion event, aimed at the building, in date order.
    const events = reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents);
    for (const name of [notBuilt.name, built.name]) {
      const b = reloaded.buildings(t).find((x) => reloaded.buildingInfo(x).name === name)!;
      const ev = events.find((e) => e.OnEventTrigger?.methodNames?.[0] === "UpdateProgress" && reloaded.g.deref(e.OnEventTrigger.targets[0]) === b);
      expect(ev, `${name} event`).toBeTruthy();
      expect(ev.triggerDate).toBe(b.mDateProgressEnd);
      expect(reloaded.g.deref(ev.OnButtonClick.targets[0].focusEntity)).toBe(b);
      expect(reloaded.g.deref(ev.displayEffect.team)).toBe(t);
    }
    const dates = events.map((e) => e.triggerDate as string);
    expect(dates).toEqual([...dates].sort());

    // Can't start what's already under construction.
    expect(() => applyChanges(reloaded, { changes: [{ op: "startBuilding", team: "Garuda Racing", building: built.name }] }))
      .toThrow(/already under construction/);
  }, 120_000);

  it("cancels and refunds HQ projects the league didn't order", () => {
    const save = Save.load(SAVE);
    const before = extractLeague(save, league);
    const tatra = before.teams.find((t) => t.name === "Tatra Racing")!;
    const upgrading = tatra.hq.find((b) => b.state === "Upgrading")!;
    const building = tatra.hq.find((b) => b.state === "BuildingInProgress")!;
    const events = (s: Save) => s.g.list<any>(s.data.calendar.mDelayedEvents).filter((e) => e.OnEventTrigger?.methodNames?.[0] === "UpdateProgress");
    const eventFor = (s: Save, name: string) => events(s).filter((e) => s.buildingInfo(s.g.deref(e.OnEventTrigger.targets[0])).name === name
      && s.g.same(s.g.deref<any>(e.OnEventTrigger.targets[0]).team, s.team("Tatra Racing")));
    expect(eventFor(save, upgrading.name)).toHaveLength(1);

    // Everything on Tatra started before the league (its first game date): nothing to cancel.
    expect(applyChanges(save, { changes: [{ op: "cancelUnorderedHq", teams: ["Tatra Racing"], keep: [], since: before.gameDate }] }))
      .toEqual(["No HQ projects to cancel on member teams"]);

    // With an earlier league start, the unordered construction is cancelled; the ordered one kept.
    const log = applyChanges(save, { changes: [{
      op: "cancelUnorderedHq", teams: ["Tatra Racing"], since: "2016-01-01T00:00:00.0000000",
      keep: [{ team: "Tatra Racing", building: building.type, toLevel: 1 }],
    }] });
    expect(log.join("\n")).toMatch(new RegExp(`cancelled upgrading ${upgrading.name}.*budget`));
    save.prepareForWrite();
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    const after = extractLeague(reloaded, league).teams.find((t) => t.name === "Tatra Racing")!;
    const up = after.hq.find((b) => b.name === upgrading.name)!;
    expect(up).toMatchObject({ state: "Constructed", level: upgrading.level, progress: 0 });
    expect(up.progressStart.startsWith("0001")).toBe(true);
    expect(eventFor(reloaded, upgrading.name)).toHaveLength(0);
    expect(after.hq.find((b) => b.name === building.name)!.state).toBe("BuildingInProgress");
    expect(after.budget).toBe(tatra.budget! + upgrading.upgradeCosts[upgrading.level - 1]!);
  }, 120_000);
  it("starts a part design the way MM's design screen does, and the game's own designs match our cost and time", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    // Every design MM's AI has running: our rules give the same time as the game set.
    for (const t of save.teams().filter((t) => save.championship(t).championshipID === 2)) {
      const cpd = carPartDesign(save, t);
      if (cpd.mStage !== 1) continue;
      const part = g.deref<any>(cpd.mCarPart);
      const type = part.$type.replace("Part", "");
      const ids = g.list<any>(part.components).filter(Boolean).map((c: any) => c.id);
      const opts = designOptions(save, t, type);
      expect(opts.available.map((a) => a.component.id), t.name).toEqual(expect.arrayContaining(ids));
      const days = (Date.parse(cpd.endDate.slice(0, 19) + "Z") - Date.parse(cpd.startDate.slice(0, 19) + "Z")) / 86_400_000;
      const plan = applyPreview(save, t.name, type, ids);
      expect(plan.days, `${t.name} ${type}`).toBeCloseTo(days, 3);
    }

    // Tatra (the player's team) designs a front wing from its own list.
    const tatra = save.team("Tatra Racing");
    if (carPartDesign(save, tatra).mStage === 1) applyChanges(save, { changes: [{ op: "cancelDesign", team: "Tatra Racing", refund: false }] });
    const opts = designOptions(save, tatra, "FrontWing");
    const pick = [1, 2].map((lvl) => opts.available.find((a) => !a.component.engineer && a.component.level === lvl)!.component.id);
    const budget = Number(save.finance(tatra).currentBudget);
    const entities = g.list(save.data.entityManager.mEntities).length;
    const log = applyChanges(save, { changes: [{ op: "startDesign", team: "Tatra Racing", type: "FrontWing", components: pick }] });
    expect(log[0]).toMatch(/designing FrontWing/);
    expect(Number(save.finance(tatra).currentBudget)).toBe(budget); // charged separately (adjustBudget)
    expect(g.list(save.data.entityManager.mEntities)).toHaveLength(entities + 1);
    expect(() => applyChanges(save, { changes: [{ op: "startDesign", team: "Tatra Racing", type: "Brakes", components: pick }] }))
      .toThrow(/one part at a time/);

    save.prepareForWrite();
    expect(typeMismatches(save.types, save.data)).toEqual([]);
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const cpd = carPartDesign(reloaded, reloaded.team("Tatra Racing"));
    const part = reloaded.g.deref<any>(cpd.mCarPart);
    expect(cpd.mStage).toBe(1);
    expect(part.$type).toBe("FrontWingPart");
    expect(reloaded.g.list<any>(part.components).filter(Boolean).map((c) => c.id).sort()).toEqual([...pick].sort());
    expect(reloaded.g.list(cpd.componentSlots).length).toBe(opts.ctx.slots);
    // MM's completion event: PartComplete on this design at its end date, shown to the player.
    const ev = reloaded.g.deref<any>(cpd.mCalendarEvent);
    expect(ev.OnEventTrigger.methodNames).toEqual(["PartComplete"]);
    expect(reloaded.g.deref(ev.OnEventTrigger.targets[0])).toBe(cpd);
    expect(ev.triggerDate).toBe(cpd.endDate);
    expect(ev.showOnCalendar).toBe(true);
    expect(ev.mDynamicDescription.translatedText.English).toBe("Designing Front Wing Finished");
    const events = reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents);
    expect(events).toContain(ev);
    const dates = events.map((e) => e.triggerDate as string);
    expect(dates).toEqual([...dates].sort());
  }, 120_000);

  it("starts a design when no design is running anywhere (MM's event built from another event)", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    // As after an equalization: no PartComplete event left to copy.
    const queue = g.rawList(save.data.calendar.mDelayedEvents);
    for (let i = queue.length - 1; i >= 0; i--) if (g.deref<any>(queue[i])?.OnEventTrigger?.methodNames?.[0] === "PartComplete") queue.splice(i, 1);
    const team = save.teams().find((t) => carPartDesign(save, t).mStage !== 1 && designOptions(save, t, "Brakes").available.length)!;
    const opts = designOptions(save, team, "Brakes");
    const pick = [opts.available.find((a) => !a.component.engineer && a.component.level === 1)!.component.id];
    applyChanges(save, { changes: [{ op: "startDesign", team: team.name as string, type: "Brakes", components: pick }] });
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const cpd = carPartDesign(reloaded, reloaded.team(team.name as string));
    const ev = reloaded.g.deref<any>(cpd.mCalendarEvent);
    expect(ev.OnEventTrigger.methodNames).toEqual(["PartComplete"]);
    expect(reloaded.g.same(ev.OnEventTrigger.targets[0], cpd)).toBe(true);
    expect(ev.category).toBe(8);
    expect(ev.OnButtonClick).toBeNull();
    expect(ev.mDynamicDescription.translatedText.English).toBe("Designing Brakes Finished");
    expect(reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents).some((e) => e === ev)).toBe(true);
  }, 120_000);

  it("cancels and refunds designs the league didn't order, and sets improvement", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    const designing = save.teams().filter((t) => save.championship(t).championshipID === 2 && carPartDesign(save, t).mStage === 1 && !save.g.same(save.data.player.mPlayerTeam, t));
    expect(designing.length).toBeGreaterThan(1);
    const [a, b] = designing;
    const partOf = (t: any) => g.deref<any>(carPartDesign(save, t).mCarPart);
    const keepIds = g.list<any>(partOf(b).components).filter(Boolean).map((c: any) => c.id);
    const keepType = partOf(b).$type.replace("Part", "");
    const budgetA = Number(save.finance(a).currentBudget);
    const log = applyChanges(save, { changes: [{
      op: "cancelUnorderedDesigns", teams: [a.name, b.name], since: "2016-01-01T00:00:00.0000000",
      keep: [{ team: b.name, type: keepType, components: keepIds }],
    }] });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(new RegExp(`${a.name}: cancelled designing .*budget`));
    expect(Number(save.finance(a).currentBudget)).toBeGreaterThan(budgetA);
    expect(carPartDesign(save, a).mStage).toBe(0);
    expect(carPartDesign(save, b).mStage).toBe(1);

    // Improvement: performance on the newest parts, reliability on one, 30 % of the mechanics on performance.
    // Parts that still have room to improve, as MM's AddPartToImprove requires.
    const all = (["FrontWing", "RearWing", "Brakes", "Suspension"] as const).flatMap((t) => save.parts(a, t)).filter((p) => !p.isBanned);
    const n = (v: any) => Number(typeof v === "object" ? v.rawJSON ?? v : v);
    const perf = all.filter((p) => n(p.mStats.mPerformance) < n(p.mStats.maxPerformance));
    const rel = all.find((p) => n(p.mStats.mReliability) < n(p.mStats.maxReliability));
    const maxed = all.find((p) => n(p.mStats.mReliability) >= n(p.mStats.maxReliability))!;
    const max = improvementSlots(save, a);
    const impLog = applyChanges(save, { changes: [{ op: "setImprovement", team: a.name, performance: perf.slice(0, Math.min(2, max)).map((p) => p.id), reliability: [rel ?? maxed].map((p) => p.id), split: 0.3 }] });
    // A part already at its max reliability is skipped, as MM's AddPartToImprove does.
    if (!rel) expect(impLog[0]).toMatch(/skipped: .* already at its max/);
    expect(() => applyChanges(save, { changes: [{ op: "setImprovement", team: a.name, performance: Array(max + 1).fill(perf[0].id), reliability: [] }] }))
      .toThrow(/at most/);

    save.prepareForWrite();
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const ra = reloaded.team(a.name);
    const rcpd = carPartDesign(reloaded, ra);
    expect(rcpd.mCarPart).toBeNull();
    expect(reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents).some((e) => e.OnEventTrigger?.methodNames?.[0] === "PartComplete" && reloaded.g.deref(e.OnEventTrigger.targets[0]) === rcpd)).toBe(false);
    const pi = reloaded.g.deref<any>(reloaded.g.deref<any>(ra.carManager).partImprovement);
    const list = (k: number) => reloaded.g.list<any>(pi.partsToImprove.find((e: any) => e.Key === k).Value).map((p) => p.id);
    expect(list(3)).toEqual(perf.slice(0, Math.min(2, max)).map((p) => p.id));
    expect(list(1)).toEqual(rel ? [rel.id] : []);
    const mech = Object.fromEntries(pi.mechanics.map((m: any) => [m.Key, m.Value]));
    expect(mech[3] + mech[1]).toBeGreaterThan(0);
    // MM puts everyone on the only list with parts; otherwise the member's slider decides.
    expect(mech[3]).toBe(Math.round((rel ? 0.3 : 1) * (mech[3] + mech[1])));
  }, 120_000);
  it("removes and refunds parts the AI designed and finished on member teams", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    const garuda = save.team("Garuda Racing");
    // After the season-start parts (February, no components): only parts the AI designed.
    const since = "2016-03-01T00:00:00.0000000";
    const types = ["Brakes", "FrontWing", "RearWing", "Suspension"] as const;
    const recent = types.flatMap((t) => save.parts(garuda, t).filter((p) => String(p.buildDate) > since).map((p) => ({ t, p })));
    expect(recent.length).toBeGreaterThan(1);
    // Pretend the league ordered the first one.
    const kept = recent[0];
    const keepIds = g.list<any>(kept.p.components).filter(Boolean).map((c: any) => c.id);
    const budget = Number(save.finance(garuda).currentBudget);
    const log = applyChanges(save, { changes: [{ op: "removeUnorderedParts", teams: ["Garuda Racing"], since, keep: [{ team: "Garuda Racing", type: kept.t, components: keepIds }] }] });
    expect(log.join("\n")).toMatch(/removed .*\(built by the AI/);
    expect(Number(save.finance(garuda).currentBudget)).toBeGreaterThan(budget);
    expect(save.parts(garuda, kept.t)).toContain(kept.p);

    save.prepareForWrite();
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    const rg = reloaded.team("Garuda Racing");
    // Every car still has a part of each type fitted.
    for (const car of reloaded.cars(rg)) {
      const current = reloaded.g.list<any>(car.mCurrentPart);
      for (const t of types) expect(current[["Brakes", "Engine", "FrontWing", "Gearbox", "RearWing", "Suspension"].indexOf(t)], t).toBeTruthy();
    }
    const left = types.flatMap((t) => reloaded.parts(rg, t).filter((p) => String(p.buildDate) > since));
    for (const p of left) {
      const ids = reloaded.g.list<any>(p.components).filter(Boolean).map((c: any) => c.id).sort().join();
      expect(ids === [...keepIds].sort().join() || p.isFitted, p.name).toBe(true);
    }
  }, 120_000);

  it("renames a driver everywhere the name is stored, with nationality, birth date and gender", () => {
    const save = Save.load(SAVE);
    const team = save.team("Garuda Racing");
    const slot = save.slots(team).find((s) => s.slotID === 0)!;
    const driver = save.g.deref<any>(slot.personHired);
    const oldName = driver.name;
    const peakYears = Number(driver.peakAge.slice(0, 4)) - Number(driver.dateOfBirth.slice(0, 4));
    const gender = driver.gender === 0 ? "female" : "male";
    applyChanges(save, { changes: [{ op: "renamePerson", team: "Garuda Racing", slotID: 0, firstName: "Kimi", lastName: "Räikkönen",
      nationality: "Finland", dateOfBirth: "1979-10-17", gender }] });

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const p = reloaded.g.deref<any>(reloaded.slots(reloaded.team("Garuda Racing")).find((s) => s.slotID === 0)!.personHired);
    expect([p.name, p.mShortName, p.mThreeLetterName]).toEqual(["Kimi Räikkönen", "K. Räikkönen", "Rai"]);
    expect(reloaded.g.deref<any>(p.nationality).mCountryKey).toBe("Finland");
    expect(p.dateOfBirth).toBe("1979-10-17T00:00:00.0000000");
    expect(Number(p.peakAge.slice(0, 4)) - 1979).toBe(peakYears);
    expect(p.gender).toBe(gender === "male" ? 0 : 1);
    for (const m of reloaded.g.list<any>(reloaded.data.mechanicManager.mEntities)) {
      expect(Object.keys(m.mDictDriversRelationships ?? {})).not.toContain(oldName);
      expect(Object.keys(m.mDictRelationshipModificationHistory ?? {})).not.toContain(oldName);
    }
    const ev = p.contract.mCalendarEvent && reloaded.g.deref<any>(p.contract.mCalendarEvent);
    if (ev) expect(ev.mDynamicDescription.translatedText.English).toContain("Kimi Räikkönen");
  }, 120_000);

  it("keeps a namesake's mechanic relationships when renaming a driver who shares a name", () => {
    const save = Save.load(SAVE);
    const g = save.g;
    const team = save.team("Garuda Racing");
    const mech = save.slots(team).filter((s) => s.slotID === 7 || s.slotID === 8).map((s) => g.deref<any>(s.personHired))
      .find((m) => Object.keys(m.mDictDriversRelationships ?? {}).length)!;
    const teamDriverName = Object.keys(mech.mDictDriversRelationships)[0];
    const agent = save.people().find((p) => save.isFreeAgent(p) && g.list(save.data.driverManager.mEntities).includes(p))!;
    // Make the free agent a namesake of the mechanic's driver, as MM itself sometimes does.
    agent.name = teamDriverName;
    applyChanges(save, { changes: [{ op: "renamePerson", person: agent.id, firstName: "Nicolas", lastName: "Prost" }] });
    expect(Object.keys(mech.mDictDriversRelationships)).toContain(teamDriverName);
    expect(Object.keys(mech.mDictDriversRelationships)).not.toContain("Nicolas Prost");
    expect(Object.keys(mech.mDictRelationshipModificationHistory)).toContain(teamDriverName);
  }, 120_000);

  it("renames free agents by name or GUID and adds a nationality only the game knows", () => {
    const save = Save.load(SAVE);
    const [a, b] = save.people().filter((p) => save.isFreeAgent(p) && save.g.list(save.data.driverManager.mEntities).includes(p));
    expect(save.g.byId.size && [...save.g.byId.values()].some((o) => o.mCountryKey === "Monaco")).toBe(false);
    applyChanges(save, { changes: [
      { op: "renamePerson", person: a.name, firstName: "Charles", lastName: "Leclerc", nationality: "Monaco", dateOfBirth: "1997-10-16" },
      { op: "renamePerson", person: b.id, firstName: "Stefano", lastName: "Coletti", nationality: "Monaco" },
    ] });
    expect(() => applyChanges(save, { changes: [{ op: "renamePerson", person: "Nobody Atall", firstName: "X", lastName: "Y" }] })).toThrow();

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const [ra, rb] = [reloaded.person(a.id), reloaded.person(b.id)];
    expect([ra.name, rb.name]).toEqual(["Charles Leclerc", "Stefano Coletti"]);
    expect(reloaded.g.deref<any>(ra.nationality)).toMatchObject({ mCountryKey: "Monaco", mCountryID: "PSG_10000999", mNationalityID: "PSG_10001195" });
    // One shared country object, as MM itself stores them.
    expect(reloaded.g.idOf(ra.nationality)).toBe(reloaded.g.idOf(rb.nationality));
  }, 120_000);

  it("renames a team, keeping every reference to it", () => {
    const save = Save.load(SAVE);
    const id = save.team("Garuda Racing").teamID;
    applyChanges(save, { changes: [{ op: "renameTeam", team: "Garuda Racing", name: "Scuderia Ferrari", shortName: "Ferrari" }] });
    expect(() => applyChanges(save, { changes: [{ op: "renameTeam", team: "Octane Racing", name: "Scuderia Ferrari" }] })).toThrow();

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    const t = reloaded.team(id);
    expect([t.name, t.mShortName]).toEqual(["Scuderia Ferrari", "Ferrari"]);
    expect(reloaded.slots(t).some((s) => s.personHired)).toBe(true);
  }, 120_000);

  it("sets a team's colour row and livery", () => {
    const save = Save.load(SAVE);
    const team = save.team("Garuda Racing");
    const liveries = teamLiveries(save, team).map((l) => l.id as number);
    const other = liveries.find((id) => id !== team.liveryID)!;
    const elsewhere = save.g.list<any>(save.data.liveryManager._currentLiveriesArr).find((l) => !liveries.includes(l.id))!;
    expect(() => applyChanges(save, { changes: [{ op: "setTeamLook", team: "Garuda Racing", liveryID: elsewhere.id }] })).toThrow(/not available/);
    applyChanges(save, { changes: [{ op: "setTeamLook", team: "Garuda Racing", colorID: 129, liveryID: other }] });
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    const t = reloaded.team("Garuda Racing");
    expect([t.colorID, t.liveryID]).toEqual([129, other]);
  }, 120_000);

  it("sets a team's licence and HQ countries", () => {
    const save = Save.load(SAVE);
    applyChanges(save, { changes: [{ op: "setTeamCountry", team: "Garuda Racing", nationality: "Austria", hqCountry: "UK" }] });
    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    const t = reloaded.team("Garuda Racing");
    expect(reloaded.g.deref<any>(t.nationality).mCountryKey).toBe("Austria");
    const uk = [...reloaded.g.byId.values()].find((o: any) => o.mCountryKey === "UK" && o.mNationalityID) as any;
    expect(t.locationID).toBe(uk.mCountryID);
  }, 120_000);

  it("puts back circuit start times and overtake corners that an older save format lacks", () => {
    const save = Save.load(SAVE);
    const circuits = (s: Save) => (s.data.circuitManager.mCircuits as unknown[]).map((r) => s.g.deref<any>(r));
    const before = circuits(save).map((c) => JSON.stringify(c));
    // As MM writes such a career after loading it: "" start times, 0/0 corners; or the fields missing.
    const [a, b] = circuits(save);
    for (const k of CIRCUIT_FIELDS) { a[k] = k.endsWith("Corners") ? 0 : ""; delete b[k]; }
    expect(brokenCircuits(save)).toHaveLength(2);
    expect(applyChanges(save, { changes: [{ op: "repairCircuits" }] })).toEqual(["Restored session start times and overtake corners on 2 circuits"]);

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(brokenCircuits(reloaded)).toEqual([]);
    const table = circuitTable();
    for (const c of circuits(reloaded)) expect(c).toMatchObject(table[c.circuitID]);
    expect(circuits(reloaded).slice(2).map((c) => JSON.stringify(c))).toEqual(before.slice(2));
  }, 120_000);

  it("puts back the championship database values and AI driver level that an older save format lacks", () => {
    const save = Save.load(SAVE);
    const champs = (s: Save) => s.g.list<any>(s.data.championshipManager.mEntities);
    const before = champs(save).map((c) => JSON.stringify(c));
    const [a, b] = champs(save);
    for (const c of [a, b]) Object.assign(c, { allowPromotions: false, minRacesPerSeason: 6, maxRacesPerSeason: 20, bannedLocations: [] });
    save.data.mSerializedPreferences.mAIDriverLevel = 0;
    expect(brokenChampionships(save)).toHaveLength(2);
    expect(applyChanges(save, { changes: [{ op: "repairOldFormat" }] })).toEqual([
      "All circuits already have start times",
      "Restored banned locations, race counts and promotions on 2 championships",
      `Set the AI driver level preference to ${DEFAULT_AI_DRIVER_LEVEL} (MM's default)`,
    ]);

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(brokenChampionships(reloaded)).toEqual([]);
    const table = championshipTable();
    for (const c of champs(reloaded).slice(0, 2)) expect({ ...c, bannedLocations: reloaded.g.list(c.bannedLocations) }).toMatchObject(table[c.championshipID]);
    expect(champs(reloaded).slice(2).map((c) => JSON.stringify(c))).toEqual(before.slice(2));
    expect(reloaded.data.mSerializedPreferences.mAIDriverLevel).toBe(DEFAULT_AI_DRIVER_LEVEL);
  }, 120_000);

  it("renames an engine supplier and swaps it onto this season's cars", () => {
    const save = Save.load(SAVE);
    const team = save.team("Garuda Racing");
    const cs = () => save.cars(team).map((c) => save.g.deref<any>(c.chassisStats));
    const old = save.g.deref<any>(cs()[0].supplierEngine);
    const other = save.g.list<any>(save.data.supplierManager.engineSuppliers).find((s) => s.id !== old.id && s.name !== old.name && s.mTier === old.mTier)!;
    const statsOf = (s: any) => new Map((Array.isArray(s.supplierStats) ? s.supplierStats : []).map((e: any) => [e.Key, num(e.Value)]));
    const diff = (k: number) => ((statsOf(other).get(k) as number) ?? 0) - ((statsOf(old).get(k) as number) ?? 0);
    const before = num(cs()[0].mImprovability);
    const otherName = other.name;
    applyChanges(save, { changes: [
      { op: "renameSupplier", type: "Engine", from: otherName, name: "Mercedes", worksTeam: "Garuda Racing" },
      { op: "setCurrentSupplier", team: "Garuda Racing", type: "Engine", id: other.id },
    ] });

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const engines = reloaded.g.list<any>(reloaded.data.supplierManager.engineSuppliers);
    expect(engines.some((s) => s.name === otherName)).toBe(false);
    const t = reloaded.team("Garuda Racing");
    for (const c of reloaded.cars(t)) {
      const chassis = reloaded.g.deref<any>(c.chassisStats);
      const e = reloaded.g.deref<any>(chassis.supplierEngine);
      expect(e.name).toBe("Mercedes");
      expect(e.teamDiscounts.some((d: any) => d.Key === t.teamID && num(d.Value) === 50)).toBe(true);
    }
    expect(num(reloaded.g.deref<any>(reloaded.cars(t)[0].chassisStats).mImprovability)).toBe(before + diff(3));
  }, 120_000);

  it("signs a sponsor offer and drops a deal the way MM's SponsorController does", () => {
    const save = Save.load(SAVE);
    // A team with an offer for a free slot, and a team with a running deal.
    const withOffer = save.teams().find((t) => teamSponsors(save, t)?.sponsorship.offers.length);
    const withDeal = save.teams().find((t) => t !== withOffer && teamSponsors(save, t)?.sponsorship.deals.length);
    expect(withOffer && withDeal).toBeTruthy();
    const offer = teamSponsors(save, withOffer!)!.sponsorship.offers[0];
    const deal = teamSponsors(save, withDeal!)!.sponsorship.deals[0];
    const offerTeam = withOffer!.name as string;
    const dealTeam = withDeal!.name as string;
    applyChanges(save, { changes: [
      { op: "signSponsor", team: offerTeam, slot: offer.slot, sponsorId: offer.sponsorId },
      { op: "dropSponsor", team: dealTeam, slot: deal.slot, sponsorId: deal.sponsorId },
    ] });
    expect(() => applyChanges(save, { changes: [{ op: "signSponsor", team: offerTeam, slot: offer.slot, sponsorId: offer.sponsorId }] }))
      .toThrow(/already has a sponsor/);

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const signed = teamSponsors(reloaded, reloaded.team(offerTeam))!;
    const d = signed.sponsorship.deals.find((x) => x.slot === offer.slot)!;
    expect(d.sponsorId).toBe(offer.sponsorId);
    expect(d.left).toBe(offer.length);
    expect(d.earned).toBe(offer.upfront);
    expect(d.end > reloaded.now).toBe(true);
    // Every offer for that slot is gone, and the signed sponsor now ignores the team for its cooldown.
    expect(signed.sponsorship.offers.filter((o) => o.slot === offer.slot)).toEqual([]);
    const sponsor = reloaded.g.list<any>(reloaded.data.sponsorManager.mEntities).find((s) => s.id === offer.sponsorId);
    expect(sponsor.mTeamsIgnored.some((e: any) => reloaded.g.same(e.Key, reloaded.team(offerTeam)))).toBe(true);
    // The new deal has MM's "deal ends" event in the calendar queue.
    const queued = reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents);
    expect(queued.some((e) => e.mDynamicDescription?.translatedText?.English === `Sponsorship Deal Ends With ${offer.sponsor}`)).toBe(true);
    expect(teamSponsors(reloaded, reloaded.team(dealTeam))!.sponsorship.deals.some((x) => x.slot === deal.slot)).toBe(false);
  }, 120_000);

  it("renews an expiring contract in place, with MM's terms, a moved end event and the driver's morale bonus", () => {
    const save = Save.load(SAVE);
    const all = save.teams().flatMap((t) => teamRenewals(save, t).map((r) => ({ team: t.name as string, r })));
    expect(all.length).toBeGreaterThan(0);
    for (const { r } of all) {
      expect(r.monthsLeft).toBeLessThan(12);
      expect(r.askingWage).toBeGreaterThan(0);
      expect([1, 2, 3]).toContain(r.preferredYears);
    }
    // MM's AI never offers less than the current wage (within its rounding to $1K).
    expect(all.every(({ r }) => r.askingWage >= r.wage - 1000)).toBe(true);
    const { team, r } = all.find(({ r }) => r.kind === "Driver") ?? all[0];
    const p = save.person(r.guid);
    const morale = Number(p.mMorale);
    const end = `${Number(r.end.slice(0, 4)) + 2}-12-31T00:00:00.0000000`;
    expect(() => applyChanges(save, { changes: [{ op: "renewContract", team, person: r.guid, yearlyWages: r.askingWage, endDate: end, expectedEnd: "2000-12-31T00:00:00.0000000" }] }))
      .toThrow(/changed since the order/);
    applyChanges(save, { changes: [{ op: "renewContract", team, person: r.guid, yearlyWages: r.askingWage, endDate: end, expectedEnd: r.end, signOnFee: r.signOnFee }] });

    const reloaded = reload(save);
    expect(reloaded.g.validate()).toEqual([]);
    expect(typeProblems(reloaded)).toEqual([]);
    const q = reloaded.person(r.guid);
    const c = reloaded.contract(q);
    expect(c.mEndDate).toBe(end);
    expect(Number(c.yearlyWages)).toBe(r.askingWage);
    expect(c.startDate).toBe(reloaded.now);
    const ev = reloaded.g.deref<any>(c.mCalendarEvent);
    expect(ev.triggerDate).toBe(end);
    // The event is still queued once, in date order.
    const queued = reloaded.g.list<any>(reloaded.data.calendar.mDelayedEvents);
    expect(queued.filter((e) => e === ev)).toHaveLength(1);
    const dates = queued.map((e) => e.triggerDate as string);
    expect(dates).toEqual([...dates].sort());
    if (r.kind === "Driver") expect(Number(q.mMorale)).toBeGreaterThanOrEqual(morale);
    // No longer expiring: off the list.
    expect(teamRenewals(reloaded, reloaded.team(team)).some((x) => x.guid === r.guid)).toBe(false);
    expect(renewalTerms(reloaded, reloaded.team(team), q).end).toBe(end);
  }, 120_000);
});

function applyPreview(save: Save, team: string, type: any, ids: number[]) {
  return previewDesign(save, save.team(team), type, ids);
}
