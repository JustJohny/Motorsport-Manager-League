import type { Save } from "./model.ts";
import {
  cancelDesign, cancelUnorderedDesigns, removeUnorderedParts, setFitting, setImprovement, startDesign,
  type CancelDesignOp, type CancelUnorderedDesignsOp, type RemoveUnorderedPartsOp, type SetFittingOp, type SetImprovementOp, type StartDesignOp,
} from "./ops/design.ts";
import {
  renameSupplier, setCarInvestment, setChassis, setCurrentSupplier, setSuppliers,
  type RenameSupplierOp, type SetCarInvestmentOp, type SetChassisOp, type SetCurrentSupplierOp, type SetSuppliersOp,
} from "./ops/suppliers.ts";
import { concludeVote, setNextRule, type ConcludeVoteOp, type SetNextRuleOp } from "./ops/politics.ts";
import { adjustBudget, setBudget, type AdjustBudgetOp, type SetBudgetOp } from "./ops/finance.ts";
import {
  cancelBuilding, cancelUnorderedHq, setBuilding, startBuilding,
  type CancelBuildingOp, type CancelUnorderedHqOp, type SetBuildingOp, type StartBuildingOp,
} from "./ops/hq.ts";
import { addPart, fitPart, removePart, type AddPartOp, type FitPartOp, type RemovePartOp } from "./ops/parts.ts";
import { hire, type HireOp } from "./ops/staff.ts";
import { renamePerson, type RenamePersonOp } from "./ops/people.ts";
import { renameTeam, setTeamCountry, type RenameTeamOp, type SetTeamCountryOp } from "./ops/team.ts";
import { syncTeam, type SyncTeamOp } from "./ops/sync.ts";
import { setPitCrew, type SetPitCrewOp } from "./ops/pit-crew.ts";
import { equalizeTeams, type EqualizeOp } from "./ops/equalize.ts";
import { dropSponsor, signSponsor, type DropSponsorOp, type SignSponsorOp } from "./ops/sponsors.ts";
import { renewContract, type RenewContractOp } from "./ops/contracts.ts";
import { holdPromotions, type HoldPromotionsOp } from "./ops/promotions.ts";
import { repairCircuits, type RepairCircuitsOp } from "./ops/circuits.ts";

export type Change = SetBuildingOp | StartBuildingOp | CancelBuildingOp | CancelUnorderedHqOp | SetBudgetOp | AdjustBudgetOp | AddPartOp | RemovePartOp | FitPartOp | HireOp | SyncTeamOp
  | StartDesignOp | CancelDesignOp | CancelUnorderedDesignsOp | RemoveUnorderedPartsOp | SetFittingOp | SetImprovementOp
  | ConcludeVoteOp | SetNextRuleOp | SetSuppliersOp | RenamePersonOp | RenameTeamOp | SetTeamCountryOp
  | SetCurrentSupplierOp | RenameSupplierOp | SetPitCrewOp | EqualizeOp | SignSponsorOp | DropSponsorOp | SetChassisOp | SetCarInvestmentOp | RenewContractOp
  | HoldPromotionsOp | RepairCircuitsOp;

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
    case "renamePerson": return renamePerson(save, c);
    case "renameTeam": return renameTeam(save, c);
    case "setTeamCountry": return setTeamCountry(save, c);
    case "syncTeam": return syncTeam(save, c);
    case "startDesign": return startDesign(save, c);
    case "cancelDesign": return cancelDesign(save, c);
    case "cancelUnorderedDesigns": return cancelUnorderedDesigns(save, c);
    case "removeUnorderedParts": return removeUnorderedParts(save, c);
    case "setFitting": return setFitting(save, c);
    case "setImprovement": return setImprovement(save, c);
    case "concludeVote": return concludeVote(save, c);
    case "setNextRule": return setNextRule(save, c);
    case "setSuppliers": return setSuppliers(save, c);
    case "setCurrentSupplier": return setCurrentSupplier(save, c);
    case "renameSupplier": return renameSupplier(save, c);
    case "setPitCrew": return setPitCrew(save, c);
    case "equalizeTeams": return equalizeTeams(save, c);
    case "signSponsor": return signSponsor(save, c);
    case "dropSponsor": return dropSponsor(save, c);
    case "setChassis": return setChassis(save, c);
    case "setCarInvestment": return setCarInvestment(save, c);
    case "renewContract": return renewContract(save, c);
    case "holdPromotions": return holdPromotions(save, c);
    case "repairCircuits": return repairCircuits(save, c);
    default: throw new Error(`Unknown op ${(c as { op: string }).op}`);
  }
}
