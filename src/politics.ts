// MM's rule votes (PoliticalSystem, PoliticalVote, VoteChoice) on plain data, so the toolkit, the
// league site and the database tests agree on AI votes and results. Only type imports: the site
// bundles this file.

import type { Regulations, Rule, RuleVote, VoteChoice } from "./league-types.ts";

/** PoliticalVote.TeamCharacteristics, in enum order. */
export const TEAM_CHARACTERISTICS = [
  "Traditionalist", "Progressive", "Egalitarian", "Gimmicky",
  "Track stats favourable", "Track stats unfavourable", "New track favourable", "Old track unfavourable",
  "New layout favourable", "New layout unfavourable", "Old track favourable",
  "Team quality low", "Team quality average", "Team quality high",
  "Championship leader", "Championship position high", "Championship position average", "Championship position low",
  "Budget low", "Budget average", "Budget high",
  "Cornering speed very high", "Cornering speed high", "Cornering speed average", "Cornering speed low", "Cornering speed very low",
  "Tyre wear bad", "Tyre wear good", "Fuel burn bad", "Fuel burn good",
  "Driver quality low", "Driver quality high",
] as const;

export const C = Object.fromEntries(TEAM_CHARACTERISTICS.map((n, i) => [n, i])) as Record<(typeof TEAM_CHARACTERISTICS)[number], number>;

/** What the toolkit knows about a team for PoliticalVote.GetTeamCharacterists (0-based ranks). */
export interface TeamStanding {
  /** Fixed political leanings (team.votingCharacteristics). */
  fixed: number[];
  /** Championship position, 1-based. */
  position: number;
  budgetRank: number;
  driverRank: number;
  fuelRank: number;
  tyreRank: number;
}

/**
 * The characteristics MM gives a team, from the parts the save makes reliable: fixed leanings,
 * championship position, team quality (expected position, approximated by the standings), budget,
 * driver quality, fuel burn and tyre wear. Cornering speed and track stats are left out.
 */
export function teamCharacteristics(t: TeamStanding): number[] {
  const out = [...t.fixed];
  const p = t.position;
  out.push(p < 2 ? C["Championship leader"] : p < 5 ? C["Championship position high"] : p < 7 ? C["Championship position average"] : C["Championship position low"]);
  const q = p - 1;
  if (q < 3) out.push(C["Team quality high"]);
  else if (q < 7 && q > 4) out.push(C["Team quality average"]);
  else if (q > 4) out.push(C["Team quality low"]);
  if (t.budgetRank < 3) out.push(C["Budget high"]);
  else if (t.budgetRank < 7 && t.budgetRank > 4) out.push(C["Budget average"]);
  else if (t.budgetRank > 7) out.push(C["Budget low"]);
  if (t.driverRank < 3) out.push(C["Driver quality high"]);
  else if (t.driverRank > 6) out.push(C["Driver quality low"]);
  if (t.fuelRank < 3) out.push(C["Fuel burn good"]);
  else if (t.fuelRank > 6) out.push(C["Fuel burn bad"]);
  if (t.tyreRank < 3) out.push(C["Tyre wear good"]);
  else if (t.tyreRank > 6) out.push(C["Tyre wear bad"]);
  return out;
}

/** A deterministic 0..1 roll, so the published prediction is exactly what the league applies. */
export function roll(...keys: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of keys.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * How an AI team votes (PoliticalVote.GetVoteImpactOnTeam + PoliticalSystem.ConcludeVoting): Yes
 * if the rule helps more of its characteristics than it hurts, No if the other way round; when
 * neutral, 25 % abstain and otherwise Yes or No at random. The difference adds vote power, up to
 * the team's banked power.
 */
export function predictAiVote(rule: Pick<Rule, "beneficial" | "detrimental">, characteristics: number[], votingPower: number, seed: (string | number)[]) {
  const good = rule.beneficial.filter((c) => characteristics.includes(c)).length;
  const bad = rule.detrimental.filter((c) => characteristics.includes(c)).length;
  const power = 1 + Math.min(Math.abs(good - bad), votingPower);
  if (good > bad) return { vote: "yes" as VoteChoice, power };
  if (bad > good) return { vote: "no" as VoteChoice, power };
  if (roll(...seed, "abstain") > 0.75) return { vote: "abstain" as VoteChoice, power: 1 };
  return { vote: (roll(...seed, "side") > 0.5 ? "yes" : "no") as VoteChoice, power };
}

export interface CastVote { team: string; vote: VoteChoice; power: number }

/**
 * ConcludeVoting: the side with more vote power wins; a tie is decided at random. Abstaining
 * banks 1 vote power; voting with more than 1 spends the extra (VoteChoice.Voted / Abstained).
 */
export function tallyVote(votes: CastVote[], seed: (string | number)[]) {
  const yes = votes.filter((v) => v.vote === "yes").reduce((s, v) => s + v.power, 0);
  const no = votes.filter((v) => v.vote === "no").reduce((s, v) => s + v.power, 0);
  const abstained = votes.filter((v) => v.vote === "abstain").length;
  const accepted = yes > no || (yes === no && roll(...seed, "tie") > 0.5);
  const powerChanges = votes.map((v) => ({ team: v.team, delta: v.vote === "abstain" ? 1 : -(v.power - 1) })).filter((c) => c.delta !== 0);
  return { yes, no, abstained, accepted, tie: yes === no, powerChanges };
}

/**
 * The game date before which a vote must be settled at this checkpoint's pull: the organizer then
 * plays on to the next checkpoint. Before a race (B) that's just after the race weekend; after a
 * race (A) it's the start of the next race weekend.
 */
export function voteCutoff(gameDate: string, nextRaceDate: string | null): string {
  if (!nextRaceDate) return "9999-12-31";
  const t = (d: string) => Date.parse(d.slice(0, 19) + "Z");
  const day = 86_400_000;
  const beforeRace = t(gameDate) >= t(nextRaceDate) - day;
  return new Date(beforeRace ? t(nextRaceDate) + 5 * day : t(nextRaceDate)).toISOString().slice(0, 19) + ".0000000";
}

/** Upcoming votes this checkpoint's pull settles. */
export function votesClosingNow(votes: RuleVote[], gameDate: string, nextRaceDate: string | null): RuleVote[] {
  const cutoff = voteCutoff(gameDate, nextRaceDate);
  return votes.filter((v) => v.status === "upcoming" && v.date < cutoff);
}

export interface RuleVoteRow { team: string; season: number; rule_id: number; choice: VoteChoice; extra_power: number }
export interface OverrideRow { season: number; rule_group: string; rule_id: number }
export interface VoteResultRow { season: number; rule_id: number; yes: number; no: number; abstained: number; accepted: boolean }

/** Every team's vote on a rule: members from the site (no vote = abstain, as MM does), AI as published. */
export function castVotes(regs: Regulations, ruleId: number, rows: RuleVoteRow[]): CastVote[] {
  const vote = regs.votes.find((v) => v.ruleId === ruleId);
  const members = regs.teams.filter((t) => t.member).map((t) => {
    const r = rows.find((x) => x.team === t.team && x.rule_id === ruleId && x.season === regs.season);
    return { team: t.team, vote: r?.choice ?? "abstain", power: r && r.choice !== "abstain" ? 1 + r.extra_power : 1 } as CastVote;
  });
  return [...members, ...(vote?.aiVotes ?? [])];
}

