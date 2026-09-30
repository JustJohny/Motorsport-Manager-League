import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { joinSnapshot, memberRows, splitSnapshot } from "../src/publish.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const league = {
  members: [
    { member: "organizer", team: "Tatra Racing", discord: "Organizer", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing" },
  ],
};

describe.skipIf(!existsSync(SAVE))("publish", () => {
  const state = extractLeague(Save.load(SAVE), league);

  it("keeps budget, HQ and parts out of the public snapshot", () => {
    const split = splitSnapshot(state);
    const pub = JSON.stringify(split.public);
    for (const t of split.public.teams) {
      expect(t).not.toHaveProperty("budget");
      expect(t).not.toHaveProperty("hq");
      expect(t).not.toHaveProperty("parts");
    }
    // No part GUID may leak into the public data.
    const partIds = split.teams.flatMap((t) => Object.values(t.private.parts).flat().map((p) => p.guid));
    expect(partIds.length).toBeGreaterThan(0);
    expect(partIds.filter((id) => pub.includes(id))).toEqual([]);
    expect(split.teams).toHaveLength(state.teams.length);
  });

  it("loses nothing: joining the split gives back the extract", () => {
    expect(joinSnapshot(JSON.parse(JSON.stringify(splitSnapshot(state))))).toEqual(state);
  });

  it("maps Discord usernames to teams", () => {
    expect(memberRows(league, state)).toEqual([
      { discord_username: "organizer", member: "organizer", team: "Tatra Racing", role: "organizer" },
      { discord_username: "alice", member: "alice", team: "Garuda Racing", role: "member" },
    ]);
  });
});
