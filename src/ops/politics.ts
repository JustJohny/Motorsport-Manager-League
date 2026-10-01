import type { Json } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
import { delayedEvents } from "./calendar.ts";

const VOTE_RESULT = { Accepted: 0, Rejected: 1 } as const;

function leagueChampionship(save: Save, key: string | number): Obj {
  const c = save.g.list<Obj>(save.data.championshipManager.mEntities)
    .find((c) => c.championshipID === key || save.championshipName(c) === key);
  if (!c) throw new Error(`No championship ${JSON.stringify(key)}`);
  return c;
}

/** Every PoliticalVote object of the series in the save, by rule id (the catalogue). */
function ruleObject(save: Save, champ: Obj, ruleId: number): Obj {
  const g = save.g;
  for (const c of g.list<Obj>(save.data.championshipManager.mEntities)) {
    if (c.series !== champ.series) continue;
    const lists = [g.deref<Obj>(c.rules).mRules, g.deref<Obj>(c.nextYearsRules).mRules, g.deref<Obj>(c.politicalSystem)?.mVotesForSeason ?? []];
    for (const l of lists) {
      const v = g.list<Obj>(l).find((x) => x?.ID === ruleId);
      if (v) return v;
    }
  }
  throw new Error(`No rule ${ruleId} in the save`);
}

/** ChampionshipRules.AddRule: one rule per group, the new one replaces it. */
function addRule(save: Save, rules: Obj, rule: Obj) {
  const list = save.g.rawList(rules.mRules);
  for (let i = list.length - 1; i >= 0; i--) if (save.g.deref<Obj>(list[i])?.group === rule.group) list.splice(i, 1);
  list.push(save.g.ref(rule));
}

export interface ConcludeVoteOp {
  op: "concludeVote";
  championship: string | number;
  ruleId: number;
  yes: number;
  no: number;
  abstained: number;
  accepted: boolean;
  /** Vote power banked (+1 for abstaining) or spent (extra power used). */
  powerChanges: { team: string; delta: number }[];
}

/**
 * Settle the season's next vote with the league's result, in place of MM's own vote
 * (PoliticalSystem.ConcludeVoting): an accepted rule goes into next season's rules, the result is
 * recorded, and the vote's calendar event is removed so MM doesn't hold it again.
 */
export function concludeVote(save: Save, op: ConcludeVoteOp): string {
  const g = save.g;
  const champ = leagueChampionship(save, op.championship);
  const ps = g.deref<Obj>(champ.politicalSystem);
  const votes = g.list<Obj>(ps.mVotesForSeason);
  const index = ps.mNextVoteIndex as number;
  const vote = votes[index];
  if (!vote) throw new Error("No vote left this season");
  if (vote.ID !== op.ruleId) {
    throw new Error(`The next vote is rule ${vote.ID}, not ${op.ruleId} (votes are settled in MM's order)`);
  }

  if (op.accepted) {
    addRule(save, g.deref<Obj>(champ.nextYearsRules), vote);
    ps.mNewRuleAproved = (ps.mNewRuleAproved ?? 0) + 1;
  }
  ps.mLatestVoteResult = op.accepted ? VOTE_RESULT.Accepted : VOTE_RESULT.Rejected;
  const results = g.rawList(ps.mVoteResultsForSeason);
  const template = results.length ? g.deref<Obj>(results[results.length - 1]) : null;
  const result: Obj = template ? g.clone({ ...template, votedSubject: null }) : { $version: "v0" };
  Object.assign(result, {
    yesVotesCount: op.yes, noVotesCount: op.no, abstainedVotesCount: op.abstained,
    votedSubject: g.ref(vote), voteResult: op.accepted ? VOTE_RESULT.Accepted : VOTE_RESULT.Rejected,
  });
  if (template) {
    const type = save.types.runtime.get(template);
    if (type) save.types.runtime.set(result, type);
  }
  results.push(result);
  ps.mNextVoteIndex = index + 1;
  ps.mActiveVote = votes[index + 1] ? g.ref(votes[index + 1]) : null;
  if (index + 1 >= votes.length) ps.mEndOfSeasonMessage = true;

  // The earliest pending "Vote" event of this political system is this vote's.
  const isVoteEvent = (e: Obj) => e?.OnEventTrigger?.methodNames?.[0] === "Vote" && g.deref(e.OnEventTrigger.targets?.[0]) === ps;
  const events = delayedEvents(save);
  const i = events.findIndex((e) => isVoteEvent(g.deref<Obj>(e)));
  let removed = "";
  if (i >= 0) {
    const ev = g.deref<Obj>(events[i]);
    events.splice(i, 1);
    const own = g.rawList(ps.mCalendarEvents);
    const j = own.findIndex((e) => g.deref(e) === ev);
    if (j >= 0) own.splice(j, 1);
    removed = `, MM's vote on ${String(ev.triggerDate).slice(0, 10)} removed`;
  }

  for (const c of op.powerChanges) {
    const team = save.team(c.team);
    team.votingPower = Math.max(0, ((team.votingPower as number) ?? 0) + c.delta);
  }
  return `${save.championshipName(champ)}: rule ${vote.ID} (${vote.group}) ${op.accepted ? "accepted" : "rejected"} ${op.yes}-${op.no}${removed}`;
}

export interface SetNextRuleOp {
  op: "setNextRule";
  championship: string | number;
  group: string;
  /** A rule of that group, or null to keep the current season's rule. */
  ruleId: number | null;
}

/** The organizer's choice for next season: put a rule in a group of `nextYearsRules`. */
export function setNextRule(save: Save, op: SetNextRuleOp): string {
  const g = save.g;
  const champ = leagueChampionship(save, op.championship);
  const next = g.deref<Obj>(champ.nextYearsRules);
  let rule: Obj | undefined;
  if (op.ruleId == null) rule = g.list<Obj>(g.deref<Obj>(champ.rules).mRules).find((v) => v.group === op.group);
  else rule = ruleObject(save, champ, op.ruleId);
  if (rule && rule.group !== op.group) throw new Error(`Rule ${op.ruleId} is in group ${rule.group}, not ${op.group}`);
  if (!rule) {
    const list: Json[] = g.rawList(next.mRules);
    for (let i = list.length - 1; i >= 0; i--) if (g.deref<Obj>(list[i])?.group === op.group) list.splice(i, 1);
    return `${save.championshipName(champ)}: next season has no ${op.group} rule`;
  }
  addRule(save, next, rule);
  return `${save.championshipName(champ)}: next season ${op.group} = rule ${rule.ID} (${rule.effectType})`;
}
