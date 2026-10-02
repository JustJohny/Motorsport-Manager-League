import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { num, pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import { crewUpdates, crewChanges } from "../src/crew-orders.ts";
import { extractLeague } from "../src/extract.ts";
import type { Obj } from "../src/graph.ts";
import { Save } from "../src/model.ts";
import { crewNamePool } from "../src/ops/pit-crew.ts";
import { defaultSavesDir } from "../src/paths.ts";
import {
  activeRoles, assignRole, contractRaces, crewAfterRace, fillEmptyRoles, perRaceWage, RESERVE, startingCrew, taskStats, type CrewMember, type NamePool,
} from "../src/pit-crew.ts";

const names: NamePool = { UK: { first: ["Amy", "Ben", "Cal"], last: ["Hart", "Ives", "Jones"] }, Spain: { first: ["Ana", "Blas", "Ciro"], last: ["Diaz", "Ruiz", "Sanz"] } };
const ROLES = activeRoles("Small", true);

describe("pit crew rules", () => {
  it("uses MM's positions per crew size", () => {
    expect(activeRoles("Small", true)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(activeRoles("SemiSequential", false)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(activeRoles("Large", false)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(activeRoles("Large", true)).toHaveLength(10);
    expect(contractRaces(8)).toBe(17);
  });

  it("prices crew like Tatra's applicants", () => {
    // Average skill → MM's wage per race (League Test 10: Dalibor Breznanik $3K, Lukás Antunovic $7K, Jakub Dolinajec $9K).
    expect(perRaceWage([4.8, 5.6, 6.9, 0.2, 7.3])).toBe(3000);
    expect(perRaceWage([13.9, 13.5, 4.0, 11.4, 4.0])).toBe(7000);
    expect(perRaceWage([15.0, 13.1, 9.6, 2.0, 15.2])).toBe(9000);
  });

  it("starts every member team with the same crew under different names", () => {
    const a = startingCrew("s", "Team A", 10, ROLES, names, "2016-03-01", 8);
    const b = startingCrew("s", "Team B", 10, ROLES, names, "2016-03-01", 8);
    expect(a).toHaveLength(10);
    expect(a.map((c) => [c.stats, c.birth, c.role, c.wage])).toEqual(b.map((c) => [c.stats, c.birth, c.role, c.wage]));
    expect(a.map((c) => c.lastName + c.firstName)).not.toEqual(b.map((c) => c.lastName + c.firstName));
    expect(a.filter((c) => c.role !== RESERVE).map((c) => c.role)).toEqual(ROLES);
    expect(a.every((c) => c.racesLeft === 17)).toBe(true);
  });

  it("runs a race: wages, funding, training, mistakes, contracts and refills", () => {
    const crew: CrewMember[] = startingCrew("s", "T", 10, ROLES, names, "2016-03-01", 8).map((c, i) => ({ ...c, id: i + 1 }));
    crew[0].racesLeft = 1; // the front jack's contract ends
    const out = crewAfterRace({ series: "s", team: "T", round: 3, gameDate: "2016-05-01", mistakes: 2, funding: 2, roles: ROLES, crew, applicants: [], names });
    expect(out.spend).toEqual([
      { kind: "wages", description: "Pit crew wages (round 3)", amount: crew.reduce((s, c) => s + c.wage, 0) },
      { kind: "funding", description: "Pit crew funding: High (round 3)", amount: 120_000 },
    ]);
    expect(out.left).toEqual([{ name: `${crew[0].firstName} ${crew[0].lastName}`, reason: "contract ended" }]);
    // The empty front jack position went to the reserve best at it.
    const jack = out.crew.find((c) => c.role === 0)!;
    const bench = crew.filter((c) => c.role === RESERVE);
    expect(jack.id).toBe(bench.sort((x, y) => y.stats[1] - x.stats[1])[0].id);
    // Positions trained their skill (High funding +0.45); reserves didn't.
    const rearJack = crew.find((c) => c.role === 1)!;
    expect(out.crew.find((c) => c.id === rearJack.id)!.stats[2]).toBeCloseTo(rearJack.stats[2] + 0.45, 2);
    // Two mistakes cost confidence.
    const lost = out.crew.filter((c) => c.confidence < crew.find((x) => x.id === c.id)!.confidence);
    expect(lost.length).toBeGreaterThanOrEqual(1);
    expect(out.applicants).toHaveLength(8);
    expect(out.crew.every((c) => c.racesLeft === 16)).toBe(true);
  });

  it("swaps positions and turns positions into task values", () => {
    const crew = startingCrew("s", "T", 10, ROLES, names, "2016-03-01", 8).map((c, i) => ({ ...c, id: i + 1 }));
    const reserve = crew.find((c) => c.role === RESERVE)!;
    const swapped = assignRole(crew, reserve.id!, 0);
    expect(swapped.find((c) => c.id === reserve.id)!.role).toBe(0);
    expect(swapped.find((c) => c.id === crew[0].id)!.role).toBe(RESERVE);
    const tasks = taskStats(crew, ROLES);
    expect(tasks.map((t) => t.target)).toEqual([1, 3, 4]);
    const wheels = crew.filter((c) => [2, 3, 4, 5].includes(c.role));
    expect(tasks[0].stat).toBeCloseTo(wheels.reduce((s, c) => s + c.stats[0], 0) / 4, 2);
    expect(fillEmptyRoles(crew.filter((c) => c.role !== 2), ROLES).some((c) => c.role === 2)).toBe(true);
  });
});

const LT10 = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = { members: [{ member: "org", team: "Tatra Racing" }, { member: "alice", team: "Garuda Racing" }] };

describe.skipIf(!existsSync(LT10))("pit crew in a real save", () => {
  it("extracts the crew rule, MM's pit stop log and the career team's crew", () => {
    const state = extractLeague(Save.load(LT10), league);
    const ch = state.championship;
    expect(ch.pitCrew).toMatchObject({ size: "Small", roles: [0, 1, 2, 3, 4, 5] });
    expect(ch.pitCrew!.aiLevel).toBeGreaterThan(5);
    expect(ch.pitStops!.map((r) => r.round)).toEqual(ch.races!.map((r) => r.round));
    const r1 = ch.pitStops![0].teams;
    expect(r1.map((x) => x.fastest)).toEqual([...r1.map((x) => x.fastest)].sort((a, b) => a - b));
    const tatra = state.teams.find((t) => t.name === "Tatra Racing")!;
    expect(tatra.gameCrew!.members).toHaveLength(15);
    expect(tatra.gameCrew!.applicants).toHaveLength(8);
    expect(state.teams.find((t) => t.name === "Garuda Racing")!.gameCrew).toBeNull();
  }, 120_000);

  it("forms crews for member AI teams only and writes their skills into the save", () => {
    const save = Save.load(LT10);
    const state = extractLeague(save, league);
    const updates = crewUpdates(state, { teams: [], crew: [], applicants: [] }, "test", crewNamePool(save));
    expect(updates.map((u) => u.team)).toEqual(["Garuda Racing"]);
    const ctx = {
      teams: [{ team: "Garuda Racing", funding: 1, processed_round: 7 }],
      crew: updates[0].crew.map((c) => ({ ...c, team: "Garuda Racing" })),
      applicants: [],
    };
    const ops = crewChanges(ctx, state.championship.pitCrew!.roles);
    applyChanges(save, { changes: ops });
    save.prepareForWrite();
    expect(save.g.validate()).toEqual([]);
    const f = save.file;
    const raw = unpack(pack({ version: f.version, headerText: stringifyLossless(f.header), dataText: stringifyLossless(f.data) }));
    const back = new Save({ version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) });
    const garuda = back.teams().find((t) => t.name === "Garuda Racing")!;
    const ai = back.g.deref<Obj>(back.g.deref<Obj>(garuda.pitCrewController).mAIPitCrew);
    const op = ops[0] as Extract<(typeof ops)[number], { op: "setPitCrew" }>;
    for (const list of [ai.carOneTaskStats, ai.carTwoTaskStats]) {
      const tyres = list.map((x: unknown) => back.g.deref<Obj>(x)).find((x: Obj) => x.taskType === 1);
      expect(num(tyres.taskStat)).toBeCloseTo(op.tasks.find((t) => t.target === 1)!.stat, 3);
    }
    // A crew already formed is processed race by race: nothing new since round 7 here.
    expect(crewUpdates(state, ctx, "test", crewNamePool(save))).toEqual([]);
  }, 120_000);
});
