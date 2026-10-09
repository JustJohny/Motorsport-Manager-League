// MM's part design rules (CarPartDesign in Assembly-CSharp) on plain data, so the toolkit and
// the league site agree on slots, cost and time. See docs/save-schema.md, "Part design".
// Only type imports: the site bundles this file.

import type { DesignBase, DesignComponent, DesignContext, GameRules } from "./league-types.ts";

export type { DesignBase, DesignComponent, DesignContext, DesignSettings } from "./league-types.ts";

export interface DesignPlan {
  /** Normal slots, by index; null = empty. */
  slots: (number | null)[];
  /** Extra slots opened by engineer components, with the level each one takes. */
  bonusSlots: { level: number; component: number | null }[];
  extraCopies: number;
  /** What the league charges: MM's player price (full materials + components). */
  cost: number;
  /** What MM itself would charge this team (AI teams pay 10 % of materials; FF20 1 %). */
  gameCost: number;
  days: number;
  /** Sum of component levels → part level (1..5). */
  level: number;
}

/** HQsBuilding_v1.designCentrePartDaysPerLevel. */
export const DESIGN_CENTRE_DAYS: Record<GameRules, number[]> = { ff20: [0, -2, -3.5, -5], rebirth: [0, -1, -2, -3] };
/** FF20: CarPartDesign.GetDesignDuration takes 10 days off for every team but the player's. */
const FF20_AI_DAYS = 10;
/** Bonuses that open a slot when the component is chosen (CarPartComponentBonus.OnSelect). */
const SLOT_BONUSES: Record<string, (c: DesignComponent, value: number) => number> = {
  BonusUnlockExtraSlot: (_c, v) => v,
  BonusSpecificLevelComponentAddNoDays: (_c, v) => v,
  BonusPerSpecificLevelComponentUsed: (_c, v) => v,
  BonusCreateTwoParts: (c) => c.level,
  BonusExtraReliabilityPerDayInProduction: (c) => c.level,
};
/** Bonuses whose OnSelect needs game data the save doesn't hold; not offered. */
export const UNSUPPORTED_BONUSES = ["BonusAddRandomLevelComponent"];

export function partLevel(components: DesignComponent[]): number {
  const sum = components.filter((c) => !c.engineer).reduce((s, c) => s + c.level, 0);
  return sum >= 15 ? 5 : sum >= 10 ? 4 : sum >= 6 ? 3 : sum >= 3 ? 2 : sum >= 1 ? 1 : 0;
}

/**
 * Place the chosen components the way MM's AddComponent does and work out cost and time.
 * Engineer components go first (they open bonus slots), then the rest from the highest level
 * down. Throws when a component doesn't fit.
 */
export function planDesign(ctx: DesignContext, chosen: DesignComponent[]): DesignPlan {
  if (new Set(chosen.map((c) => c.id)).size !== chosen.length) throw new Error("A component is chosen twice");
  for (const c of chosen) {
    const bad = c.bonuses.find((b) => UNSUPPORTED_BONUSES.includes(b.type));
    if (bad) throw new Error(`Component ${c.id} (${bad.type}) isn't supported by the league`);
  }
  const slots: (DesignComponent | null)[] = Array.from({ length: ctx.slots }, () => null);
  const bonus: { level: number; component: DesignComponent | null }[] = [];
  let extraCopies = 0;
  const order = [...chosen].sort((a, b) => Number(b.engineer) - Number(a.engineer) || b.level - a.level);
  for (const c of order) {
    // AddComponent: the first free normal slot at index >= level-1, but a free bonus slot of
    // a high enough level wins.
    let placed = false;
    const b = bonus.find((s) => s.level >= c.level && !s.component);
    if (b) { b.component = c; placed = true; }
    else {
      const i = slots.findIndex((s, i) => i >= c.level - 1 && !s);
      if (i >= 0) { slots[i] = c; placed = true; }
    }
    if (!placed) throw new Error(`No free slot for level ${c.level} component ${c.id}`);
    for (const x of c.bonuses) {
      const lvl = SLOT_BONUSES[x.type]?.(c, x.value);
      if (lvl !== undefined) bonus.push({ level: lvl, component: null });
      if (x.type === "BonusCreateTwoParts") extraCopies++;
    }
  }

  const all = [...slots, ...bonus.map((b) => b.component)].filter((c): c is DesignComponent => !!c);
  const s = ctx.settings;
  const componentCost = all.reduce((sum, c) => sum + (c.cost !== 0 ? c.cost : c.engineer ? 0 : s.costPerLevel[c.level - 1] ?? 0), 0);
  const cost = Math.round(Math.max(0, s.materialsCost + componentCost));
  const rules: GameRules = ctx.rules ?? "rebirth";
  const aiMaterials = rules === "ff20" ? 0.01 : 0.1;
  const gameCost = ctx.isPlayer ? cost : Math.round(Math.max(0, s.materialsCost * aiMaterials + componentCost));

  // GetComponentDesignDurationBonus: own days, else the slot level's days for every other
  // non-engineer component (Rebirth: only one whose level equals the number of normal slots).
  const levelDays = (c: DesignComponent) => !c.engineer && (rules === "ff20" || ctx.slots === c.level);
  const compDays = (c: DesignComponent) => (c.days !== 0 ? c.days : levelDays(c) ? s.timePerLevel[c.level - 1] ?? 0 : 0);
  let bonusDays = 0;
  for (const c of all) for (const x of c.bonuses) {
    if (x.type === "BonusSpecificLevelComponentAddNoDays") {
      for (const o of all) if (o.level === x.value && compDays(o) > 0) bonusDays -= compDays(o);
    } else if (x.type === "BonusSpecificLevelSlotAddNoDays") {
      const inSlot = [slots[x.value - 1], ...bonus.filter((b) => b.level === x.value).map((b) => b.component)];
      for (const o of inSlot) if (o && compDays(o) > 0) bonusDays -= compDays(o);
    } else if (x.type === "BonusTimeReductionPerMillionSpent") {
      bonusDays += (gameCost / 1_000_000) * x.value;
    }
  }
  let days = s.buildTimeDays + (ctx.designCentreLevel != null ? DESIGN_CENTRE_DAYS[rules][ctx.designCentreLevel] ?? 0 : 0);
  days += all.reduce((sum, c) => sum + compDays(c), 0) + bonusDays;
  days = Math.max(0, days);
  if (rules === "ff20") {
    // GetDesignDuration: hours from the fraction, then 10 days off for non-player teams, then the
    // player's backstory modifier.
    const hours = Math.round((days - Math.trunc(days)) * 24);
    if (!ctx.isPlayer && !ctx.humanDesignTime) days -= FF20_AI_DAYS;
    days = Math.max(0, Math.trunc(days) + hours / 24 - (ctx.isPlayer ? ctx.playerTimeModifierDays ?? 0 : 0));
  } else {
    if (ctx.isPlayer) days -= ctx.playerTimeModifierDays ?? 0;
    // MM keeps whole days plus rounded hours.
    days = Math.trunc(days) + Math.round((days - Math.trunc(days)) * 24) / 24;
  }

  return {
    slots: slots.map((c) => c?.id ?? null),
    bonusSlots: bonus.map((b) => ({ level: b.level, component: b.component?.id ?? null })),
    extraCopies,
    cost,
    gameCost,
    days,
    level: partLevel(all),
  };
}

/**
 * Expected stats of the designed part (CarPartComponent.ApplyStats): components' boosts add to
 * the base. In Rebirth stat and max-performance boosts scale with the team's development rate
 * and MM adds randomness (max reliability ±10 %, development variance); FF20 rolls the starting
 * reliability once per game launch. So this is an estimate.
 */
export function predictPart(base: DesignBase, chosen: DesignComponent[]) {
  const rate = base.developmentRate;
  return {
    stat: base.stat + chosen.reduce((s, c) => s + c.statBoost * rate, 0),
    // Below zero the mechanics simply can't improve the part.
    maxPerformance: Math.max(0, base.maxPerformance + chosen.reduce((s, c) => s + c.maxStatBoost * rate, 0)),
    // MM keeps reliability within 0..100 %.
    reliability: Math.min(1, Math.max(0, base.reliability + chosen.reduce((s, c) => s + c.reliabilityBoost, 0))),
    maxReliability: base.maxReliability + chosen.reduce((s, c) => s + c.maxReliabilityBoost, 0),
    risk: chosen.reduce((s, c) => s + c.risk, 0),
  };
}

// MM's post-race scrutineering (PenaltyDirector.ScrutinizePartRules): every fitted part with
// rules risk is checked; it's caught when Random(0..99) < (risk + investor bonus) x scrutineeringChance.
// Rebirth: x5, the car drops 2 places and pays $100K per offence this season.
// FF20: x10, the car drops 23 places (to the back) and pays $250K per offence this season; the
// part is banned (CarPart.isBanned), taken off the improvement lists and unfitted.
export const SCRUTINEERING: Record<GameRules, { chancePerRisk: number; placesLost: (n: number) => number; finePerOffence: number; bansPart: boolean }> = {
  rebirth: { chancePerRisk: 0.05, placesLost: (n) => 2 * n, finePerOffence: 100_000, bansPart: false },
  ff20: { chancePerRisk: 0.1, placesLost: () => 23, finePerOffence: 250_000, bansPart: true },
};

/** A drop of this many places sends the car to the back of any MM field (FF20's busts). */
export const TO_THE_BACK = 23;

/** Chance per race that one fitted part with this risk is caught. */
export function bustChance(risk: number, investorBonus = 0, rules: GameRules = "rebirth"): number {
  if (!(risk > 0)) return 0;
  return Math.min(1, Math.max(0, risk + investorBonus) * SCRUTINEERING[rules].chancePerRisk);
}

/** Chance per race that at least one of a car's fitted parts is caught. */
export function carBustChance(risks: number[], investorBonus = 0, rules: GameRules = "rebirth"): number {
  return 1 - risks.reduce((p, r) => p * (1 - bustChance(r, investorBonus, rules)), 1);
}

/** What the next bust costs: places lost and the fine, both scaled by this season's offences. */
export function nextBustPenalty(brokenThisSeason: number, rules: GameRules = "rebirth") {
  const n = brokenThisSeason + 1;
  const r = SCRUTINEERING[rules];
  return { placesLost: r.placesLost(n), fine: r.finePerOffence * n, bansPart: r.bansPart };
}
