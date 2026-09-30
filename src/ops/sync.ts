import type { Obj } from "../graph.ts";
import type { PartType, Save } from "../model.ts";
import { setBudget } from "./finance.ts";
import { setBuilding } from "./hq.ts";
import { fitPart, removePart } from "./parts.ts";
import { hire } from "./staff.ts";

/**
 * The site's full view of a member team. Anything the in-game AI changed since the last
 * export is overwritten: HQ levels, which parts exist and are fitted, staff and budget.
 */
export interface SyncTeamOp {
  op: "syncTeam";
  team: string | number;
  /** Building name -> level (0 = not built). Buildings left out are untouched. */
  hq?: Record<string, number>;
  /** Per part type, the GUIDs the team should own; parts built by the AI are removed. */
  parts?: Partial<Record<PartType, string[]>>;
  /** Per part type, the part GUID fitted to car 0 and car 1. */
  fitted?: Partial<Record<PartType, [string, string]>>;
  /** slotID -> person GUID. */
  staff?: Record<string, string>;
  budget?: number;
}

export function syncTeam(save: Save, op: SyncTeamOp): string[] {
  const log: string[] = [];
  const team = save.team(op.team);

  for (const [building, level] of Object.entries(op.hq ?? {})) {
    log.push(setBuilding(save, { op: "setBuilding", team: op.team, building, level }));
  }

  for (const [type, [car0, car1]] of Object.entries(op.fitted ?? {}) as [PartType, [string, string]][]) {
    log.push(fitPart(save, { op: "fitPart", team: op.team, type, part: car0, car: 0 }));
    log.push(fitPart(save, { op: "fitPart", team: op.team, type, part: car1, car: 1 }));
  }

  for (const [type, keep] of Object.entries(op.parts ?? {}) as [PartType, string[]][]) {
    for (const p of save.parts(team, type)) {
      if (keep.includes(p.id)) continue;
      if (p.isFitted) {
        log.push(`WARNING ${team.name}: ${p.name} is not on the site but is fitted; give 'fitted' to replace it`);
        continue;
      }
      log.push(removePart(save, { op: "removePart", team: op.team, type, part: p.id }));
    }
    const missing = keep.filter((id) => !save.parts(team, type).some((p) => p.id === id));
    if (missing.length) log.push(`WARNING ${team.name}: ${type} parts not in save: ${missing.join(", ")}`);
  }

  for (const [slotID, person] of Object.entries(op.staff ?? {})) {
    const slot = save.slots(team).find((s) => s.slotID === Number(slotID));
    const current = slot?.personHired ? save.g.deref<Obj>(slot.personHired) : null;
    if (current?.id === person) continue;
    log.push(hire(save, { op: "hire", team: op.team, person, slotID: Number(slotID), replacing: current?.id }));
  }

  if (op.budget !== undefined) log.push(setBudget(save, { op: "setBudget", team: op.team, amount: op.budget, reason: "League budget sync" }));
  return log;
}
