import { readFileSync } from "node:fs";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";

/**
 * Circuit fields that saves from an older format lack. MM sets them only when it creates a career
 * (CircuitManager.LoadCircuitsFromDatabase) and later loads circuits from the save, so such a save
 * has "" start times, and practice crashes in PreSessionState.SetGameTimeToSession (Substring on
 * ""). With 0/0 overtake corners the AI never sets up an overtake. The other new fields
 * (timeCostMultiplier, overtakeDifficulty, fuelFillTimeCostMultiplier, pitLaneSpeedAdjuster) are
 * set again by PreSessionState.OnEnter at every session.
 */
export const CIRCUIT_FIELDS = [
  "ersPracticeStart", "ersQualifyingStart", "ersRaceStart",
  "apsPracticeStart", "apsQualifyingStart", "apsRaceStart",
  "wmcPracticeStart", "wmcQualifyingStart", "wmcRaceStart",
  "minOvertakeCorners", "maxOvertakeCorners",
] as const;
const START_FIELDS = CIRCUIT_FIELDS.slice(0, 9);
export type CircuitData = Record<(typeof CIRCUIT_FIELDS)[number], string | number>;

export interface RepairCircuitsOp {
  op: "repairCircuits";
}

/** MM's database values by circuitID, from tools/gen-circuits.ts. */
export function circuitTable(): Record<string, CircuitData> {
  return JSON.parse(readFileSync(new URL("../../schema/circuits-1.53.json", import.meta.url), "utf8"));
}

/** "HHmm", as SetGameTimeToSession parses it. */
const isTime = (v: unknown) => typeof v === "string" && /^\d{4}$/.test(v);

/** Circuits whose session start times are missing or unparseable. */
export function brokenCircuits(save: Save): Obj[] {
  return (save.data.circuitManager.mCircuits as unknown[]).map((r) => save.g.deref<Obj>(r))
    .filter((c) => START_FIELDS.some((k) => !isTime(c[k])));
}

/** Put MM's database values back on every broken circuit. Healthy circuits are left alone. */
export function repairCircuits(save: Save, _op: RepairCircuitsOp): string {
  const table = circuitTable();
  const broken = brokenCircuits(save);
  for (const c of broken) {
    const row = table[c.circuitID];
    if (!row) throw new Error(`No database values for circuit ${c.circuitID} (${c.locationName})`);
    for (const k of CIRCUIT_FIELDS) c[k] = row[k];
  }
  return broken.length ? `Restored session start times and overtake corners on ${broken.length} circuits` : "All circuits already have start times";
}
