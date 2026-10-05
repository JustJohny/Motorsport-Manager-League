import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { logosByTeamId, teamLookChanges, type TeamIdentityRow, type TeamLookRow } from "../src/team-look-orders.ts";
import { leagueDb } from "./db.ts";

const SAVE = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: team identity", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  let livery = 0;
  let otherChampLivery = 0;
  const alice = () => t.member("alice"), bob = () => t.member("bob"), org = () => t.member("org");
  const look = (who: ReturnType<typeof alice>, colours: string[], liveryId: number) =>
    who.query<{ id: number }>("select public.set_team_look($1, $2, $3, $4, $5) as id", [...colours, liveryId]);
  const red = ["#C8102E", "#ffffff", "#1a1a1a", "#f2c200"];

  beforeAll(async () => {
    const save = Save.load(SAVE);
    const state = extractLeague(save, league);
    livery = state.championship.liveries![0].id;
    otherChampLivery = save.g.list<any>(save.data.liveryManager._currentLiveriesArr)
      .find((l) => !state.championship.liveries!.some((x) => x.id === l.id))!.id;
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
  }, 120_000);

  it("publishes every team's look and the championship's livery patterns", async () => {
    const pub = (await bob().query<{ p: any }>("select public as p from snapshots")).rows[0].p;
    expect(pub.championship.liveries.length).toBeGreaterThan(5);
    expect(pub.championship.liveries[0]).toMatchObject({ id: expect.any(Number), number: expect.any(Number), mask: expect.stringMatching(/\.png$/) });
    const garuda = pub.teams.find((x: any) => x.name === "Garuda Racing");
    expect(garuda.look).toMatchObject({ colorID: expect.any(Number), liveryID: expect.any(Number) });
    expect(garuda.look.colours.primary).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("saves a look, keeping one colour row ID per team for good", async () => {
    const first = await look(alice(), red, livery);
    expect(first.error).toBeNull();
    expect(first.rows[0].id).toBe(129);
    const again = await look(alice(), ["#000000", "#ffffff", "#1a1a1a", "#f2c200"], livery);
    expect(again.rows[0].id).toBe(129);
    expect((await look(bob(), red, livery)).rows[0].id).toBe(130);
    // Everyone in the series sees every team's look (it's on the cars).
    const rows = (await bob().query<{ team: string; primary_colour: string }>("select team, primary_colour from team_looks order by team")).rows;
    expect(rows).toEqual([{ team: "Garuda Racing", primary_colour: "#000000" }, { team: "Octane Racing", primary_colour: "#c8102e" }]);
  });

  it("refuses bad colours, other championships' liveries and the career team", async () => {
    expect((await look(alice(), ["red", "#ffffff", "#1a1a1a", "#f2c200"], livery)).error).toMatch(/#c8102e/);
    expect((await look(alice(), red, otherChampLivery)).error).toMatch(/isn't available/);
    expect((await look(org(), red, livery)).error).toMatch(/career team/);
  });

  it("puts uploaded logos up for the organizer's approval", async () => {
    expect((await alice().query("select public.submit_team_logo('other/x.png')")).error).toMatch(/Upload the logo/);
    expect((await alice().query("select public.submit_team_logo('test/a1.png')")).error).toBeNull();
    // A second upload withdraws the first.
    expect((await alice().query("select public.submit_team_logo('test/a2.png')")).error).toBeNull();
    const mine = (await alice().query<{ id: number; path: string; status: string }>("select id, path, status from team_logos order by id")).rows;
    expect(mine.map((x) => x.status)).toEqual(["withdrawn", "pending"]);
    // Rivals don't see pending logos.
    expect((await bob().query("select * from team_logos")).rows).toEqual([]);
    expect((await alice().query("select public.review_team_logo($1, true)", [mine[1].id])).error).toMatch(/Only the organizer/);
    expect((await org().query("select public.review_team_logo($1, true)", [mine[1].id])).error).toBeNull();
    expect((await bob().query<{ path: string }>("select path from team_logos")).rows).toEqual([{ path: "test/a2.png" }]);
  });

  it("replaces the approved logo when a new one is approved, and records rejections", async () => {
    await alice().query("select public.submit_team_logo('test/a3.png')");
    let pending = (await org().query<{ id: number }>("select id from team_logos where status = 'pending'")).rows[0];
    await org().query("select public.review_team_logo($1, false, 'Too blurry')", [pending.id]);
    await alice().query("select public.submit_team_logo('test/a4.png')");
    pending = (await org().query<{ id: number }>("select id from team_logos where status = 'pending'")).rows[0];
    await org().query("select public.review_team_logo($1, true)", [pending.id]);
    const all = (await alice().query<{ path: string; status: string; note: string | null }>("select path, status, note from team_logos order by id")).rows;
    expect(all.map((x) => `${x.path} ${x.status}`)).toEqual([
      "test/a1.png withdrawn", "test/a2.png replaced", "test/a3.png rejected", "test/a4.png approved",
    ]);
    expect(all[2].note).toBe("Too blurry");
  });

  it("gives the toolkit every series' looks and approved logos with MM team IDs", async () => {
    const rows = (await t.service<TeamIdentityRow>("select * from public.all_team_identities()")).rows;
    const garuda = rows.find((r) => r.team === "Garuda Racing")!;
    expect(garuda).toMatchObject({ series: "test", color_id: 129, logo_path: "test/a4.png", livery_id: livery });
    expect(garuda.team_id).toEqual(expect.any(Number));
    expect((await alice().query("select * from public.all_team_identities()")).error).toMatch(/permission denied/);
  });

  it("turns looks into setTeamLook changes and picks one logo per team ID", () => {
    const row = { team: "Garuda Racing", primary_colour: "#c8102e", secondary_colour: "#ffffff", tertiary_colour: "#1a1a1a", trim_colour: "#f2c200", livery_id: 9, color_id: 129, updated_at: "" } satisfies TeamLookRow;
    expect(teamLookChanges([row])).toEqual([{ op: "setTeamLook", team: "Garuda Racing", colorID: 129, liveryID: 9 }]);
    const id = (series: string, at: string): TeamIdentityRow => ({
      series, team: "X", team_id: 7, color_id: null, primary_colour: null, secondary_colour: null, tertiary_colour: null, trim_colour: null,
      livery_id: null, logo_path: `${series}/x.png`, logo_approved_at: at,
    });
    const r = logosByTeamId([id("a", "2026-10-02"), id("b", "2026-10-03")]);
    expect(r.logos.map((l) => l.row.series)).toEqual(["b"]);
    expect(r.clashes).toHaveLength(1);
  });
});
