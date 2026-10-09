import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { findRaceExport, readRaceExport } from "../src/race-data.ts";
import { leagueDb } from "./db.ts";

// FIRE Fantasy 20's export of a real race (Sydney, 19 Mar 2020) and the save after it.
const GAME = process.env.MM_GAME_DATA ?? join(process.env.HOME ?? "", "Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/MM_Data");
const SAVE = join(defaultSavesDir(), "SaveFF20 F1 Test Post race.sav");
const dir = existsSync(GAME) ? findRaceExport(GAME, "Sydney", "2020-03-19") : null;
const league = {
  championship: "Formula 1",
  members: [
    { member: "org", team: "Williams Grand Prix", discord: "org", organizer: true },
    { member: "alice", team: "Haas Formula Racing", discord: "alice" },
    { member: "bob", team: "McLaren Grand Prix", discord: "bob" },
  ],
};

describe.skipIf(!dir || !existsSync(SAVE))("database: FF20 race data", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;

  beforeAll(async () => {
    const state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    const { data, privateByTeam } = readRaceExport(dir!);
    for (let i = 0; i < 2; i++) { // a second upload replaces the first
      const r = await t.service("select public.publish_race_data(public.current_series(), 1, 'Sydney', '2020-03-19', $1, $2)", [JSON.stringify(data), JSON.stringify(privateByTeam)]);
      expect(r.error).toBeNull();
    }
  }, 120_000);

  it("reads the export: classification, three sectors per lap, team of every driver", () => {
    const { data, privateByTeam } = readRaceExport(dir!);
    expect(data.results[0]).toMatchObject({ position: 1, fastestLap: expect.any(Boolean) });
    for (const d of data.laps) {
      expect(d.team).not.toBe("");
      expect(d.lap.length).toBe(d.sector.length);
      expect(d.values.sectorTime.length).toBe(d.lap.length);
    }
    expect(Object.keys(privateByTeam).length).toBeGreaterThan(5);
    expect(privateByTeam["Haas Formula Racing"].drivers[0].values.tyreWear.length).toBeGreaterThan(10);
  });

  it("shows laps to every member, tyre wear and fuel only to the own team and the organizer", async () => {
    const pub = await t.member("bob").query<{ n: number }>("select count(*)::int as n from race_data");
    expect(pub.rows[0].n).toBe(1);
    const teams = async (who: string) =>
      (await t.member(who).query<{ team: string }>("select team from race_data_private order by team")).rows.map((r) => r.team);
    expect(await teams("alice")).toEqual(["Haas Formula Racing"]);
    expect(await teams("bob")).toEqual(["McLaren Grand Prix"]);
    expect((await teams("org")).length).toBeGreaterThan(5);
  });
});
