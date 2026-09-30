import type { LeagueConfig, LeagueMemberRow, LeagueState, SplitSnapshot, TeamState } from "./league-types.ts";

export type { PublicSnapshot, SplitSnapshot, TeamPrivate, TeamPublic } from "./league-types.ts";

/** Split an extract into the rows the website stores, so row-level security can hide private data. */
export function splitSnapshot(state: LeagueState): SplitSnapshot {
  return {
    public: {
      extractedAt: state.extractedAt,
      gameDate: state.gameDate,
      championship: state.championship,
      teams: state.teams.map(({ budget, hq, parts, ...pub }) => pub),
    },
    teams: state.teams.map(({ name, budget, hq, parts }) => ({ team: name, private: { budget, hq, parts } })),
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
 * member list and inserts the snapshot in one transaction. Needs the service-role key.
 */
export async function publish(url: string, serviceKey: string, members: LeagueMemberRow[], split: SplitSnapshot): Promise<number> {
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/publish_snapshot`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys must not.
      ...(serviceKey.startsWith("sb_") ? {} : { authorization: `Bearer ${serviceKey}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify({ members, snapshot: split }),
  });
  if (!res.ok) throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  return Number(await res.json());
}
