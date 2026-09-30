import type { Obj } from "../graph.ts";
import { BUILDING_STATES, NULL_DATE, type Save } from "../model.ts";
import { float } from "../codec/sav.ts";

export interface SetBuildingOp {
  op: "setBuilding";
  team: string | number;
  /** Building name ("Wind Tunnel") or its info.type number. */
  building: string | number;
  /** 0 = not built, otherwise the in-game level (1..maxLevel). */
  level: number;
}

export function findBuilding(save: Save, team: Obj, key: string | number): Obj {
  const b = save.buildings(team).find((b) => {
    const info = save.buildingInfo(b);
    return info.type === key || info.name === key;
  });
  if (!b) throw new Error(`Team ${team.name} has no building ${JSON.stringify(key)}`);
  return b;
}

/** Put a building at a finished level, cancelling any construction or upgrade in progress. */
export function setBuilding(save: Save, op: SetBuildingOp): string {
  const team = save.team(op.team);
  const b = findBuilding(save, team, op.building);
  const info = save.buildingInfo(b);
  const max = info.maxLevel + 1;
  if (op.level < 0 || op.level > max) throw new Error(`${info.name}: level must be 0..${max}`);

  const built = op.level > 0;
  b.state = BUILDING_STATES.indexOf(built ? "Constructed" : "NotBuilt");
  b.currentLevel = built ? op.level - 1 : 0;
  b.normalizedProgress = float(0);
  b.mDateProgressStarted = NULL_DATE;
  b.mDateProgressEnd = NULL_DATE;
  b.mStaffNumber = built ? info.workerCapacity?.[b.currentLevel] ?? b.mStaffNumber : 0;
  let msg = `${team.name}: ${info.name} -> level ${op.level}`;
  // The game gates buildings behind others; setting a level directly bypasses that, so flag it.
  for (const dep of built ? info.dependencies ?? [] : []) {
    const req = findBuilding(save, team, dep.buildingType);
    const reqLevel = req.state === 0 ? 0 : req.currentLevel + 1;
    if (reqLevel < dep.requiredLevel) {
      msg += ` (WARNING: needs ${save.buildingInfo(req).name} level ${dep.requiredLevel}, has ${reqLevel})`;
    }
  }
  return msg;
}
