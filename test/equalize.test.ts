import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import { fieldDefaults } from "../src/equalize.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { carPartDesign } from "../src/ops/design.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const LT10 = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
  ],
};

function reload(save: Save): Save {
  save.prepareForWrite();
  expect(save.g.validate()).toEqual([]);
  const f = save.file;
  const raw = unpack(pack({ version: f.version, headerText: stringifyLossless(f.header), dataText: stringifyLossless(f.data) }));
  return new Save({ version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) });
}

describe.skipIf(!existsSync(LT10))("equalizing the field", () => {
  it("makes every team's HQ, car, staff, crew and budget equal, drivers untouched", () => {
    const save = Save.load(LT10);
    const before = extractLeague(save, league);
    const settings = fieldDefaults(before.teams.map(({ budget, hq, parts, design, gameCrew, ...pub }) => ({ pub, priv: { budget, hq, parts, design, gameCrew } })),
      before.championship.pitCrew!.aiLevel);
    expect(Object.keys(settings.parts!).sort()).toEqual(["Brakes", "FrontWing", "RearWing", "Suspension"]);
    const teams = before.teams.map((t) => t.name);
    const designing = teams.filter((n) => carPartDesign(save, save.team(n)).mStage === 1);
    expect(designing.length).toBeGreaterThan(0);

    applyChanges(save, { changes: [{ op: "equalizeTeams", teams, ...settings }] });
    const back = reload(save);
    const after = extractLeague(back, league);

    for (const t of after.teams) {
      expect(t.budget, t.name).toBe(settings.budget);
      for (const [name, level] of Object.entries(settings.hq!)) expect(t.hq.find((b) => b.name === name)?.level, `${t.name} ${name}`).toBe(level);
      for (const [type, v] of Object.entries(settings.parts!)) {
        for (const p of t.parts[type]) expect({ stat: p.stat, perf: p.performance, rel: p.reliability }, `${t.name} ${type}`).toEqual({ stat: v.stat, perf: 0, rel: v.reliability });
      }
      const lead = t.staff.find((s) => s.job === "EngineerLead")?.person;
      if (lead) expect(lead.stats).toEqual(settings.leadDesigner);
      for (const m of t.staff.filter((s) => s.job === "Mechanic" && s.person)) expect(m.person!.stats).toEqual(settings.mechanics);
      expect(carPartDesign(back, back.team(t.name)).mStage, `${t.name} design cancelled`).toBe(0);
      // Drivers keep their own stats; spec parts (ERS engines and gearboxes) are the supplier's.
      const was = before.teams.find((x) => x.name === t.name)!;
      expect(t.staff.filter((s) => s.job === "Driver").map((s) => s.person?.stats)).toEqual(was.staff.filter((s) => s.job === "Driver").map((s) => s.person?.stats));
      expect(t.parts.Engine).toEqual(was.parts.Engine);
    }
    // The career team's real crew and the AI crews get the skill.
    expect(after.teams.find((t) => t.isPlayerTeam)!.gameCrew!.members.every((m) => m.stats.every((s) => s === settings.pitCrew!.skill))).toBe(true);
  }, 120_000);

  it("is queued by the organizer only", async () => {
    const save = Save.load(LT10);
    const state = extractLeague(save, league);
    const t = await leagueDb();
    await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))]);
    expect((await t.member("alice").query("select public.queue_equalize('{\"budget\": 1}')")).error).toMatch(/Only the organizer/);
    expect((await t.member("org").query("select public.queue_equalize('{}')")).error).toMatch(/Nothing to equalize/);
    expect((await t.member("org").query("select public.queue_equalize('{\"budget\": 1}')")).error).toBeNull();
    expect((await t.member("org").query("select public.queue_equalize('{\"budget\": 2}')")).error).toBeNull();
    expect((await t.member("org").query("select settings, status from equalize_orders")).rows).toEqual([{ settings: { budget: 2 }, status: "queued" }]);
    expect((await t.member("alice").query("select * from equalize_orders")).rows).toEqual([]);
    expect((await t.member("org").query("select public.cancel_equalize()")).error).toBeNull();
    expect((await t.member("org").query<{ status: string }>("select status from equalize_orders")).rows).toEqual([{ status: "cancelled" }]);
  }, 120_000);
});
