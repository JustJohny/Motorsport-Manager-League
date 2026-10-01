// MM's part design rules (CarPartDesign in Assembly-CSharp) on plain data, so the toolkit and
// the league site agree on slots, cost and time. See docs/save-schema.md, "Part design".
// Import-free on purpose: the site bundles this file.

export interface DesignComponent {
  id: number;
  level: number;
  /** A lead engineer's own component (ComponentType.Engineer): never charged per slot level. */
  engineer: boolean;
  statBoost: number;
  maxStatBoost: number;
  reliabilityBoost: number;
  maxReliabilityBoost: number;
  /** Own cost / production days; 0 means "use the slot level's" (non-engineer only). */
  cost: number;
  days: number;
  risk: number;
  bonuses: { type: string; value: number }[];
  /** MM's own rich-text summary, e.g. "<b>Performance:</b> +10". */
  summary: string;
}

export interface DesignSettings {
  materialsCost: number;
  buildTimeDays: number;
  costPerLevel: number[];
  timePerLevel: number[];
}

export interface DesignContext {
  settings: DesignSettings;
  /** Normal slots: highest level of a part of this type in inventory + 1, clamped 1..5. */
  slots: number;
  /** Design Centre currentLevel when built, else null. */
  designCentreLevel: number | null;
  /** The player's career team pays full materials; AI teams 10 %. */
  isPlayer: boolean;
  /** The player's backstory time reduction, in days (player team only). */
  playerTimeModifierDays?: number;
}

export interface DesignPlan {
  /** Normal slots, by index; null = empty. */
  slots: (number | null)[];
  /** Extra slots opened by engineer components, with the level each one takes. */
  bonusSlots: { level: number; component: number | null }[];
  extraCopies: number;
  /** What the league charges: MM's player price (full materials + components). */
  cost: number;
  /** What MM itself would charge this team (AI teams pay 10 % of materials). */
  gameCost: number;
  days: number;
  /** Sum of component levels → part level (1..5). */
  level: number;
}

/** MM's HQsBuilding_v1.designCentrePartDaysPerLevel. */
export const DESIGN_CENTRE_DAYS = [0, -1, -2, -3];
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
  const gameCost = ctx.isPlayer ? cost : Math.round(Math.max(0, s.materialsCost * 0.1 + componentCost));

  // GetComponentDesignDurationBonus: own days, else the slot level's days, but only for a
  // component whose level equals the number of normal slots.
  const compDays = (c: DesignComponent) => (c.days !== 0 ? c.days : !c.engineer && ctx.slots === c.level ? s.timePerLevel[c.level - 1] ?? 0 : 0);
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
  let days = s.buildTimeDays + (ctx.designCentreLevel != null ? DESIGN_CENTRE_DAYS[ctx.designCentreLevel] ?? 0 : 0);
  days += all.reduce((sum, c) => sum + compDays(c), 0) + bonusDays;
  days = Math.max(0, days);
  if (ctx.isPlayer) days -= ctx.playerTimeModifierDays ?? 0;
  // MM keeps whole days plus rounded hours.
  days = Math.trunc(days) + Math.round((days - Math.trunc(days)) * 24) / 24;

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
