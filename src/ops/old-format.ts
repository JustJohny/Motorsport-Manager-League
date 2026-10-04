import { readFileSync } from "node:fs";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
import { repairCircuits } from "./circuits.ts";

/**
 * Championship fields that MM sets only when it creates a career (ChampionshipManager.OnStart, from
 * its database) and that a career from an older save format has at C# defaults: no banned
 * locations, 6-20 races and, for the GT series, no promotions. Politics uses the first three when
 * it votes on next season's calendar (PoliticalImpactChangeTrack).
 */
export interface ChampionshipData {
  allowPromotions: boolean;
  minRacesPerSeason: number;
  maxRacesPerSeason: number;
  bannedLocations: number[];
}

/** MM's default AI driver level (DefaultPreferences); it scales the player's part component boosts. */
export const DEFAULT_AI_DRIVER_LEVEL = 8;

export interface RepairOldFormatOp {
  op: "repairOldFormat";
}

/** MM's database values by championshipID, from tools/gen-championships.ts. */
export function championshipTable(): Record<string, ChampionshipData> {
  return JSON.parse(readFileSync(new URL("../../schema/championships-1.53.json", import.meta.url), "utf8"));
}

/** Championships without banned locations: every championship in MM's 1.53 database has some. */
export function brokenChampionships(save: Save): Obj[] {
  return save.g.list<Obj>(save.data.championshipManager.mEntities)
    .filter((c) => save.g.list(c.bannedLocations ?? []).length === 0);
}

/**
 * Everything an older save format leaves empty that MM never fills again on load: circuit start
 * times and overtake corners (repairCircuits), the championships' database values, and the AI driver
 * level preference, which the save applies to the game's settings on load (missing reads as 0).
 */
export function repairOldFormat(save: Save, _op: RepairOldFormatOp): string[] {
  const g = save.g;
  const out = [repairCircuits(save, { op: "repairCircuits" })];

  const table = championshipTable();
  const broken = brokenChampionships(save);
  for (const c of broken) {
    const row = table[c.championshipID as number];
    if (!row) throw new Error(`No database values for championship ${c.championshipID}`);
    c.allowPromotions = row.allowPromotions;
    c.minRacesPerSeason = row.minRacesPerSeason;
    c.maxRacesPerSeason = row.maxRacesPerSeason;
    const banned = g.deref<Obj | unknown[] | null>(c.bannedLocations);
    if (banned && !Array.isArray(banned)) g.rawList(c.bannedLocations).splice(0, Infinity, ...row.bannedLocations);
    else c.bannedLocations = [...row.bannedLocations];
  }
  out.push(broken.length ? `Restored banned locations, race counts and promotions on ${broken.length} championships` : "All championships already have their database values");

  const prefs = save.data.mSerializedPreferences as Obj | null;
  if (prefs && !prefs.mAIDriverLevel) {
    prefs.mAIDriverLevel = DEFAULT_AI_DRIVER_LEVEL;
    out.push(`Set the AI driver level preference to ${DEFAULT_AI_DRIVER_LEVEL} (MM's default)`);
  }
  return out;
}
