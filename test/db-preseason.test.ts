import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { extractLeague } from "../src/extract.ts";
import type { LeagueState } from "../src/league-types.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import type { PreseasonMove } from "../src/preseason.ts";
import { replay } from "../src/preseason.ts";
import { preseasonChanges, type PreseasonSupplierRow } from "../src/preseason-orders.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

// A new FIRE Fantasy 20 career (2020, before round 1).
const SAVE = process.env.MM_FF20_SAVE ?? join(defaultSavesDir(), "SaveFF20 F1 Test.sav");
const ALICE = "Williams Grand Prix", BOB = "McLaren Grand Prix";

describe.skipIf(!existsSync(SAVE))("database: the league's pre-season", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  let save: Save;
  let state: LeagueState;
  const alice = () => t.member("alice"), bob = () => t.member("bob"), org = () => t.member("org");
  const team = (name: string) => state.teams.find((x) => x.name === name)!;
  const drivers = (name: string) => team(name).staff.filter((s) => s.job === "Driver" && s.person).map((s) => s.person!);
  const freeDrivers = () => state.freeAgents.filter((p) => p.kind === "Driver");
  const moves = async () => (await t.service<PreseasonMove>("select * from preseason_moves where status = 'queued' order by id")).rows;

  beforeAll(async () => {
    save = Save.load(SAVE);
    const career = extractLeague(save, { championship: 0, members: [] }).teams.find((x) => x.isPlayerTeam)!.name;
    const league = { championship: "Formula 1", members: [
      { member: "org", team: career, discord: "org", organizer: true },
      { member: "alice", team: ALICE, discord: "alice" },
      { member: "bob", team: BOB, discord: "bob" },
    ] };
    state = extractLeague(save, league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
  }, 180_000);

  it("publishes driver status, mechanic cars and this season's supplier options", () => {
    const [d1, d2, reserve] = drivers(ALICE);
    expect([d1.status, d2.status, reserve.status]).toEqual(["Equal", "Equal", "Reserve"]);
    const mech = team(ALICE).staff.filter((s) => s.job === "Mechanic" && s.person).map((s) => s.person!.mechanicCar);
    expect(mech.sort()).toEqual([0, 1]);
    const car = team(ALICE).design!.currentCar!;
    expect(car.current.Engine.name).toBe("Mercedes A");
    expect(car.options.Engine.map((o) => o.name)).toContain("Renault A");
    expect(car.options.Engine.find((o) => o.name === "Renault A")!.level).toBe(93);
  });

  it("is closed until the organizer opens it", async () => {
    expect((await alice().query("select public.preseason_move('swapCars', null, null)")).error).toMatch(/pre-season is closed/);
    expect((await alice().query("select public.set_preseason(true)")).error).toMatch(/Only the organizer/);
    expect((await org().query("select public.set_preseason(true)")).error).toBeNull();
    expect((await t.service<{ preseason: boolean }>("select preseason from league_settings")).rows[0].preseason).toBe(true);
    expect((await org().query("select public.preseason_move('swapCars', null, null)")).error).toMatch(/career team/);
  });

  it("signs free agents: first come wins, at the opening wage, no fee", async () => {
    const [, , reserve] = drivers(ALICE);
    const [fa, fb] = freeDrivers();
    const engineer = team(ALICE).staff.find((s) => s.job === "EngineerLead")!.person!;
    expect((await alice().query("select public.preseason_sign($1, $2, 2)", [fa.guid, engineer.guid])).error).toMatch(/can't replace/);
    expect((await alice().query("select public.preseason_sign($1, $2, 9)", [fa.guid, reserve.guid])).error).toMatch(/1 to/);
    expect((await alice().query("select public.preseason_sign($1, $2, 2)", [drivers(BOB)[0].guid, reserve.guid])).error).toMatch(/Only free agents/);
    expect((await alice().query("select public.preseason_sign($1, $2, 2)", [fa.guid, reserve.guid])).error).toBeNull();
    expect((await bob().query("select public.preseason_sign($1, $2, 1)", [fa.guid, drivers(BOB)[0].guid])).error).toMatch(/already been signed by Williams/);
    const [m] = await moves();
    expect(m).toMatchObject({ team: ALICE, kind: "sign", person_guid: fa.guid, other_guid: reserve.guid, years: 2, new_end: "2021-12-31T00:00:00.0000000" });
    const [wage] = (await t.service<{ w: string }>("select public.min_wage($1::jsonb) w", [JSON.stringify(fa)])).rows;
    expect(Number(m.yearly_wage)).toBe(Number(wage.w));
    // Undo frees them for everyone.
    expect((await alice().query("select public.preseason_undo()")).error).toBeNull();
    expect((await bob().query("select public.preseason_sign($1, $2, 1)", [fa.guid, drivers(BOB)[0].guid])).error).toBeNull();
    expect((await bob().query("select public.preseason_undo()")).error).toBeNull();
    // Alice signs fb into her reserve seat and promotes them, for the apply test below.
    expect((await alice().query("select public.preseason_sign($1, $2, 1)", [fb.guid, reserve.guid])).error).toBeNull();
    expect((await alice().query("select public.preseason_move('promote', $1, $2)", [fb.guid, drivers(ALICE)[1].guid])).error).toBeNull();
    expect((await alice().query("select public.preseason_move('promote', $1, $2)", [fb.guid, team(ALICE).staff.find((s) => s.job === "Mechanic" && s.person)!.person!.guid])).error).toMatch(/two of your drivers/);
    expect((await alice().query("select public.preseason_move('swapMechanics', null, null)")).error).toBeNull();
  });

  it("picks this season's suppliers from the team's options only", async () => {
    const renault = team(ALICE).design!.currentCar!.options.Engine.find((o) => o.name === "Renault A")!;
    expect((await alice().query("select public.preseason_supplier('Engine', 99999)")).error).toMatch(/isn't available/);
    expect((await alice().query("select public.preseason_supplier('Engine', $1)", [renault.id])).error).toBeNull();
    expect((await bob().query("select * from preseason_suppliers")).rows).toEqual([]);
    expect((await alice().query("select * from preseason_suppliers")).rows).toHaveLength(1);
  });

  it("replays the moves into save changes that apply cleanly", async () => {
    const queued = await moves();
    const suppliers = (await t.service<PreseasonSupplierRow>("select * from preseason_suppliers")).rows;
    const { changes, warnings } = preseasonChanges(queued, suppliers, state as never);
    expect(warnings).toEqual([]);
    expect(changes.map((c) => c.op)).toEqual(["hire", "promoteDriver", "swapMechanics", "setCurrentSupplier"]);
    applyChanges(save, { changes });
    const after = extractLeague(save, { championship: 0, members: [] }).teams.find((x) => x.name === ALICE)!;
    const fb = freeDrivers()[1];
    const [, , oldReserve] = drivers(ALICE);
    const now = after.staff.filter((s) => s.job === "Driver" && s.person).map((s) => s.person!);
    expect(now.map((p) => p.guid)).toEqual([drivers(ALICE)[0].guid, fb.guid, drivers(ALICE)[1].guid]);
    expect(now.map((p) => p.status)).toEqual(["Equal", "Equal", "Reserve"]);
    expect(now.some((p) => p.guid === oldReserve.guid)).toBe(false);
    expect(after.design!.currentCar!.current.Engine.name).toBe("Renault A");
    // As Save.write() does before writing.
    save.prepareForWrite();
    expect(save.g.validate()).toEqual([]);
  }, 120_000);

  it("keeps someone released from a seat MM needs filled", () => {
    const staff = team(BOB).staff;
    const [d1] = drivers(BOB);
    const base = { id: 1, team: BOB, person_name: d1.name, other_guid: null, other_name: null, years: null, yearly_wage: null, new_end: null, person: null, status: "queued", created_at: "2026-10-09T10:00:00Z" };
    const l = replay(BOB, staff, [{ ...base, kind: "release", person_guid: d1.guid }]);
    expect(l.changes).toEqual([]);
    expect(l.kept.map((p) => p.guid)).toEqual([d1.guid]);
    // Released, then a free agent signed into the empty seat: one hire replacing them.
    const fa = freeDrivers()[2];
    const l2 = replay(BOB, staff, [
      { ...base, kind: "release", person_guid: d1.guid },
      { ...base, id: 2, kind: "sign", person_guid: fa.guid, person_name: fa.name, person: fa, years: 1, yearly_wage: 1, new_end: "2020-12-31T00:00:00.0000000", created_at: "2026-10-09T10:01:00Z" },
    ]);
    expect(l2.changes).toEqual([expect.objectContaining({ op: "hire", person: fa.guid, replacing: d1.guid })]);
    expect(l2.kept).toEqual([]);
    expect(l2.seats.find((s) => s.role === "car1")!.person!.guid).toBe(fa.guid);
  });
});
