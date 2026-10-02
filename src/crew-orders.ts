import type { ChangeSet } from "./apply.ts";
import type { LeagueState } from "./league-types.ts";
import {
  applicant, applicantRow, crewAfterRace, crewMember, crewRow, refillApplicants, startingCrew, taskStats,
  type CrewPersonRow, type CrewRow, type NamePool, type SpendLine,
} from "./pit-crew.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export type { CrewPersonRow, CrewRow } from "./pit-crew.ts";
export interface CrewTeamRow { team: string; funding: number; processed_round: number }
export interface CrewSpendRow { id: number; team: string; kind: string; description: string; amount: number | string }


export interface CrewContext { teams: CrewTeamRow[]; crew: CrewRow[]; applicants: CrewPersonRow[] }

export async function fetchCrewContext(env: SupabaseEnv): Promise<CrewContext> {
  const [teams, crew, applicants] = await Promise.all([
    rest<CrewTeamRow[]>(env, "GET", "pit_crew_teams?select=*"),
    rest<CrewRow[]>(env, "GET", "pit_crew?select=*&order=id"),
    rest<CrewPersonRow[]>(env, "GET", "pit_crew_applicants?select=*&order=id"),
  ]);
  return { teams, crew, applicants };
}

export interface CrewUpdate {
  team: string;
  processed_round: number;
  crew: CrewRow[];
  applicants: CrewPersonRow[];
  spend: SpendLine[];
  log: { round: number | null; message: string }[];
  /** Only for a new crew. */
  funding?: number;
}

/**
 * What a publish does to member crews. A member AI team without a crew gets the starting crew
 * (the career team keeps MM's own, so it's skipped). A crew gets every finished round after its
 * `processed_round` run through `crewAfterRace`, with MM's mistake count for that round. A new
 * season (the round count went back) starts counting again.
 */
export function crewUpdates(state: LeagueState, ctx: CrewContext, series: string, names: NamePool): CrewUpdate[] {
  const ch = state.championship;
  const rules = ch.pitCrew;
  if (!rules) return [];
  const lastRound = ch.lastRace?.round ?? 0;
  const updates: CrewUpdate[] = [];
  for (const t of state.teams.filter((x) => x.member && !x.isPlayerTeam && !x.gameCrew)) {
    const row = ctx.teams.find((r) => r.team === t.name);
    if (!row) {
      const crew = startingCrew(series, t.name, rules.aiLevel, rules.roles, names, state.gameDate, ch.calendar.length);
      updates.push({
        team: t.name, processed_round: lastRound, funding: 1,
        crew: crew.map(crewRow),
        applicants: refillApplicants([], series, t.name, lastRound, names, state.gameDate).map(applicantRow),
        spend: [], log: [{ round: lastRound || null, message: `Crew formed: ${crew.length} people at the series' average pit stop level` }],
      });
      continue;
    }
    const from = row.processed_round > lastRound ? 0 : row.processed_round;
    if (from === lastRound && from === row.processed_round) continue;
    let crew = ctx.crew.filter((c) => c.team === t.name).map(crewMember);
    let applicants = ctx.applicants.filter((a) => a.team === t.name).map(applicant);
    const spend: SpendLine[] = [];
    const log: CrewUpdate["log"] = [];
    for (let round = from + 1; round <= lastRound; round++) {
      const mistakes = ch.pitStops?.find((r) => r.round === round)?.teams.find((x) => x.team === t.name)?.mistakes ?? 0;
      const date = ch.calendar[round - 1]?.date ?? state.gameDate;
      const out = crewAfterRace({ series, team: t.name, round, gameDate: date, mistakes, funding: row.funding, roles: rules.roles, crew, applicants, names });
      crew = out.crew;
      applicants = out.applicants;
      spend.push(...out.spend);
      if (mistakes) log.push({ round, message: `${mistakes} pit stop mistake${mistakes > 1 ? "s" : ""}: confidence hit` });
      for (const l of out.left) log.push({ round, message: `${l.name} left (${l.reason})` });
    }
    updates.push({ team: t.name, processed_round: lastRound, crew: crew.map(crewRow), applicants: applicants.map(applicantRow), spend, log });
  }
  return updates;
}

export async function saveCrewUpdates(env: SupabaseEnv, updates: CrewUpdate[]) {
  for (const u of updates) {
    await rest(env, "POST", "rpc/save_team_crew", {
      team_name: u.team, processed_round: u.processed_round, crew: u.crew, applicants: u.applicants,
      spend: u.spend, log: u.log, funding: u.funding ?? null,
    });
  }
}

/** Each site-run crew's skills as AIPitCrew task values, for both cars. */
export function crewChanges(ctx: CrewContext, roles: number[]): ChangeSet["changes"] {
  return ctx.teams.flatMap((t) => {
    const tasks = taskStats(ctx.crew.filter((c) => c.team === t.team).map(crewMember), roles);
    return tasks.length ? [{ op: "setPitCrew" as const, team: t.team, tasks: tasks.map(({ target, stat, confidence }) => ({ target, stat, confidence })) }] : [];
  });
}

export const crewSpendChanges = (rows: CrewSpendRow[]): ChangeSet["changes"] =>
  rows.map((r) => ({ op: "adjustBudget" as const, team: r.team, delta: -Number(r.amount), reason: r.description }));

export async function fetchCrewSpend(env: SupabaseEnv) {
  return rest<CrewSpendRow[]>(env, "GET", "crew_spend?status=eq.queued&select=*&order=created_at");
}

export async function markCrewSpendApplied(env: SupabaseEnv, ids: number[]) {
  if (ids.length) await rest(env, "PATCH", `crew_spend?id=in.(${ids.join(",")})`, { status: "applied" });
}
