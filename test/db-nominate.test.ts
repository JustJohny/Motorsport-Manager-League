import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import type { LeagueState } from "../src/league-types.ts";
import { DEFAULT_SETTINGS, minWage, nextMinBid } from "../src/league-rules.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: nominating with an opening bid", () => {
  let state: LeagueState;
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const alice = () => t.member("alice"), bob = () => t.member("bob");
  const driverOf = (team: string) => state.teams.find((x) => x.name === team)!.staff.find((s) => s.job === "Driver" && s.person)!.person!;

  beforeAll(async () => {
    state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '20000000') where team in ('Garuda Racing', 'Octane Racing')`);
    expect((await t.member("org").query("select public.open_window(now() + interval '1 day')")).error).toBeNull();
  }, 120_000);

  it("starts an auction with the nominator leading, and leaves nothing behind when the bid is refused", async () => {
    const p = state.freeAgents.filter((x) => x.kind === "Driver")[3];
    const min = minWage(p, DEFAULT_SETTINGS);
    const nominate = (who: ReturnType<typeof alice>, wage: number, replacing: string) =>
      who.query<{ id: number }>("select public.nominate($1, $2, 2, $3) as id", [p.guid, wage, replacing]);
    const auctionsFor = () => alice().query<{ id: number; leading_team: string; bid_count: number; opened_by: string }>(
      "select id, leading_team, bid_count, opened_by from auctions where person_guid = $1", [p.guid]);

    // Below the opening price: refused, and no empty auction is left.
    expect((await nominate(alice(), min - 10_000, driverOf("Garuda Racing").guid)).error).toMatch(/minimum bid/);
    expect((await auctionsFor()).rows).toEqual([]);

    const ok = await nominate(alice(), min, driverOf("Garuda Racing").guid);
    expect(ok.error).toBeNull();
    expect((await auctionsFor()).rows).toEqual([{ id: ok.rows[0].id, leading_team: "Garuda Racing", bid_count: 1, opened_by: "Garuda Racing" }]);

    // Nominating someone already in auction is a normal bid on it: it must beat the leader.
    expect((await nominate(bob(), min, driverOf("Octane Racing").guid)).error).toMatch(/minimum bid/);
    const next = await nominate(bob(), nextMinBid(min, min, DEFAULT_SETTINGS), driverOf("Octane Racing").guid);
    expect(next.rows[0].id).toBe(ok.rows[0].id);
    expect((await auctionsFor()).rows[0]).toMatchObject({ leading_team: "Octane Racing", bid_count: 2 });
  });
});
