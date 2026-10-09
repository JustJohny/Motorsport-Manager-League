import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_FF20_SAVE ?? join(defaultSavesDir(), "SaveFF20 F1 Test.sav");
const ALICE = "Williams Grand Prix", BOB = "McLaren Grand Prix";

describe.skipIf(!existsSync(SAVE))("database: car stickers", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const alice = () => t.member("alice"), bob = () => t.member("bob"), org = () => t.member("org");
  let teamIds: Record<string, number>;

  beforeAll(async () => {
    const save = Save.load(SAVE);
    const career = extractLeague(save, { championship: 0, members: [] }).teams.find((x) => x.isPlayerTeam)!.name;
    const league = { championship: "Formula 1", members: [
      { member: "org", team: career, discord: "org", organizer: true },
      { member: "alice", team: ALICE, discord: "alice" },
      { member: "bob", team: BOB, discord: "bob" },
    ] };
    const state = extractLeague(save, league);
    teamIds = Object.fromEntries(state.teams.map((x) => [x.name, x.teamID]));
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
  }, 180_000);

  it("submits, reviews, replaces and removes stickers per spot", async () => {
    expect((await alice().query("select public.submit_sticker(1, 'Acme', 'test/acme.jpg')")).error).toMatch(/Upload the sticker/);
    expect((await alice().query("select public.submit_sticker(7, 'Acme', 'test/acme.png')")).error).toMatch(/0 to 5/);
    expect((await alice().query("select public.submit_sticker(3, '', 'test/acme.png')")).error).toMatch(/name/);
    const [{ id }] = (await alice().query<{ id: number }>("select public.submit_sticker(3, 'Acme', 'test/acme.png') as id")).rows;
    // Pending: only the team and the organizer see it.
    expect((await bob().query("select * from team_stickers")).rows).toEqual([]);
    expect((await org().query("select * from team_stickers")).rows).toHaveLength(1);
    expect((await alice().query("select public.review_sticker($1, true)", [id])).error).toMatch(/Only the organizer/);
    expect((await org().query("select public.review_sticker($1, true)", [id])).error).toBeNull();
    // Approved: everyone sees it.
    expect((await bob().query<{ sponsor_name: string }>("select * from team_stickers")).rows.map((r) => r.sponsor_name)).toEqual(["Acme"]);
    // A new one for the same spot replaces it once approved; the old stays until then.
    const [{ id: id2 }] = (await alice().query<{ id: number }>("select public.submit_sticker(3, 'Globex', 'test/globex.png') as id")).rows;
    expect((await org().query("select public.review_sticker($1, true, 'nice')", [id2])).error).toBeNull();
    const rows = (await org().query<{ sponsor_name: string; status: string }>("select sponsor_name, status from team_stickers order by id")).rows;
    expect(rows).toEqual([{ sponsor_name: "Acme", status: "replaced" }, { sponsor_name: "Globex", status: "approved" }]);
    // The command's view: every member team, with or without stickers.
    const all = (await t.service<{ team: string; team_id: number; slot: number | null; sponsor_name: string | null }>("select * from public.all_team_stickers() order by team, slot")).rows;
    expect(all.find((r) => r.team === ALICE)).toMatchObject({ team_id: teamIds[ALICE], slot: 3, sponsor_name: "Globex" });
    expect(all.find((r) => r.team === BOB)).toMatchObject({ team_id: teamIds[BOB], slot: null });
    // Size: the team's own sticker only, 25..200 %, no new approval; the command gets it.
    expect((await alice().query("select public.set_sticker_scale($1, 0.1)", [id2])).error).toMatch(/25%/);
    expect((await alice().query("select public.set_sticker_scale($1, 2.5)", [id2])).error).toMatch(/200%/);
    expect((await alice().query("select public.set_sticker_scale($1, 1.8)", [id2])).error).toBeNull();
    expect((await bob().query("select public.set_sticker_scale($1, 0.5)", [id2])).error).toMatch(/No such sticker/);
    expect((await alice().query("select public.set_sticker_scale($1, 0.5)", [id])).error).toMatch(/No such sticker/);
    expect((await alice().query("select public.set_sticker_scale($1, 0.5)", [id2])).error).toBeNull();
    const scaled = (await t.service<{ team: string; scale: number; status?: string }>("select * from public.all_team_stickers()")).rows;
    expect(scaled.find((r) => r.team === ALICE)!.scale).toBe(0.5);
    expect((await bob().query<{ scale: number }>("select scale from team_stickers")).rows).toEqual([{ scale: 0.5 }]);
    expect((await alice().query("select public.remove_sticker(3)")).error).toBeNull();
    expect((await alice().query("select public.remove_sticker(3)")).error).toMatch(/No sticker/);
    expect((await bob().query("select * from team_stickers")).rows).toEqual([]);
  });
});
