import type { Save } from "./model.ts";
import {
  cancelDesign, cancelUnorderedDesigns, setImprovement, startDesign,
  type CancelDesignOp, type CancelUnorderedDesignsOp, type SetImprovementOp, type StartDesignOp,
} from "./ops/design.ts";
import { adjustBudget, setBudget, type AdjustBudgetOp, type SetBudgetOp } from "./ops/finance.ts";
import {
  cancelBuilding, cancelUnorderedHq, setBuilding, startBuilding,
  type CancelBuildingOp, type CancelUnorderedHqOp, type SetBuildingOp, type StartBuildingOp,
} from "./ops/hq.ts";
import { addPart, fitPart, removePart, type AddPartOp, type FitPartOp, type RemovePartOp } from "./ops/parts.ts";
import { hire, type HireOp } from "./ops/staff.ts";
import { syncTeam, type SyncTeamOp } from "./ops/sync.ts";

export type Change = SetBuildingOp | StartBuildingOp | CancelBuildingOp | CancelUnorderedHqOp | SetBudgetOp | AdjustBudgetOp | AddPartOp | RemovePartOp | FitPartOp | HireOp | SyncTeamOp
  | StartDesignOp | CancelDesignOp | CancelUnorderedDesignsOp | SetImprovementOp;

export interface ChangeSet {
  /** Optional note, e.g. "Before round 6 - Munich". */
  description?: string;
  changes: Change[];
}

/** Apply every change in order. Throws on the first invalid change, before anything is written. */
export function applyChanges(save: Save, set: ChangeSet): string[] {
  const log: string[] = [];
  set.changes.forEach((c, i) => {
    try {
      const out = run(save, c);
      log.push(...(Array.isArray(out) ? out : [out]));
    } catch (e) {
      throw new Error(`Change #${i + 1} (${c.op}): ${(e as Error).message}`);
    }
  });
  return log;
}

function run(save: Save, c: Change): string | string[] {
  switch (c.op) {
    case "setBuilding": return setBuilding(save, c);
    case "startBuilding": return startBuilding(save, c);
    case "cancelBuilding": return cancelBuilding(save, c);
    case "cancelUnorderedHq": return cancelUnorderedHq(save, c);
    case "setBudget": return setBudget(save, c);
    case "adjustBudget": return adjustBudget(save, c);
    case "addPart": return addPart(save, c);
    case "removePart": return removePart(save, c);
    case "fitPart": return fitPart(save, c);
    case "hire": return hire(save, c);
    case "syncTeam": return syncTeam(save, c);
    case "startDesign": return startDesign(save, c);
    case "cancelDesign": return cancelDesign(save, c);
    case "cancelUnorderedDesigns": return cancelUnorderedDesigns(save, c);
    case "setImprovement": return setImprovement(save, c);
    default: throw new Error(`Unknown op ${(c as { op: string }).op}`);
  }
}
