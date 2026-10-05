import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
import { nationality } from "./people.ts";

export interface RenameTeamOp {
  op: "renameTeam";
  team: string | number;
  /** Full name, e.g. "Scuderia Ferrari". */
  name: string;
  /** Shown in standings and timing screens, e.g. "Ferrari". Defaults to `name`. */
  shortName?: string;
}

/**
 * Rename a team. MM copies names from its database only when it creates a career; after that
 * `name` and `mShortName` in the save are the only copies, and everything else refers to the
 * team object.
 */
export function renameTeam(save: Save, op: RenameTeamOp): string {
  const team = save.team(op.team);
  const oldName = team.name as string;
  const clash = save.teams().find((t) => t !== team && t.name === op.name);
  if (clash) throw new Error(`Another team is already called ${op.name}`);
  team.name = op.name;
  team.mShortName = op.shortName ?? op.name;
  return `Team ${oldName} → ${op.name} (${team.mShortName})`;
}

export interface SetTeamCountryOp {
  op: "setTeamCountry";
  team: string | number;
  /** Racing licence: the team's flag. A country key already used in the save, e.g. "Austria". */
  nationality?: string;
  /** Where the factory is: the location on the HQ and team screens. Same keys. */
  hqCountry?: string;
}

/** `nationality` is a shared country object; `locationID` is that country's text ID. */
export function setTeamCountry(save: Save, op: SetTeamCountryOp): string {
  const team = save.team(op.team);
  const out: string[] = [];
  if (op.nationality) {
    team.nationality = save.g.ref(nationality(save, op.nationality));
    out.push(`nationality ${op.nationality}`);
  }
  if (op.hqCountry) {
    team.locationID = nationality(save, op.hqCountry).mCountryID;
    out.push(`HQ ${op.hqCountry}`);
  }
  if (!out.length) throw new Error("Give nationality and/or hqCountry");
  return `${team.name}: ${out.join(", ")}`;
}

export interface SetTeamLookOp {
  op: "setTeamLook";
  team: string | number;
  /** Row ID in MM's Team Colours table, or in the league's colour mod (see src/team-colours.ts). */
  colorID?: number;
  /** A livery (chassis pattern) `id` from `liveryManager`, valid for the team's championship. */
  liveryID?: number;
}

/** Liveries the team may use: MM's own pick, `Team.SelectNewLiveryForSeason`, draws from these. */
export function teamLiveries(save: Save, team: Obj): Obj[] {
  const champId = save.championship(team).championshipID;
  return save.g.list<Obj>(save.data.liveryManager._currentLiveriesArr)
    .filter((l) => (l.championshipID as number[]).includes(champId));
}

/**
 * Point a team at a colour row and a livery pattern. AI teams keep only these two IDs in the
 * save: MM reads the colours from its Team Colours table on load and paints the livery with them.
 * MM picks a new random livery for AI teams every season, so a member's choice has to be
 * applied again after each season change.
 */
export function setTeamLook(save: Save, op: SetTeamLookOp): string {
  const team = save.team(op.team);
  const out: string[] = [];
  if (op.colorID !== undefined) {
    if (!Number.isInteger(op.colorID) || op.colorID < 0) throw new Error(`Bad colorID ${op.colorID}`);
    team.colorID = op.colorID;
    out.push(`colours ${op.colorID}`);
  }
  if (op.liveryID !== undefined) {
    const ok = teamLiveries(save, team).map((l) => l.id as number);
    if (!ok.includes(op.liveryID)) throw new Error(`Livery ${op.liveryID} is not available in ${team.name}'s championship (${ok.join(", ")})`);
    team.liveryID = op.liveryID;
    out.push(`livery ${op.liveryID}`);
  }
  if (!out.length) throw new Error("Give colorID and/or liveryID");
  if (team.isCreatedByPlayer) out.push("(player-created team: MM uses the header's stored colours for it)");
  return `${team.name}: ${out.join(", ")}`;
}
