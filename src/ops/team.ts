import type { Obj } from "../graph.ts";
import type { LiveryOption, TeamLookInfo } from "../league-types.ts";
import type { Save } from "../model.ts";
import type { GameCode } from "../schema.ts";
import { baseColours } from "../team-colours.ts";
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
  /** Skip the livery, instead of failing, when it isn't valid for the team's championship (AI pins). */
  ifAvailable?: boolean;
}

/** Liveries the team may use: MM's own pick, `Team.SelectNewLiveryForSeason`, draws from these. */
export function teamLiveries(save: Save, team: Obj): Obj[] {
  const champId = save.championship(team).championshipID;
  return save.g.list<Obj>(save.data.liveryManager._currentLiveriesArr)
    .filter((l) => (l.championshipID as number[]).includes(champId));
}

/**
 * FF20's car model per championship ID (MM_Data/Modding/Models/Vehicle/<name>), for the renders of
 * tools/ff20-car-renders.py. Championships without one keep the old side-texture masks.
 */
const FF20_MODELS: Record<number, string> = { 0: "F1", 1: "F2", 2: "F3", 3: "GT3", 4: "GT3", 5: "Endurance", 6: "Endurance" };

/** Mirrors livery_key in tools/ff20-car-renders.py. */
export function ff20LiveryKey(base: string, detail: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug(String(base))}--${slug(String(detail))}`;
}

/** Liveries valid for a championship, for the site's picker. */
export function liveryOptions(save: Save, champ: Obj): LiveryOption[] {
  const model = save.game === "ff20" ? FF20_MODELS[champ.championshipID as number] : undefined;
  const usedBy = new Map<number, string[]>();
  for (const t of save.teams()) if (t.name) usedBy.set(t.liveryID, [...(usedBy.get(t.liveryID) ?? []), t.name]);
  return save.g.list<Obj>(save.data.liveryManager._currentLiveriesArr)
    .filter((l) => (l.championshipID as number[]).includes(champ.championshipID))
    .map((l) => {
      const opt: LiveryOption = { id: l.id, number: l.friendlyNameInt, dlc: l.mDlcId !== 0, mask: liveryMask(l) };
      if (model) {
        const c = l.chassis as Obj;
        const key = ff20LiveryKey(c.baseLiveryTexture, c.detailLiveryTexture);
        const tag = `ff20-${model.toLowerCase()}`;
        Object.assign(opt, { mask: `${tag}-${key}.png`, model: tag, texture: `ff20-uv-${key}.png` });
        // FF20's own designs (Images/liverypack) have no number of their own.
        const pack = /^LiveryBase_(\d+)$/.exec(String(c.baseLiveryTexture));
        if (pack) opt.name = `FF20 design ${pack[1]}`;
      }
      const users = usedBy.get(l.id);
      if (users) opt.usedBy = users;
      return opt;
    });
}

/**
 * The side-view texture's file name in the livery image store: its resource path, lowercased,
 * with "/" as "-" ("GP1/Livery5/LiveryBase" -> "gp1-livery5-liverybase.png").
 * `Livery2D` and the 3D car pick the side view by projection: LiveryShader*Projection 1 = Side.
 */
export function liveryMask(livery: Obj): string {
  const c = livery.chassis as Obj;
  const side = c.baseProjection === 1 ? c.baseLiveryTexture : c.detailProjection === 1 ? c.detailLiveryTexture : c.baseLiveryTexture;
  return `${String(side).toLowerCase().replace(/\//g, "-")}.png`;
}

export function teamLook(team: Obj, game: GameCode = "ff20"): TeamLookInfo {
  return { colorID: team.colorID, liveryID: team.liveryID, colours: baseColours(team.colorID, game) };
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
    if (ok.includes(op.liveryID)) {
      team.liveryID = op.liveryID;
      out.push(`livery ${op.liveryID}`);
    } else if (op.ifAvailable) {
      out.push(`livery ${op.liveryID} skipped (not available in its championship)`);
    } else {
      throw new Error(`Livery ${op.liveryID} is not available in ${team.name}'s championship (${ok.join(", ")})`);
    }
  }
  if (!out.length) throw new Error("Give colorID and/or liveryID");
  if (team.isCreatedByPlayer) out.push("(player-created team: MM uses the header's stored colours for it)");
  return `${team.name}: ${out.join(", ")}`;
}
