import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { pack, parseLossless, stringifyLossless, unpack } from "../src/codec/sav.ts";
import { extractLeague } from "../src/extract.ts";
import type { LeagueState } from "../src/league-types.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { tallyVote } from "../src/politics.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { castVotes, regulationChanges, type RuleVoteRow } from "../src/rule-votes.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
  ],
};

function reload(save: Save): Save {
  save.prepareForWrite();
  const f = save.file;
  const raw = unpack(pack({ version: f.version, headerText: stringifyLossless(f.header), dataText: stringifyLossless(f.data) }));
  return new Save({ version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) });
}

describe("MM's vote rules", () => {
  it("counts vote power, banks abstentions and spends extra power", () => {
    const t = tallyVote([
      { team: "A", vote: "yes", power: 3 }, { team: "B", vote: "no", power: 1 }, { team: "C", vote: "no", power: 1 }, { team: "D", vote: "abstain", power: 1 },
    ], [2016, 1]);
    expect(t).toMatchObject({ yes: 3, no: 2, abstained: 1, accepted: true });
    expect(t.powerChanges).toEqual([{ team: "A", delta: -2 }, { team: "D", delta: 1 }]);
  });
});

describe.skipIf(!existsSync(SAVE))("rule votes on a real save and in the database", () => {
  let state: LeagueState;
  beforeAll(() => { state = extractLeague(Save.load(SAVE), league); }, 120_000);

  it("settles the next vote with the league's result instead of MM's, and applies overrides", () => {
    const regs = state.championship.regulations!;
    const next = regs.votes.find((v) => v.status === "upcoming")!;
    const save = Save.load(SAVE);
    const ch = save.championship(save.team("Tatra Racing"));
    const ps = save.g.deref<any>(ch.politicalSystem);
    const voteEvents = (s: Save) => s.g.list<any>(s.data.calendar.mDelayedEvents).filter((e) => e.OnEventTrigger?.methodNames?.[0] === "Vote").length;
    const before = { index: ps.mNextVoteIndex, results: save.g.list(ps.mVoteResultsForSeason).length, events: voteEvents(save), power: save.team("Garuda Racing").votingPower };
    // Alice votes yes with 1 extra power; the rule is forced through by the organizer's yes too.
    const rows: RuleVoteRow[] = [{ team: "Garuda Racing", season: regs.season, rule_id: next.ruleId, choice: "yes", extra_power: Math.min(1, before.power) }];
    const otherGroup = Object.values(regs.rules).find((r) => r.group === "PointsSystem" && !regs.next.includes(r.id))!;
    const { changes, results } = regulationChanges(regs, ch.championshipID, next.date, null, rows, [{ season: regs.season, rule_group: "PointsSystem", rule_id: otherGroup.id }], []);
    expect(results.length).toBeGreaterThan(0);
    expect(castVotes(regs, next.ruleId, rows).length).toBe(regs.teams.length);
    const log = applyChanges(save, { changes });
    expect(log[0]).toMatch(/accepted|rejected/);

    const r = reload(save);
    expect(r.g.validate()).toEqual([]);
    const rps = r.g.deref<any>(r.championship(r.team("Tatra Racing")).politicalSystem);
    expect(rps.mNextVoteIndex).toBe(before.index + results.length);
    expect(r.g.list(rps.mVoteResultsForSeason).length).toBe(before.results + results.length);
    expect(voteEvents(r)).toBe(before.events - results.length);
    const after = extractLeague(r, league).championship.regulations!;
    const first = results[0];
    expect(after.votes.find((v) => v.ruleId === first.rule_id)).toMatchObject({ status: "held", result: { accepted: first.accepted } });
    if (first.accepted) expect(after.next).toContain(first.rule_id);
    expect(after.next).toContain(otherGroup.id);
    expect(new Set(after.next.map((id) => after.rules[id].group)).size).toBe(after.next.length);
  }, 120_000);

  it("takes member votes with MM's vote power, and next-season choices from the organizer only", async () => {
    const t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    const regs = state.championship.regulations!;
    const open = regs.votes.find((v) => v.status === "upcoming")!;
    const held = regs.votes.find((v) => v.status === "held");
    const power = regs.teams.find((x) => x.team === "Garuda Racing")!.votingPower;
    const vote = (id: number, choice: string, extra: number) => t.member("alice").query("select public.cast_rule_vote($1, $2, $3)", [id, choice, extra]);
    expect((await vote(open.ruleId, "yes", power + 1)).error).toMatch(/at most/);
    expect((await vote(open.ruleId, "abstain", 1)).error).toMatch(/no vote power/);
    if (held) expect((await vote(held.ruleId, "yes", 0)).error).toMatch(/isn't open/);
    expect((await vote(open.ruleId, "no", power)).error).toBeNull();
    expect((await vote(open.ruleId, "yes", 0)).error).toBeNull(); // members can change their vote
    expect((await t.member("org").query<{ choice: string }>("select choice from rule_votes")).rows).toEqual([{ choice: "yes" }]);

    const rule = Object.values(regs.rules).find((r) => r.group === "PointsSystem")!;
    expect((await t.member("alice").query("select public.set_next_rule('PointsSystem', $1)", [rule.id])).error).toMatch(/Only the organizer/);
    expect((await t.member("org").query("select public.set_next_rule('Tyres', $1)", [rule.id])).error).toMatch(/not in group/);
    expect((await t.member("org").query("select public.set_next_rule('PointsSystem', $1)", [rule.id])).error).toBeNull();
    expect((await t.member("alice").query("select rule_group, rule_id from next_rule_overrides")).rows).toEqual([{ rule_group: "PointsSystem", rule_id: rule.id }]);
  }, 120_000);
});
