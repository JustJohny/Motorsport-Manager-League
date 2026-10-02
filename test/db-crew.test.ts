import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { crewUpdates } from "../src/crew-orders.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { crewNamePool } from "../src/ops/pit-crew.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { CREW_SETTINGS, FUNDING, perRaceWage } from "../src/pit-crew.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: pit crews", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const alice = () => t.member("alice"), bob = () => t.member("bob"), org = () => t.member("org");
  type Row = { id: number; role: number; stats: number[]; races_left: number; wage: string; first_name: string };
  const crewOf = async (who: ReturnType<typeof alice>) => (await who.query<Row>("select * from pit_crew order by id")).rows;

  beforeAll(async () => {
    const save = Save.load(SAVE);
    const state = extractLeague(save, league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '60000000') where team = 'Garuda Racing'`);
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '30000') where team = 'Octane Racing'`);
    // What `mmsave publish` does: starting crews for member AI teams.
    for (const u of crewUpdates(state, { teams: [], crew: [], applicants: [] }, "test", crewNamePool(save))) {
      const r = await t.service("select public.save_team_crew($1, $2, $3, $4, $5, $6, $7)",
        [u.team, u.processed_round, JSON.stringify(u.crew), JSON.stringify(u.applicants), JSON.stringify(u.spend), JSON.stringify(u.log), u.funding ?? null]);
      expect(r.error).toBeNull();
    }
  }, 120_000);

  it("mirrors the site's rules", async () => {
    const s = (await t.service<{ s: Record<string, unknown> }>("select public.crew_settings() as s")).rows[0].s;
    expect(s).toEqual({
      maxCrew: CREW_SETTINGS.maxCrew, signOnFee: CREW_SETTINGS.signOnFee, renewBelow: CREW_SETTINGS.renewBelow,
      retireAge: CREW_SETTINGS.retireAge, fundingCost: FUNDING.map((f) => f.cost),
    });
    for (const stats of [[4.8, 5.6, 6.9, 0.2, 7.3], [13.9, 13.5, 4, 11.4, 4], [15, 13.1, 9.6, 2, 15.2], [20, 20, 20, 20, 20], [0, 0, 0, 0, 0], [6.5, 6.5, 6.5, 6.5, 6.5]]) {
      const w = (await t.service<{ w: string }>("select public.crew_wage($1::real[]) as w", [stats])).rows[0].w;
      expect(Number(w), JSON.stringify(stats)).toBe(perRaceWage(stats));
    }
  });

  it("gives member AI teams a private crew; the career team keeps MM's", async () => {
    const crew = await crewOf(alice());
    expect(crew).toHaveLength(10);
    expect(crew.filter((c) => c.role !== 11).map((c) => c.role).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect((await alice().query("select * from pit_crew_applicants")).rows).toHaveLength(8);
    expect((await crewOf(bob())).length).toBe(10);
    // Each team sees only its own; the organizer sees all.
    expect((await alice().query("select distinct team from pit_crew")).rows).toEqual([{ team: "Garuda Racing" }]);
    expect((await org().query("select distinct team from pit_crew order by team")).rows).toEqual([{ team: "Garuda Racing" }, { team: "Octane Racing" }]);
    expect((await org().query("select public.set_crew_funding(2)")).error).toMatch(/managed in game/);
    // Only the toolkit writes whole crews.
    expect((await alice().query("select public.save_team_crew('Garuda Racing', 0, '[]', '[]', '[]', '[]')")).error).toMatch(/permission denied/);
  });

  it("swaps positions as MM does", async () => {
    const crew = await crewOf(alice());
    const reserve = crew.find((c) => c.role === 11)!;
    const jack = crew.find((c) => c.role === 0)!;
    expect((await alice().query("select public.set_crew_role($1, 0)", [reserve.id])).error).toBeNull();
    const after = await crewOf(alice());
    expect(after.find((c) => c.id === reserve.id)!.role).toBe(0);
    expect(after.find((c) => c.id === jack.id)!.role).toBe(11);
    const wheel = after.find((c) => c.role === 2)!;
    expect((await alice().query("select public.set_crew_role($1, 1)", [wheel.id])).error).toBeNull();
    expect((await crewOf(alice())).filter((c) => c.role === 1 || c.role === 2).length).toBe(2);
    expect((await alice().query("select public.set_crew_role($1, 11)", [wheel.id])).error).toMatch(/someone else/);
    expect((await alice().query("select public.set_crew_role($1, 6)", [reserve.id])).error).toMatch(/isn't used in this series/);
    expect((await bob().query("select public.set_crew_role($1, 3)", [reserve.id])).error).toMatch(/No such crew member/);
  });

  it("signs applicants within the budget and the crew limit", async () => {
    const [app] = (await alice().query<{ id: number; wage: string }>("select id, wage from pit_crew_applicants order by id")).rows;
    expect((await alice().query("select public.sign_crew_applicant($1)", [app.id])).error).toBeNull();
    const signed = (await crewOf(alice())).at(-1)!;
    expect(signed).toMatchObject({ role: 11, races_left: 21, wage: app.wage });
    expect((await alice().query<{ amount: string; kind: string }>("select kind, amount from crew_spend")).rows).toEqual([{ kind: "signon", amount: "45000" }]);
    expect(Number((await t.db.query<{ c: string }>("select public.hq_committed('Garuda Racing') as c")).rows[0].c)).toBe(45_000);
    const [bobApp] = (await bob().query<{ id: number }>("select id from pit_crew_applicants")).rows;
    expect((await bob().query("select public.sign_crew_applicant($1)", [bobApp.id])).error).toMatch(/Not enough budget/);
    for (const a of (await alice().query<{ id: number }>("select id from pit_crew_applicants order by id")).rows.slice(0, 4)) {
      expect((await alice().query("select public.sign_crew_applicant($1)", [a.id])).error).toBeNull();
    }
    expect(await crewOf(alice())).toHaveLength(15);
    const [next] = (await alice().query<{ id: number }>("select id from pit_crew_applicants")).rows;
    expect((await alice().query("select public.sign_crew_applicant($1)", [next.id])).error).toMatch(/full/);
  });

  it("releases (the best reserve takes the position) and renews late contracts", async () => {
    const crew = await crewOf(alice());
    const jack = crew.find((c) => c.role === 0)!;
    const best = crew.filter((c) => c.role === 11).sort((a, b) => b.stats[1] - a.stats[1] || a.id - b.id)[0];
    expect((await alice().query("select public.release_crew($1)", [jack.id])).error).toBeNull();
    expect((await crewOf(alice())).find((c) => c.role === 0)!.id).toBe(best.id);

    expect((await alice().query("select public.renew_crew($1)", [best.id])).error).toMatch(/fewer than 12/);
    await t.service("update pit_crew set races_left = 5, stats = '{20,20,20,20,20}' where id = $1", [best.id]);
    expect((await alice().query("select public.renew_crew($1)", [best.id])).error).toBeNull();
    expect((await crewOf(alice())).find((c) => c.id === best.id)).toMatchObject({ races_left: 21, wage: "10000" });
    expect((await alice().query("select public.set_crew_funding(2)")).error).toBeNull();
    expect((await alice().query<{ funding: number }>("select funding from pit_crew_teams")).rows).toEqual([{ funding: 2 }]);
    expect((await alice().query<{ message: string }>("select message from pit_crew_log order by id")).rows.map((r) => r.message.split(" ")[0]))
      .toEqual(["Crew", "Signed", "Signed", "Signed", "Signed", "Signed", "Released", "Renewed"]);
  });

  it("is in the series backup", async () => {
    const backup = (await t.service<{ b: { tables: Record<string, unknown[]> } }>("select public.export_series() as b")).rows[0].b;
    expect(backup.tables.pit_crew.length).toBeGreaterThan(20);
    expect(backup.tables.pit_crew_teams).toHaveLength(2);
  });
});
