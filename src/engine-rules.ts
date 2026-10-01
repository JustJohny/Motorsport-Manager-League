// Works engine programmes: the league's rules for developing a member's own engine, on plain
// data so the site, the database tests and the toolkit agree. The result is an MM engine
// supplier: engine level (added to engine parts at the season change where engines aren't spec)
// plus chassis stats. Only type imports: the site bundles this file.

import { roll } from "./politics.ts";

export type EngineConcept = "power" | "efficient" | "balanced";
export type EngineArea = "power" | "fuel" | "improvability" | "tyres";

/** An engine as MM's Supplier carries it (supplierStats keys: 0 tyre wear, 2 fuel, 3 improvability). */
export interface EngineStats {
  level: number;
  fuel: number;
  improvability: number;
  tyreWear: number;
}

export const ENGINE_SETTINGS = {
  foundingCost: 30_000_000,
  /** The n-th point in a season costs n x this. */
  pointCostStep: 1_000_000,
  /** Share of last season's legal engine a programme keeps. */
  carryOver: 0.8,
  newEngine: { level: 10, fuel: 0, improvability: 0, tyreWear: 0 } as EngineStats,
  customerDetune: 0.85,
  finalRoll: 0.05,
};

export const CONCEPTS: Record<EngineConcept, { name: string; description: string; levelPerPoint: number; statPerPoint: number; statCap: number }> = {
  power: { name: "High-revving power unit", description: "Lots of engine level per point; fuel and improvability barely move.", levelPerPoint: 6, statPerPoint: 0.5, statCap: 5 },
  balanced: { name: "Balanced", description: "A bit of everything.", levelPerPoint: 4.5, statPerPoint: 1, statCap: 12 },
  efficient: { name: "Efficient long-life unit", description: "Less power, but fuel and improvability can go far.", levelPerPoint: 3, statPerPoint: 1.5, statCap: 20 },
};

export interface ResearchProject {
  id: string;
  name: string;
  description: string;
  cost: number;
  /** Base chance of success, 0..1 (raised by the lead engineer and HQ). */
  chance: number;
  success: Partial<EngineStats>;
  failure: Partial<EngineStats>;
  /** Illegal: works engine only, checked after every race. */
  illegal?: { detectionPerRace: number; growthPerRace: number };
}

export const PROJECTS: ResearchProject[] = [
  { id: "combustion", name: "Advanced combustion", description: "A new combustion chamber design.", cost: 5_000_000, chance: 0.55, success: { level: 20 }, failure: { level: -8 } },
  { id: "lightweight", name: "Lightweight internals", description: "Lighter, more efficient moving parts.", cost: 4_000_000, chance: 0.6, success: { fuel: 4, improvability: 2 }, failure: { fuel: -2 } },
  { id: "thermal", name: "Thermal management", description: "Cooler running, kinder to the tyres.", cost: 3_000_000, chance: 0.65, success: { tyreWear: 3, improvability: 2 }, failure: { tyreWear: -1 } },
  {
    id: "fuelflow", name: "Fuel-flow trick (illegal)", description: "Bypasses the fuel-flow limit. Big gain, but the stewards may find it.",
    cost: 6_000_000, chance: 0.75, success: { level: 35 }, failure: { level: -5 },
    illegal: { detectionPerRace: 0.04, growthPerRace: 0.03 },
  },
];

/** Cost of buying `n` more points when `bought` were bought this season: the n-th point costs n x step. */
export function pointsCost(bought: number, n: number, s = ENGINE_SETTINGS): number {
  let total = 0;
  for (let i = bought + 1; i <= bought + n; i++) total += i * s.pointCostStep;
  return total;
}

export interface SeasonPlan {
  concept: EngineConcept;
  points: Record<EngineArea, number>;
  projects: string[];
}

const clampStat = (v: number, cap: number) => Math.max(-cap, Math.min(cap, v));

/** The engine a season's development produces before research projects (deterministic). */
export function developEngine(start: EngineStats, plan: SeasonPlan): EngineStats {
  const c = CONCEPTS[plan.concept];
  const p = plan.points;
  return {
    level: start.level + p.power * c.levelPerPoint,
    // More power is thirstier and harder on the tyres.
    fuel: clampStat(start.fuel + p.fuel * c.statPerPoint - Math.floor(p.power / 3), Math.max(c.statCap, Math.abs(start.fuel))),
    improvability: clampStat(start.improvability + p.improvability * c.statPerPoint, Math.max(c.statCap, Math.abs(start.improvability))),
    tyreWear: clampStat(start.tyreWear + p.tyres * c.statPerPoint - Math.floor(p.power / 4), Math.max(c.statCap, Math.abs(start.tyreWear))),
  };
}

/** Chance a project succeeds: base + up to 15 % from the lead engineer (stat 0..20) and 2.5 % per Design Centre level. */
export function projectChance(p: ResearchProject, engineerSkill: number, designCentreLevel: number): number {
  return Math.min(0.95, p.chance + Math.min(1, Math.max(0, engineerSkill) / 20) * 0.15 + 0.025 * Math.max(0, designCentreLevel));
}

const add = (a: EngineStats, b: Partial<EngineStats>): EngineStats => ({
  level: a.level + (b.level ?? 0), fuel: a.fuel + (b.fuel ?? 0), improvability: a.improvability + (b.improvability ?? 0), tyreWear: a.tyreWear + (b.tyreWear ?? 0),
});

/**
 * The season change: development, then each project rolled (seeded, so it can be shown and
 * checked), then a small roll on the result. Returns the legal engine (customers, and the works
 * team after a bust) and the works engine (with illegal gains).
 */
export function buildEngine(start: EngineStats, plan: SeasonPlan, engineerSkill: number, designCentreLevel: number, seed: (string | number)[]) {
  let legal = developEngine(start, plan);
  let works = legal;
  const outcomes: { project: string; success: boolean }[] = [];
  for (const id of plan.projects) {
    const p = PROJECTS.find((x) => x.id === id);
    if (!p) continue;
    const success = roll(...seed, id) < projectChance(p, engineerSkill, designCentreLevel);
    outcomes.push({ project: id, success });
    const effect = success ? p.success : p.failure;
    works = add(works, effect);
    if (!p.illegal || !success) legal = add(legal, effect);
  }
  const jitter = (v: number, key: string) => Math.round(v * (1 + (roll(...seed, "final", key) * 2 - 1) * ENGINE_SETTINGS.finalRoll) * 10) / 10;
  const finish = (e: EngineStats): EngineStats => ({
    level: Math.max(1, Math.round(jitter(e.level, "level"))), fuel: jitter(e.fuel, "fuel"), improvability: jitter(e.improvability, "impr"), tyreWear: jitter(e.tyreWear, "tyre"),
  });
  return { legal: finish(legal), works: finish(works), outcomes };
}

/** Next season's starting point: a share of this season's legal engine. */
export function carryOver(legal: EngineStats, s = ENGINE_SETTINGS): EngineStats {
  return {
    level: Math.max(s.newEngine.level, Math.round(legal.level * s.carryOver)),
    fuel: legal.fuel * s.carryOver, improvability: legal.improvability * s.carryOver, tyreWear: legal.tyreWear * s.carryOver,
  };
}

/** What customers get: the legal engine, detuned if the owner sells a customer spec. */
export function customerEngine(legal: EngineStats, detuned: boolean, s = ENGINE_SETTINGS): EngineStats {
  return detuned ? { ...legal, level: Math.round(legal.level * s.customerDetune) } : legal;
}

/** Chance the illegal device is found after the n-th race it runs in (1-based). */
export function illegalDetection(p: ResearchProject, raceNumber: number): number {
  if (!p.illegal) return 0;
  return Math.min(1, p.illegal.detectionPerRace + p.illegal.growthPerRace * (raceNumber - 1));
}
