import type { ChangeSet } from "./apply.ts";
import type { CrewContext, CrewUpdate } from "./crew-orders.ts";
import type { EqualizeSettings, PitCrewRules } from "./league-types.ts";
import { crewRow, startingCrew, type NamePool } from "./pit-crew.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

export interface EqualizeRow { id: number; settings: EqualizeSettings; status: string }

interface SnapshotPublic {
  gameDate: string;
  championship: { calendar: unknown[]; lastRace: { round: number } | null; pitCrew?: PitCrewRules };
  teams: { name: string }[];
}

/** The queued equalization, with the latest snapshot's teams and crew rule. */
export async function fetchEqualize(env: SupabaseEnv) {
  const [[row], [snap]] = await Promise.all([
    rest<EqualizeRow[]>(env, "GET", "equalize_orders?status=eq.queued&select=*"),
    rest<{ public: SnapshotPublic }[]>(env, "GET", "snapshots?select=public&order=id.desc&limit=1"),
  ]);
  return { row: row ?? null, snapshot: snap?.public ?? null };
}

/** `equalizeTeams` for every team of the championship. */
export function equalizeChanges(row: EqualizeRow, teams: string[]): ChangeSet["changes"] {
  return [{ op: "equalizeTeams", teams, ...row.settings }];
}

/**
 * Member crews restart as equal starting crews at the organizer's skill. The people keep their
 * names (as a name pool), contracts start fresh; funding, applicants and the log stay.
 */
export function resetCrews(ctx: CrewContext, series: string, snap: SnapshotPublic, skill: number): CrewUpdate[] {
  const rules = snap.championship.pitCrew;
  if (!rules) return [];
  return ctx.teams.map((t) => {
    const people = ctx.crew.filter((c) => c.team === t.team);
    const names: NamePool = {};
    for (const p of people) {
      const e = (names[p.nationality] ??= { first: [], last: [] });
      e.first.push(p.first_name);
      e.last.push(p.last_name);
    }
    const crew = startingCrew(series, t.team, skill, rules.roles, Object.keys(names).length ? names : { League: { first: ["Crew"], last: ["Member"] } },
      snap.gameDate, snap.championship.calendar.length);
    return {
      team: t.team, processed_round: t.processed_round,
      crew: crew.map(crewRow),
      applicants: ctx.applicants.filter((a) => a.team === t.team),
      spend: [], log: [{ round: snap.championship.lastRace?.round ?? null, message: `Crew reset by the league's equalization (skill ${skill})` }],
    };
  });
}

export async function markEqualizeApplied(env: SupabaseEnv, id: number) {
  await rest(env, "PATCH", `equalize_orders?id=eq.${id}`, { status: "applied" });
}
