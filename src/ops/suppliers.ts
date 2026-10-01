import { float, num } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
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
}

/** A C# Dictionary as FullSerializer writes it: a [{Key, Value}] list, or an object (empty or string keys). */
function dictEntries(d: unknown): [number, number][] {
  if (Array.isArray(d)) return d.map((e: Obj) => [Number(e.Key), num(e.Value)]);
  if (d && typeof d === "object") return Object.entries(d).filter(([k]) => !k.startsWith("$")).map(([k, v]) => [Number(k), num(v as never)]);
  return [];
}
const list = (l: unknown): number[] => (Array.isArray(l) ? l.map(Number) : []);

/** Supplier.GetPrice: base (+ engine level modifier x multiplier x scalar), minus the team's discount. */
function price(save: Save, s: Obj, team: Obj): number {
  let p = Number(s.mBasePrice);
  if (s.supplierType === 0) p += Math.round(Number(s.mRandomEngineLevelModifier ?? 0) * num(s.mPriceMultiplier) * num(s.mScalar));
  const d = [...dictEntries(s.teamDiscounts), ...dictEntries(s.temporaryDiscounts)].find(([k]) => k === team.teamID)?.[1] ?? 0;
  return d > 0 ? p - Math.round(p * (d / 100)) : p;
}

/** Supplier.CanTeamBuyThis. */
function canBuy(s: Obj, team: Obj): boolean {
  const no = [...list(s.mTeamsThatCannotBuy), ...list(s.mTemporaryTeamsCannotBuy)];
  return !no.includes(team.teamID) || list(s.mTemporaryTeamCanBuy).includes(team.teamID);
}

function toOption(save: Save, s: Obj, team: Obj): SupplierOption {
  return {
    id: s.id, type: SUPPLIER_TYPES[s.supplierType], name: s.name, tier: s.mTier, price: price(save, s, team),
    stats: Object.fromEntries(dictEntries(s.supplierStats)),
    ...(s.supplierType === 0 ? { engineLevel: [s.minEngineLevelModifier, s.maxEngineLevelModifier] as [number, number] } : {}),
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
 * filled by DetermineNewSeasonSuppliers at Championship.OnChampionshipPromotionsEnd, after the
 * final race): about 4 engines, 6 brakes, 5 fuel and 4 materials deals. Empty until then.
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
 * buy, at the team's price. Empty until MM has drawn them after the final race.
 */
export function supplierOptions(save: Save, team: Obj): Partial<Record<SupplierType, SupplierOption[]>> {
  const champ = save.championship(team);
  const out: Partial<Record<SupplierType, SupplierOption[]>> = {};
  for (const type of SUPPLIER_TYPES) {
    const list = drawnSuppliers(save, champ, type).filter((s) => canBuy(s, team)).map((s) => toOption(save, s, team));
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
 * chassis gets the suppliers (CarDesignScreen.OnStartDesign), its stats shift by the difference
 * (ApplySupplierStats), the engine level modifier follows the engine, and the AI's payments are
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
  const log: string[] = [];
  for (const [type, id] of Object.entries(op.suppliers) as [SupplierType, number][]) {
    const chosen = findSupplier(save, type, id);
    if (!canBuy(chosen, team)) throw new Error(`${team.name} can't buy ${chosen.name}`);
    const old = cs[CHASSIS_FIELD[type]] ? g.deref<Obj>(cs[CHASSIS_FIELD[type]]) : null;
    if (old === chosen) continue;
    const stats = (s: Obj | null) => new Map<number, number>(dictEntries(s?.supplierStats));
    const before = stats(old), after = stats(chosen);
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      const field = CHASSIS_STAT[k];
      if (field && field in cs) cs[field] = float(num(cs[field]) + (after.get(k) ?? 0) - (before.get(k) ?? 0));
    }
    cs[CHASSIS_FIELD[type]] = g.ref(chosen);
    if (type === "Engine") ny.mEngineModifier = chosen.mRandomEngineLevelModifier ?? 0;
    const refund = old ? price(save, old, team) : 0;
    const cost = price(save, chosen, team);
    log.push(`${team.name}: next year's ${type.toLowerCase()} ${old?.name ?? "none"} → ${chosen.name}`);
    if (refund) log.push(adjustBudget(save, { op: "adjustBudget", team: team.name, delta: refund, reason: `Refund: ${old!.name} (${type.toLowerCase()} chosen on the league site instead)` }));
    log.push(adjustBudget(save, { op: "adjustBudget", team: team.name, delta: -cost, reason: `${chosen.name} ${type.toLowerCase()} supply` }));
  }
  return log.length ? log : [`${team.name}: suppliers unchanged`];
}
