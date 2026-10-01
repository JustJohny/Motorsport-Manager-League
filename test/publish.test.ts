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
      expect(t).not.toHaveProperty("design");
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

  it("extracts each team's design options, current design and improvement", () => {
    for (const t of state.teams) {
      const d = t.design!;
      // ERS engines and gearboxes are spec parts: MM won't design them.
      expect(Object.keys(d.types).sort()).toEqual(["Brakes", "FrontWing", "RearWing", "Suspension"]);
      expect(d.specParts).toEqual(["Engine", "Gearbox"]);
      for (const [type, o] of Object.entries(d.types)) {
        expect(o.ctx.slots, `${t.name} ${type}`).toBeGreaterThanOrEqual(1);
        expect(o.ctx.settings.materialsCost).toBeGreaterThan(0);
        // Three components per open level, plus the lead engineer's.
        expect(o.components.filter((c) => !c.engineer).length).toBe(3 * o.maxLevel);
        // Nothing above the levels the team's facility unlocks, engineer components included.
        for (const c of o.components) expect(c.level, `${t.name} ${type} component ${c.id}`).toBeLessThanOrEqual(o.maxLevel);
        expect(o.base.stat).toBeGreaterThan(0);
      }
      const parts = Object.values(t.parts).flat().map((p) => p.guid);
      for (const g of [...d.improvement.performance, ...d.improvement.reliability]) expect(parts).toContain(g);
      expect([2, 4, 6, 8]).toContain(d.improvement.slots);
      if (d.current) {
        const opts = d.types[d.current.type];
        expect(opts.components.map((c) => c.id)).toEqual(expect.arrayContaining(d.current.components));
        expect(d.current.end > d.current.start).toBe(true);
      }
    }
    expect(state.teams.filter((t) => t.design!.current).length).toBeGreaterThan(1);
  });

  it("maps Discord usernames to teams", () => {
    expect(memberRows(league, state)).toEqual([
      { discord_username: "organizer", member: "organizer", team: "Tatra Racing", role: "organizer" },
      { discord_username: "alice", member: "alice", team: "Garuda Racing", role: "member" },
    ]);
  });
});
