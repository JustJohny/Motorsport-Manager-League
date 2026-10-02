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
