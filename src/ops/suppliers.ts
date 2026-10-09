import { chassisStats, clampSlider, sliderRange } from "../chassis.ts";
import { float, num } from "../codec/sav.ts";
import { gameScale } from "../game-rules.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
import { isSpecPart } from "./design.ts";
import { adjustBudget } from "./finance.ts";

/** Supplier.SupplierType, and the chassis field that holds each. */
export const SUPPLIER_TYPES = ["Engine", "Brakes", "Fuel", "Materials", "Battery", "ERSAdvanced"] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];
const CHASSIS_FIELD: Record<SupplierType, string> = {
  Engine: "supplierEngine", Brakes: "supplierBrakes", Fuel: "supplierFuel", Materials: "supplierMaterials",
  Battery: "supplierBattery", ERSAdvanced: "supplierERSAdvanced",
};
/** CarChassisStats.Stats → field. */
const CHASSIS_STAT = ["mTyreWear", "mTyreHeating", "mFuelEfficiency", "mImprovability", "mStartingCharge", "mHarvestEfficiency"];
const NEXT_YEAR_STATE = { Designing: 0, WaitingForDesign: 1, Complete: 2 } as const;

export interface SupplierOption {
  id: number;
  type: SupplierType;
  name: string;
  tier: number;
  /** MM's price for this team (Supplier.GetPrice, team discounts included). */
  price: number;
  /** CarChassisStats.Stats index → value. */
  stats: Record<number, number>;
  engineLevel?: [number, number];
  /** Engines: the level MM adds to engine parts when a car with it is built. */
  level?: number;
  /** Supplier.CarAspect (0 rear package, 1 nose height) → how far it narrows MM's design sliders from each end. */
  minBound?: Record<number, number>;
  maxBound?: Record<number, number>;
}

/** A C# Dictionary as FullSerializer writes it: a [{Key, Value}] list, or an object (empty or string keys). */
function dictEntries(d: unknown): [number, number][] {
  if (Array.isArray(d)) return d.map((e: Obj) => [Number(e.Key), num(e.Value)]);
  if (d && typeof d === "object") return Object.entries(d).filter(([k]) => !k.startsWith("$")).map(([k, v]) => [Number(k), num(v as never)]);
  return [];
}
const list = (l: unknown): number[] => (Array.isArray(l) ? l.map(Number) : []);

/** Supplier.SupplierType.Battery. */
const BATTERY = SUPPLIER_TYPES.indexOf("Battery");
/** GameStatsConstants.hybridModeCost (FF20). */
const HYBRID_MODE_COST = 1_000_000;

/**
 * Supplier.GetPrice: base (+ engine level modifier x multiplier x scalar), minus the team's
 * discount. FF20 also prices batteries by their harvest efficiency (+ the hybrid mode cost when
 * the championship runs it). Rebirth adds temporary discounts.
 */
function price(save: Save, s: Obj, team: Obj): number {
  let p = Number(s.mBasePrice);
  if (s.supplierType === 0) p += Math.round(Number(s.mRandomEngineLevelModifier ?? 0) * num(s.mPriceMultiplier) * num(s.mScalar));
  else if (s.supplierType === BATTERY && save.game === "ff20") {
    p += Math.round(num(s.mRandomHarvestEfficiencyModifier ?? 0) * num(s.mPriceMultiplier) * num(s.mScalar));
    if (save.g.deref<Obj>(save.championship(team).rules)?.isHybridModeActive) p += HYBRID_MODE_COST;
    p = Math.round(Math.trunc(p / 1000)) * 1000;
  }
  const d = [...dictEntries(s.teamDiscounts), ...dictEntries(s.temporaryDiscounts)].find(([k]) => k === team.teamID)?.[1] ?? 0;
  return d > 0 ? p - Math.round(p * (d / 100)) : p;
}

/** Supplier.CanTeamBuyThis (Rebirth adds temporary bans and exceptions; absent in FF20). */
function canBuy(s: Obj, team: Obj): boolean {
  const no = [...list(s.mTeamsThatCannotBuy), ...list(s.mTemporaryTeamsCannotBuy)];
  return !no.includes(team.teamID) || list(s.mTemporaryTeamCanBuy).includes(team.teamID);
}

function toOption(save: Save, s: Obj, team: Obj): SupplierOption {
  return {
    id: s.id, type: SUPPLIER_TYPES[s.supplierType], name: s.name, tier: s.mTier, price: price(save, s, team),
    stats: Object.fromEntries(dictEntries(s.supplierStats)),
    minBound: Object.fromEntries(dictEntries(s.carAspectMinBoundary)),
    maxBound: Object.fromEntries(dictEntries(s.carAspectMaxBoundary)),
    ...(s.supplierType === 0 ? { engineLevel: [s.minEngineLevelModifier, s.maxEngineLevelModifier] as [number, number], level: engineLevel(s) } : {}),
  };
}

const LIST_NAME: Record<SupplierType, string> = {
  Engine: "engineSuppliers", Brakes: "brakesSuppliers", Fuel: "fuelSuppliers", Materials: "materialsSuppliers",
  Battery: "batterySuppliers", ERSAdvanced: "ersAdvancedSuppliers",
};

/** A C# Dictionary as FullSerializer may write it: [{Key, Value}] or an object keyed by name or number. */
function dictValues(d: unknown): [string, unknown][] {
  if (Array.isArray(d)) return d.map((e: Obj) => [String(e.Key), e.Value]);
  if (d && typeof d === "object") return Object.entries(d).filter(([k]) => !k.startsWith("$"));
  return [];
}

/**
 * The deals MM drew for the championship's next season (SupplierManager.championshipSuppliers,
 * filled by DetermineNewSeasonSuppliers at Championship.OnChampionshipPromotionsEnd). Seen in the
 * ERS saves: empty after the final race and at season end, filled on the first day of pre-season
 * (13 Dec), the day the AI picks from it; ERS 2017 had 1 engine, 4 brakes, 3 fuel, 4 materials.
 */
function drawnSuppliers(save: Save, champ: Obj, type: SupplierType): Obj[] {
  const byChamp = dictValues(save.data.supplierManager.championshipSuppliers)
    .find(([k]) => Number(k) === champ.championshipID)?.[1];
  const idx = SUPPLIER_TYPES.indexOf(type);
  const deals = dictValues(byChamp).find(([k]) => k === type || Number(k) === idx)?.[1];
  return save.g.list<Obj>(Array.isArray(deals) ? deals : []);
}

/**
 * What a team may buy for next year's car, as MM's car design screen offers it
 * (SupplierManager.GetSuppliersForTeam): the deals MM drew for the championship that the team can
 * buy, at the team's price. Empty until MM draws them when pre-season starts.
 */
export function supplierOptions(save: Save, team: Obj): Partial<Record<SupplierType, SupplierOption[]>> {
  const champ = save.championship(team);
  const out: Partial<Record<SupplierType, SupplierOption[]>> = {};
  for (const type of SUPPLIER_TYPES) {
    // FF20 (like vanilla MM) has no draw: GetSuppliersForTeam offers every supplier of the type
    // whose tier is championshipID + 1 and that the team may buy.
    const pool = save.game === "ff20"
      ? save.g.list<Obj>(save.data.supplierManager[LIST_NAME[type]]).filter((s) => s.mTier === champ.championshipID + 1)
      : drawnSuppliers(save, champ, type);
    const list = pool.filter((s) => canBuy(s, team)).map((s) => toOption(save, s, team));
    if (list.length) out[type] = list;
  }
  return out;
}

/** Whether every race of the season is done (MM draws next season's suppliers after the final one). */
export function seasonOver(save: Save, team: Obj): boolean {
  return save.g.list<Obj>(save.championship(team).calendar).every((e) => e.mHasEventEnded);
}

/** The suppliers on the team's current car. */
export function currentSuppliers(save: Save, team: Obj): Partial<Record<SupplierType, SupplierOption>> {
  const cs = save.g.deref<Obj>(save.cars(team)[0]?.chassisStats);
  const out: Partial<Record<SupplierType, SupplierOption>> = {};
  for (const t of SUPPLIER_TYPES) {
    const s = cs?.[CHASSIS_FIELD[t]] ? save.g.deref<Obj>(cs[CHASSIS_FIELD[t]]) : null;
    if (s && s.name) out[t] = toOption(save, s, team);
  }
  return out;
}

/** The suppliers MM's AI put on next year's pending chassis (while it designs the car). */
export function pendingSuppliers(save: Save, team: Obj): Partial<Record<SupplierType, SupplierOption>> {
  const ny = save.g.deref<Obj>(save.g.deref<Obj>(team.carManager).nextYearCarDesign);
  const cs = ny?.mChassisStats ? save.g.deref<Obj>(ny.mChassisStats) : null;
  const out: Partial<Record<SupplierType, SupplierOption>> = {};
  for (const t of SUPPLIER_TYPES) {
    const s = cs?.[CHASSIS_FIELD[t]] ? save.g.deref<Obj>(cs[CHASSIS_FIELD[t]]) : null;
    if (s && s.name) out[t] = toOption(save, s, team);
  }
  return out;
}

/** State of next year's car design (MM's AI starts it when pre-season starts). */
export function nextYearDesignState(save: Save, team: Obj): "waiting" | "designing" | "complete" {
  const ny = save.g.deref<Obj>(save.g.deref<Obj>(team.carManager).nextYearCarDesign);
  return ny.state === NEXT_YEAR_STATE.Designing ? "designing" : ny.state === NEXT_YEAR_STATE.Complete ? "complete" : "waiting";
}

/**
 * The season next year's car is for. Pre-season straddles New Year (ERS 2016: 13 Dec to 5 Mar), so
 * it's the year pre-season ends, not the game date's year.
 */
export function nextCarSeason(save: Save, team: Obj): number {
  return Number(String(save.championship(team).currentPreSeasonEndDate).slice(0, 4));
}

function findSupplier(save: Save, type: SupplierType, id: number): Obj {
  const s = save.g.list<Obj>(save.data.supplierManager[LIST_NAME[type]]).find((x) => x.id === id);
  if (!s) throw new Error(`No ${type} supplier ${id}`);
  return s;
}

export interface SetSuppliersOp {
  op: "setSuppliers";
  team: string | number;
  /** Supplier id per type. */
  suppliers: Partial<Record<SupplierType, number>>;
}

/**
 * Put a member's chosen suppliers on next year's car, replacing MM's AI picks: the pending
 * chassis gets the suppliers (CarDesignScreen.OnStartDesign), its stats are rebuilt from them
 * (ApplySupplierStats, floored at 0) keeping what the AI added on top (ChooseSuppliers2 gives 1-2
 * random stats +4), the engine level modifier follows the engine, and the AI's payments are
 * swapped for the chosen suppliers' prices.
 */
export function setSuppliers(save: Save, op: SetSuppliersOp): string[] {
  const g = save.g;
  const team = save.team(op.team);
  const ny = g.deref<Obj>(g.deref<Obj>(team.carManager).nextYearCarDesign);
  if (ny.state !== NEXT_YEAR_STATE.Designing || !ny.mChassisStats) {
    throw new Error(`${team.name}: next year's car isn't being designed (MM starts it when pre-season starts)`);
  }
  const cs = g.deref<Obj>(ny.mChassisStats);
  const supplied = () => SUPPLIER_TYPES.flatMap((t) => (cs[CHASSIS_FIELD[t]] ? [toOption(save, g.deref<Obj>(cs[CHASSIS_FIELD[t]]), team)] : []));
  const max = gameScale(save.game).chassisStatMax;
  const before = chassisStats(supplied(), 0.5, 0.5, max);
  const was = Object.fromEntries(Object.entries(CHASSIS_STAT_FIELD).map(([k, f]) => [k, num(cs[f])])) as Record<keyof typeof before, number>;
  const log: string[] = [];
  for (const [type, id] of Object.entries(op.suppliers) as [SupplierType, number][]) {
    const chosen = findSupplier(save, type, id);
    if (!canBuy(chosen, team)) throw new Error(`${team.name} can't buy ${chosen.name}`);
    const old = cs[CHASSIS_FIELD[type]] ? g.deref<Obj>(cs[CHASSIS_FIELD[type]]) : null;
    if (old === chosen) continue;
    putSupplier(save, cs, type, chosen);
    if (type === "Engine") ny.mEngineModifier = chosen.mRandomEngineLevelModifier ?? 0;
    const refund = old ? price(save, old, team) : 0;
    const cost = price(save, chosen, team);
    log.push(`${team.name}: next year's ${type.toLowerCase()} ${old?.name ?? "none"} → ${chosen.name}`);
    if (refund) log.push(adjustBudget(save, { op: "adjustBudget", team: team.name, delta: refund, reason: `Refund: ${old!.name} (${type.toLowerCase()} chosen on the league site instead)` }));
    log.push(adjustBudget(save, { op: "adjustBudget", team: team.name, delta: -cost, reason: `${chosen.name} ${type.toLowerCase()} supply` }));
  }
  if (log.length) {
    // putSupplier shifted the stats; MM floors each at 0 after every supplier, so rebuild the four
    // chassis stats (a plain shift can go negative).
    const after = chassisStats(supplied(), 0.5, 0.5, max);
    for (const key of Object.keys(after) as (keyof typeof after)[]) {
      const field = CHASSIS_STAT_FIELD[key];
      cs[field] = float(Math.min(max, Math.max(0, after[key] + was[key] - before[key])));
    }
  }
  return log.length ? log : [`${team.name}: suppliers unchanged`];
}

const CHASSIS_STAT_FIELD = { tyreWear: "mTyreWear", tyreHeating: "mTyreHeating", fuelEfficiency: "mFuelEfficiency", improvability: "mImprovability" } as const;

/** Put a supplier on a chassis, shifting its stats by the difference from the old one (CarChassisStats.ApplySupplierStats). */
function putSupplier(save: Save, cs: Obj, type: SupplierType, chosen: Obj): void {
  const old = cs[CHASSIS_FIELD[type]] ? save.g.deref<Obj>(cs[CHASSIS_FIELD[type]]) : null;
  const stats = (s: Obj | null) => new Map<number, number>(dictEntries(s?.supplierStats));
  const before = stats(old), after = stats(chosen);
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const field = CHASSIS_STAT[k];
    if (field && field in cs) cs[field] = float(num(cs[field]) + (after.get(k) ?? 0) - (before.get(k) ?? 0));
  }
  cs[CHASSIS_FIELD[type]] = save.g.ref(chosen);
}

export interface SetCurrentSupplierOp {
  op: "setCurrentSupplier";
  team: string | number;
  type: SupplierType;
  /** Supplier id, e.g. 0–4 for the F1 engines. */
  id: number;
}

/**
 * Swap a supplier on this season's cars (the league's pre-season pick). The four chassis stats are
 * rebuilt with MM's formula (floored at 0 after each supplier), keeping whatever the car had on
 * top of its suppliers. A new engine also moves every engine part by the difference in the
 * suppliers' engine level, which MM otherwise adds only when next year's car is built
 * (NextYearCarDesign.DesignCompleted); not with spec engines. No money moves.
 */
export function setCurrentSupplier(save: Save, op: SetCurrentSupplierOp): string[] {
  const g = save.g;
  const team = save.team(op.team);
  const chosen = findSupplier(save, op.type, op.id);
  if (!canBuy(chosen, team)) throw new Error(`${team.name} can't buy ${chosen.name}`);
  const max = gameScale(save.game).chassisStatMax;
  const log: string[] = [];
  let oldEngine: Obj | null = null;
  for (const car of save.cars(team)) {
    const cs = g.deref<Obj>(car.chassisStats);
    const old = cs[CHASSIS_FIELD[op.type]] ? g.deref<Obj>(cs[CHASSIS_FIELD[op.type]]) : null;
    if (old === chosen) continue;
    if (op.type === "Engine") oldEngine = old;
    const supplied = () => SUPPLIER_TYPES.flatMap((t) => (cs[CHASSIS_FIELD[t]] ? [toOption(save, g.deref<Obj>(cs[CHASSIS_FIELD[t]]), team)] : []));
    const before = chassisStats(supplied(), 0.5, 0.5, max);
    const was = Object.fromEntries(Object.entries(CHASSIS_STAT_FIELD).map(([k, f]) => [k, num(cs[f])])) as Record<keyof typeof before, number>;
    putSupplier(save, cs, op.type, chosen);
    const after = chassisStats(supplied(), 0.5, 0.5, max);
    for (const key of Object.keys(after) as (keyof typeof after)[]) {
      cs[CHASSIS_STAT_FIELD[key]] = float(Math.min(max, Math.max(0, after[key] + was[key] - before[key])));
    }
    if (!log.length) log.push(`${team.name}: ${op.type.toLowerCase()} ${old?.name ?? "none"} → ${chosen.name}`);
  }
  if (!log.length) return [`${team.name}: already on ${chosen.name} ${op.type.toLowerCase()}`];
  if (op.type === "Engine" && !isSpecPart(save, team, "Engine")) {
    const shift = engineLevel(chosen) - (oldEngine ? engineLevel(oldEngine) : 0);
    if (shift) {
      for (const part of save.parts(team, "Engine")) part.mStats.mStat = float(num(part.mStats.mStat) + shift);
      log.push(`${team.name}: engine parts ${shift > 0 ? "+" : ""}${shift} (engine level ${oldEngine ? engineLevel(oldEngine) : 0} → ${engineLevel(chosen)})`);
    }
  }
  return log;
}

/** The level MM adds to engine parts when a car with this engine is built (Supplier.randomEngineLevelModifier). */
export const engineLevel = (s: Obj): number => Number(s.mRandomEngineLevelModifier ?? 0);

export interface RenameSupplierOp {
  op: "renameSupplier";
  type: SupplierType;
  /** Current name. MM keeps a copy of a supplier per championship tier, and every copy is renamed. */
  from: string;
  name: string;
  /** Give this team MM's 50% works discount on it, as the other works teams have. */
  worksTeam?: string | number;
}

export function renameSupplier(save: Save, op: RenameSupplierOp): string {
  const all = save.g.list<Obj>(save.data.supplierManager[LIST_NAME[op.type]]);
  const hits = all.filter((s) => s.name === op.from);
  if (!hits.length) throw new Error(`No ${op.type} supplier called ${op.from}`);
  if (all.some((s) => s.name === op.name)) throw new Error(`A ${op.type} supplier is already called ${op.name}`);
  const works = op.worksTeam === undefined ? null : save.team(op.worksTeam);
  for (const s of hits) {
    s.name = op.name;
    if (works && !dictEntries(s.teamDiscounts).some(([k]) => k === works.teamID)) {
      s.teamDiscounts = [...(Array.isArray(s.teamDiscounts) ? s.teamDiscounts : []), { Key: works.teamID, Value: float(50) }];
    }
  }
  return `${op.type} supplier ${op.from} → ${op.name} (${hits.length} cop${hits.length === 1 ? "y" : "ies"})${works ? `, works team ${works.name}` : ""}`;
}

/** MM's design sliders exist only in the main (top single-seater) championship. */
export function hasChassisDesign(save: Save, team: Obj): boolean {
  const ch = save.championship(team);
  return ch.series === 0 && ch.championshipID === 0;
}

/**
 * The team's car fund: level 0 Low / 1 Medium / 2 High, the amount paid in per level, and what's
 * saved so far. TeamFinanceController.GetCarDevCost: a year's amount by championship id, paid
 * monthly (Rebirth) or after each race (FF20: / the season's events), see GameScale.
 */
export function carInvestment(save: Save, team: Obj) {
  const fin = save.g.deref<Obj>(team.financeController);
  const champ = save.championship(team);
  const id = champ.championshipID as number;
  const scale = gameScale(save.game);
  const per = scale.carFundPaid === "race" ? Math.max(1, save.g.list(champ.calendar).length) : 12;
  return {
    level: (fin.mInvestement ?? 1) as number,
    monthly: scale.carDevCost.map((row) => Math.round((row[id] ?? 0) / per / 1000) * 1000),
    per: scale.carFundPaid,
    fund: num(fin.moneyForCarDev ?? 0),
  };
}

export interface SetCarInvestmentOp {
  op: "setCarInvestment";
  team: string | number;
  /** 0 Low, 1 Medium, 2 High. */
  level: number;
}

/** TeamFinanceController.SetCarInvestement: how much goes into next year's car fund each month. */
export function setCarInvestment(save: Save, op: SetCarInvestmentOp): string {
  const team = save.team(op.team);
  if (![0, 1, 2].includes(op.level)) throw new Error("Investment level is 0 (Low), 1 (Medium) or 2 (High)");
  save.g.deref<Obj>(team.financeController).mInvestement = op.level;
  return `${team.name}: next year's car investment ${["Low", "Medium", "High"][op.level]}`;
}

export interface SetChassisOp {
  op: "setChassis";
  team: string | number;
  /** MM's nose height slider, 0..1: fuel efficiency (1) ↔ tyre wear (0). */
  nose: number;
  /** Rear package, 0..1: improvability (1) ↔ tyre heating (0). */
  rear: number;
}

/**
 * The member's design sliders on next year's car: the pending chassis' four stats are rebuilt from
 * the sliders (kept within its suppliers' bounds) and its suppliers, as MM's design screen does.
 * Run after setSuppliers. Only while MM designs the car (pre-season), only in the main championship.
 */
export function setChassis(save: Save, op: SetChassisOp): string {
  const g = save.g;
  const team = save.team(op.team);
  if (!hasChassisDesign(save, team)) throw new Error(`${team.name}: MM's design sliders are only in the main championship`);
  const ny = g.deref<Obj>(g.deref<Obj>(team.carManager).nextYearCarDesign);
  if (ny.state !== NEXT_YEAR_STATE.Designing || !ny.mChassisStats) {
    throw new Error(`${team.name}: next year's car isn't being designed (MM starts it when pre-season starts)`);
  }
  const cs = g.deref<Obj>(ny.mChassisStats);
  const sups = SUPPLIER_TYPES.flatMap((t) => (cs[CHASSIS_FIELD[t]] ? [toOption(save, g.deref<Obj>(cs[CHASSIS_FIELD[t]]), team)] : []));
  const range = sliderRange(sups);
  const nose = clampSlider(op.nose, range.nose), rear = clampSlider(op.rear, range.rear);
  const r = chassisStats(sups, nose, rear, gameScale(save.game).chassisStatMax);
  cs.mTyreWear = float(r.tyreWear);
  cs.mTyreHeating = float(r.tyreHeating);
  cs.mFuelEfficiency = float(r.fuelEfficiency);
  cs.mImprovability = float(r.improvability);
  const f = (v: number) => Math.round(v * 10) / 10;
  return `${team.name}: next year's chassis nose ${nose.toFixed(2)}, rear ${rear.toFixed(2)} → tyre wear ${f(r.tyreWear)}, tyre heating ${f(r.tyreHeating)}, fuel efficiency ${f(r.fuelEfficiency)}, improvability ${f(r.improvability)}`;
}
