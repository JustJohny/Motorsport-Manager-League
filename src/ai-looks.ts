import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChangeSet } from "./apply.ts";
import type { LeagueConfig } from "./league-types.ts";
import { LEAGUE_COLOR_ID_START, type TeamLook } from "./team-colours.ts";

/**
 * Looks for the AI teams of a league (league.json "aiLooks", e.g. examples/f1-2016-looks.json):
 * real colours written over the AI team's own row in the Team Colours mod, and a livery pattern
 * re-applied at every pull, since MM re-rolls AI liveries each season (Team.SelectNewLiveryForSeason).
 *
 * Member teams always win: an entry for a team a member runs is ignored, so the member keeps the
 * look they picked on the site (or MM's own until they pick one). See docs/save-schema.md,
 * "Team colours, livery and logos".
 */

export interface AiLook {
  /** The team's name in the save (after renames), for logs. */
  team: string;
  /** MM's teamID: kept through renames and takeovers, so it identifies the team in the save. */
  teamID: number;
  /** The team's own row in MM's Team Colours table, which `colours` replaces. */
  colorID?: number;
  colours?: TeamLook;
  /** A livery `id` valid for the team's championship, pinned at every pull. */
  liveryID?: number;
  note?: string;
}

export interface AiLooksFile {
  description?: string;
  teams: AiLook[];
}

/** The league's AI looks, with the path in league.json resolved against the league file. */
export function readAiLooks(cfg: LeagueConfig, leagueFile: string): AiLook[] {
  if (!cfg.aiLooks) return [];
  const file = JSON.parse(readFileSync(resolve(dirname(leagueFile), cfg.aiLooks), "utf8")) as AiLooksFile;
  for (const t of file.teams) {
    if (!Number.isInteger(t.teamID)) throw new Error(`${cfg.aiLooks}: ${t.team} needs its teamID`);
    if (t.colours && (t.colorID === undefined || t.colorID < 0 || t.colorID >= LEAGUE_COLOR_ID_START)) {
      throw new Error(`${cfg.aiLooks}: ${t.team} has colours but no colorID of MM's own (0..${LEAGUE_COLOR_ID_START - 1})`);
    }
  }
  return file.teams;
}

const key = (name: string) => name.trim().toLowerCase();

/**
 * Entries for AI teams only: members' teams are left to the members. Member teams are given by
 * name or teamID (a member may have renamed the team they took over, so pass IDs when known).
 */
export function aiOnly(looks: AiLook[], memberTeams: Iterable<string | number | null | undefined>): AiLook[] {
  const names = new Set<string>();
  const ids = new Set<number>();
  for (const t of memberTeams) {
    if (typeof t === "number") ids.add(t);
    else if (typeof t === "string") names.add(key(t));
  }
  return looks.filter((l) => !ids.has(l.teamID) && !names.has(key(l.team)));
}

/** Rows to write over MM's own in the Team Colours mod. */
export function aiColourRows(looks: AiLook[]): { colorID: number; look: TeamLook }[] {
  return looks.filter((l) => l.colours).map((l) => ({ colorID: l.colorID!, look: l.colours! }));
}

/**
 * Livery pins. `ifAvailable`: an AI team can be promoted or relegated into a championship where
 * the livery isn't valid, which then only skips the pin.
 */
export function aiLiveryChanges(looks: AiLook[]): ChangeSet["changes"] {
  return looks.filter((l) => l.liveryID !== undefined)
    .map((l) => ({ op: "setTeamLook" as const, team: l.teamID, liveryID: l.liveryID, ifAvailable: true }));
}
