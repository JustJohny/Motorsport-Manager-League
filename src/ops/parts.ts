import type { Obj } from "../graph.ts";
import { PART_TYPES, type PartType, type Save } from "../model.ts";
import { float } from "../codec/sav.ts";

export interface AddPartOp {
  op: "addPart";
  team: string | number;
  type: PartType;
  /** Part name shown in game, e.g. "E-LEAGUE1". Defaults to a generated name. */
  name?: string;
  level?: number;
  stat: number;
  performance?: number;
  maxPerformance?: number;
  reliability: number;
  maxReliability?: number;
  /** Fit to car 0 or 1 after building it. */
  fitToCar?: 0 | 1;
}

export interface RemovePartOp {
  op: "removePart";
  team: string | number;
  type: PartType;
  /** Part GUID from the extract output. */
  part: string;
}

export interface FitPartOp {
  op: "fitPart";
  team: string | number;
  type: PartType;
  part: string;
  car: 0 | 1;
}

function checkType(type: string): PartType {
  if (!(PART_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown part type ${type}`);
  return type as PartType;
}

function randomName(type: PartType): string {
  const letters = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
  return `${type[0]}-${letters}`;
}

/**
 * Build a new part by cloning an existing part of the same type from the team's inventory,
 * then overwriting its stats. The clone is detached from any car and has no components.
 */
export function addPart(save: Save, op: AddPartOp): string {
  const type = checkType(op.type);
  const team = save.team(op.team);
  const list = save.partList(team, type);
  if (!list.length) throw new Error(`${team.name} has no ${type} part to use as a template`);
  const template = save.g.deref<Obj>(list.find((p) => !save.g.deref<Obj>(p).isFitted) ?? list[0]);

  // Clone without the fitted car, which is not part of the part itself.
  const part = save.g.clone({ ...template, fittedCar: null, isFitted: false, components: [] });
  part.name = op.name ?? randomName(type);
  part.buildDate = save.now;
  part.isBanned = false;
  part.developmentVariance = float(0);
  const s = part.mStats;
  s.level = op.level ?? s.level;
  s.mStat = float(op.stat);
  s.mPerformance = float(op.performance ?? 0);
  s.maxPerformance = float(op.maxPerformance ?? op.performance ?? 0);
  s.mReliability = float(op.reliability);
  s.maxReliability = float(op.maxReliability ?? op.reliability);
  s.rulesRisk = float(0);
  s.mWeightStrippingModifier = float(1);
  if (s.partCondition) {
    s.partCondition.mCondition = float(op.reliability);
    s.partCondition.mState = 0;
  }
  list.push(part);

  let msg = `${team.name}: new ${type} ${part.name} (stat ${op.stat}, rel ${op.reliability})`;
  if (op.fitToCar !== undefined) msg += "; " + fitPart(save, { op: "fitPart", team: op.team, type, part: part.id, car: op.fitToCar });
  return msg;
}

function findPart(save: Save, team: Obj, type: PartType, guid: string): Obj {
  const p = save.parts(team, type).find((p) => p.id === guid);
  if (!p) throw new Error(`${team.name} has no ${type} part ${guid}`);
  return p;
}

export function fitPart(save: Save, op: FitPartOp): string {
  const type = checkType(op.type);
  const team = save.team(op.team);
  const part = findPart(save, team, type, op.part);
  const car = save.cars(team)[op.car];
  if (!car) throw new Error(`${team.name} has no car ${op.car}`);
  const g = save.g;
  const slot = PART_TYPES.indexOf(type);
  const current = g.rawList(car.mCurrentPart);
  const fitted = g.rawList(car.mPartsFittedToCar);

  // If the part is on the other car, take it off there first.
  if (part.isFitted && part.fittedCar && !g.same(part.fittedCar, car)) {
    const other = g.deref<Obj>(part.fittedCar);
    const otherCurrent = g.rawList(other.mCurrentPart);
    if (g.same(otherCurrent[slot], part)) otherCurrent[slot] = null;
    const otherFitted = g.rawList(other.mPartsFittedToCar);
    const i = otherFitted.findIndex((x) => g.same(x, part));
    if (i >= 0) otherFitted.splice(i, 1);
  }

  const old = current[slot] ? g.deref<Obj>(current[slot]) : null;
  if (old && old !== part) {
    old.isFitted = false;
    old.fittedCar = null;
  }
  current[slot] = g.ref(part);
  const i = old ? fitted.findIndex((x) => g.same(x, old)) : -1;
  if (i >= 0) fitted[i] = g.ref(part);
  else if (!fitted.some((x) => g.same(x, part))) fitted.push(g.ref(part));
  part.isFitted = true;
  part.fittedCar = g.ref(car);
  return `${team.name}: fitted ${part.name} to car ${op.car}${old && old !== part ? ` (replacing ${old.name})` : ""}`;
}

export function removePart(save: Save, op: RemovePartOp): string {
  const type = checkType(op.type);
  const team = save.team(op.team);
  const part = findPart(save, team, type, op.part);
  if (part.isFitted) throw new Error(`${part.name} is fitted to a car; fit another part in its place first`);
  const list = save.partList(team, type);
  list.splice(list.findIndex((p) => save.g.same(p, part) || p === part), 1);
  return `${team.name}: removed ${type} ${part.name}`;
}
