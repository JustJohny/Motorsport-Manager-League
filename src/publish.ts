import type { LeagueConfig, LeagueMemberRow, LeagueState, SplitSnapshot, TeamState } from "./league-types.ts";

import { rest, type SupabaseEnv } from "./supabase.ts";

export type { PublicSnapshot, SplitSnapshot, TeamPrivate, TeamPublic } from "./league-types.ts";

/** Split an extract into the rows the website stores, so row-level security can hide private data. */
export function splitSnapshot(state: LeagueState): SplitSnapshot {
  return {
    public: {
      extractedAt: state.extractedAt,
      gameDate: state.gameDate,
      championship: state.championship,
      teams: state.teams.map(({ budget, hq, parts, design, ...pub }) => pub),
    },
    teams: state.teams.map(({ name, budget, hq, parts, design }) => ({ team: name, private: { budget, hq, parts, design } })),
    freeAgents: state.freeAgents,
  };
}

/** Inverse of splitSnapshot, as the organizer sees it. */
export function joinSnapshot(s: SplitSnapshot): LeagueState {
  const priv = new Map(s.teams.map((t) => [t.team, t.private]));
  return {
    extractedAt: s.public.extractedAt,
    gameDate: s.public.gameDate,
    championship: s.public.championship,
    teams: s.public.teams.map((t) => ({ ...t, ...priv.get(t.name)! })) as TeamState[],
    freeAgents: s.freeAgents,
  };
}

/** Members with a Discord username, keyed by the team name the extract uses. */
export function memberRows(cfg: LeagueConfig, state: LeagueState): LeagueMemberRow[] {
  return cfg.members.filter((m) => m.discord).map((m) => {
    const team = state.teams.find((t) => t.member === m.member);
    if (!team) throw new Error(`member ${m.member}: team ${m.team} is not in the league championship`);
    return {
      discord_username: m.discord!.toLowerCase(),
      member: m.member,
      team: team.name,
      role: m.organizer ? "organizer" : "member",
    };
  });
}

/**
 * Upload a snapshot through the `publish_snapshot` database function, which replaces the
 * member list and inserts the snapshot in one transaction. If a network error hides the reply
 * after the insert, the retry adds a duplicate snapshot, which is harmless: the site reads the newest.
 */
export async function publish(env: SupabaseEnv, members: LeagueMemberRow[], split: SplitSnapshot, seriesName?: string): Promise<number> {
  return Number(await rest<number>(env, "POST", "rpc/publish_snapshot", { members, snapshot: split, series_name: seriesName ?? null }));
}
