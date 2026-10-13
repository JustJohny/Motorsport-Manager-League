import { randomUUID } from "node:crypto";
import { float, num } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import { PART_TYPES, type PartType, type Save } from "../model.ts";
import { customerStat, isCustomerPart } from "../part-market.ts";
import { carPartDesign } from "./design.ts";
import { fitPart } from "./parts.ts";

export interface CopyPartOp {
  op: "copyPart";
  /** The seller, and the GUID of the part copied. */
  from: string | number;
  part: string;
  type: PartType;
  /** The buyer. */
  to: string | number;
  /** The copy's GUID (starts with CUSTOMER_GUID_PREFIX; chosen by the site at purchase). */
  guid: string;
  /** Fit the copy to the buyer's car 0 or 1. */
  fitToCar?: 0 | 1;
}

export interface RemoveCustomerPartsOp {
  op: "removeCustomerParts";
  /** Remove every customer copy now, whatever the date. */
  force?: boolean;
}

const ENGLISH: Record<string, string> = { FrontWing: "Front Wing", RearWing: "Rear Wing" };

/** The series' floor stat for a part type (rules.partStatSeasonMinValue). */
export function partFloor(save: Save, champ: Obj, type: PartType): number {
  const rules = save.g.deref<Obj>(champ.rules);
  const e = (rules.partStatSeasonMinValue as { Key: number; Value: unknown }[] | undefined)?.find((x) => x.Key === PART_TYPES.indexOf(type));
  return e ? num(e.Value) : 0;
}

/** What a new part of the team's own may improve to (CarPartDesign.SetBaseStats: the chassis' improvability). */
function maxPerformanceFor(save: Save, team: Obj): number {
  const chassis = save.g.deref<Obj>(save.cars(team)[0]?.chassisStats);
  return num(chassis?.mImprovability ?? 0) * (save.game === "ff20" ? 2 : 1);
}

/**
 * Deliver a customer copy: a new part in the buyer's inventory with 90 % of the seller part's gain
 * over the floor, its reliability and its components (so its grey-area risk too). The seller
 * keeps the original. Money moves in separate adjustBudget changes.
 */
export function copyPart(save: Save, op: CopyPartOp): string {
  const g = save.g;
  const seller = save.team(op.from);
  const buyer = save.team(op.to);
  if (seller === buyer) throw new Error(`${seller.name} can't buy its own part`);
  if (!isCustomerPart(op.guid)) throw new Error(`${op.guid} isn't a customer part GUID`);
  if (save.parts(buyer, op.type).some((p) => p.id === op.guid)) return `${buyer.name}: customer ${op.type} ${op.guid} already delivered`;
  const source = save.parts(seller, op.type).find((p) => p.id === op.part);
  if (!source) throw new Error(`${seller.name} has no ${op.type} part ${op.part}`);
  if (source.isBanned) throw new Error(`${seller.name}'s ${source.name} is banned`);
  if (isCustomerPart(source.id)) throw new Error(`${source.name} is itself a customer part`);

  const copy = g.clone({ ...source, fittedCar: null, isFitted: false, components: [] });
  copy.id = op.guid;
  copy.components = g.list<Obj>(source.components ?? []).filter(Boolean).map((c) => g.ref(c));
  copy.buildDate = save.now;
  copy.isBanned = false;
  const from = source.mStats, s = copy.mStats;
  const floor = partFloor(save, save.championship(buyer), op.type);
  s.mStat = float(customerStat(num(from.mStat) + num(from.mPerformance), floor));
  s.mPerformance = float(0);
  s.maxPerformance = float(maxPerformanceFor(save, buyer));
  s.mWeightStrippingModifier = float(1);
  if (Array.isArray(s.mWeightStrippingReliabilityLost)) s.mWeightStrippingReliabilityLost = s.mWeightStrippingReliabilityLost.map(() => float(0));
  if (s.partCondition) {
    s.partCondition.mCondition = float(num(from.mReliability));
    s.partCondition.mState = 0;
  }
  save.partList(buyer, op.type).push(copy);
  g.rawList(save.data.entityManager.mEntities).push(g.ref(copy));

  let msg = `${buyer.name}: customer ${ENGLISH[op.type] ?? op.type} ${copy.name} from ${seller.name} (stat ${num(s.mStat)}, reliability ${Math.round(num(s.mReliability) * 100)} %)`;
  if (op.fitToCar !== undefined) msg += "; " + fitPart(save, { op: "fitPart", team: buyer.name, type: op.type, part: copy.id, car: op.fitToCar });
  return msg;
}

/** The season is over for a team's championship (or MM has moved past it). */
function seasonOver(save: Save, champ: Obj): boolean {
  if (String(save.now) >= String(champ.currentSeasonEndDate)) return true;
  const events = save.g.list<Obj>(champ.calendar ?? []).filter(Boolean);
  return events.length > 0 && events.every((e) => e.mHasEventEnded);
}

/** Built before this season started (a year before this pre-season's end). */
function fromEarlierSeason(champ: Obj, part: Obj): boolean {
  const end = String(champ.currentPreSeasonEndDate);
  return String(part.buildDate) < `${Number(end.slice(0, 4)) - 1}${end.slice(4)}`;
}

const statOf = (p: Obj) => num(p.mStats.mStat) + num(p.mStats.mPerformance);

/**
 * Customer copies are for one season: once its last race is run they go, so MM never carries
 * one into next season or counts it for the team's own designs. A fitted copy is replaced by the
 * team's best own spare first. With no own part of that type left, the copy turns into a basic
 * own part at the team's season-start stat (no components, no risk).
 */
export function removeCustomerParts(save: Save, op: RemoveCustomerPartsOp): string[] {
  const g = save.g;
  const log: string[] = [];
  for (const team of save.teams()) {
    const champ = save.championship(team);
    if (!champ) continue;
    const over = op.force || seasonOver(save, champ);
    for (const type of PART_TYPES) {
      let parts: Obj[];
      try { parts = save.parts(team, type); } catch { continue; }
      const leaving = parts.filter((p) => isCustomerPart(String(p.id)) && (over || fromEarlierSeason(champ, p)));
      for (const part of leaving) {
        if (part.isFitted) {
          const car = save.cars(team).findIndex((c) => g.same(c, part.fittedCar) || c === g.deref(part.fittedCar));
          const spare = save.parts(team, type)
            .filter((p) => !p.isFitted && !p.isBanned && !isCustomerPart(String(p.id)))
            .sort((a, b) => statOf(b) - statOf(a))[0];
          if (!spare) {
            const start = (carPartDesign(save, team).seasonPartStartingStat as Obj[]).find((x) => x.Key === PART_TYPES.indexOf(type));
            part.id = randomUUID();
            part.components = [];
            part.mStats.mStat = float(start ? num(start.Value) : num(part.mStats.mStat));
            part.mStats.mPerformance = float(0);
            part.mStats.rulesRisk = float(0);
            log.push(`${team.name}: customer ${type} ${part.name} on car ${car} has no own part to replace it; now a basic own part (stat ${num(part.mStats.mStat)})`);
            continue;
          }
          log.push(fitPart(save, { op: "fitPart", team: team.name, type, part: spare.id, car: car as 0 | 1 }));
        }
        const list = save.partList(team, type);
        list.splice(list.findIndex((p) => g.deref(p) === part), 1);
        const entities = g.rawList(save.data.entityManager.mEntities);
        const at = entities.findIndex((e) => g.deref(e) === part);
        if (at >= 0) entities.splice(at, 1);
        // Off the improvement lists too, so they hold no dangling part.
        const pi = g.deref<Obj>(g.deref<Obj>(team.carManager).partImprovement);
        for (const e of (pi?.partsToImprove ?? []) as Obj[]) e.Value = g.list<Obj>(e.Value).filter((p) => p !== part).map((p) => g.ref(p));
        log.push(`${team.name}: customer ${type} ${part.name} returned (season over)`);
      }
    }
  }
  return log.length ? log : ["No customer parts due back"];
}
