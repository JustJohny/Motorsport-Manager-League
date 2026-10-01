import type { ChangeSet } from "./apply.ts";
import type { Regulations } from "./league-types.ts";
import { castVotes, tallyVote, votesClosingNow, type OverrideRow, type RuleVoteRow, type VoteResultRow } from "./politics.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export type { OverrideRow, RuleVoteRow, VoteResultRow } from "./politics.ts";
export { castVotes } from "./politics.ts";

/**
 * The votes this checkpoint settles (see votesClosingNow), in MM's order, as `concludeVote`
 * changes; then the organizer's choices for next season (`setNextRule`), which win over votes.
 */
export function regulationChanges(
  regs: Regulations, championship: number, gameDate: string, nextRaceDate: string | null,
  rows: RuleVoteRow[], overrides: OverrideRow[], decided: VoteResultRow[],
) {
  const changes: ChangeSet["changes"] = [];
  const results: VoteResultRow[] = [];
  for (const v of votesClosingNow(regs.votes, gameDate, nextRaceDate)) {
    if (decided.some((d) => d.season === regs.season && d.rule_id === v.ruleId)) continue;
    const t = tallyVote(castVotes(regs, v.ruleId, rows), [regs.season, v.ruleId]);
    changes.push({ op: "concludeVote", championship, ruleId: v.ruleId, yes: t.yes, no: t.no, abstained: t.abstained, accepted: t.accepted, powerChanges: t.powerChanges });
    results.push({ season: regs.season, rule_id: v.ruleId, yes: t.yes, no: t.no, abstained: t.abstained, accepted: t.accepted });
  }
  for (const o of overrides.filter((o) => o.season === regs.season)) {
    changes.push({ op: "setNextRule", championship, group: o.rule_group, ruleId: o.rule_id });
  }
  return { changes, results };
}

export async function fetchRegulationContext(env: SupabaseEnv) {
  const [[snap], rows, overrides, decided] = await Promise.all([
    rest<{ public: { gameDate: string; championship: { id: number; calendar: { date: string; ended: boolean }[]; regulations?: Regulations } } }[]>(
      env, "GET", "snapshots?select=public&order=id.desc&limit=1"),
    rest<RuleVoteRow[]>(env, "GET", "rule_votes?select=*"),
    rest<OverrideRow[]>(env, "GET", "next_rule_overrides?select=*"),
    rest<VoteResultRow[]>(env, "GET", "rule_vote_results?select=*"),
  ]);
  return { snapshot: snap?.public ?? null, rows, overrides, decided };
}

export async function recordVoteResults(env: SupabaseEnv, results: VoteResultRow[]) {
  if (results.length) await rest(env, "POST", "rule_vote_results", results);
}
