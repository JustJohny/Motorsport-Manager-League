import { float, num } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import { SIGNING_BONUS } from "../development.ts";
import { personName, type Save } from "../model.ts";

/**
 * FIRE Fantasy 20's contract-signing traits, as its "Personality Traits.txt" defines them and
 * PersonalityTraitDataManager loads them (morale, marketability and improveability / 100; the
 * stored probability is 1 − chance). FF20's game never sets their "SignedNewContract" criterion,
 * so MM never gives them; the league gives them to signings made through the site (the user's
 * rule, 2026-10-09).
 */
export const SIGNING_TRAITS = {
  /** Under 21: +12 potential, 99 %. */
  724: {
    name: "Young Driver Signed", description: "Thank you so much for the opportunity Boss!!!", weeks: [3], chance: SIGNING_BONUS.young.chance, ageBelow: SIGNING_BONUS.ageBelow,
    repeatable: false, opposites: [723], removes: [724],
    allStats: 1, marketability: 0.2, morale: 0.2, mechanic: 10, chairman: 5, improveability: -0.1, potential: SIGNING_BONUS.young.potential,
  },
  /** Anyone else: +1 potential, 80 %. */
  723: {
    name: "New Contract Signed", description: "So happy!", weeks: [3, 5], chance: SIGNING_BONUS.other.chance, ageBelow: undefined,
    repeatable: true, opposites: [724], removes: [723],
    allStats: 1, marketability: 0.2, morale: 0.2, mechanic: 10, chairman: 5, improveability: 0, potential: SIGNING_BONUS.other.potential,
  },
} as const;
export type SigningTraitId = keyof typeof SIGNING_TRAITS;

/** DialogCriteria.CriteriaOperator. */
const OP = { Equals: 0, Smaller: 3 } as const;
/** DriverStats.driverStatsTotalMax after training (FF20: 23 per skill). */
const TRAINED_MAX = 207;
const DRIVER_STATS = ["braking", "cornering", "smoothness", "overtaking", "consistency", "adaptability", "fitness", "feedback", "focus"];

export interface GrantTraitOp {
  op: "grantTrait";
  /** The driver's GUID. */
  person: string;
  trait: SigningTraitId;
  /** How long it lasts (FF20's table gives a range for some). */
  weeks: number;
}

function controllerTraits(save: Save, c: Obj): Obj[] {
  return [...save.g.list<Obj>(c.permanentPersonalityTraits ?? []), ...save.g.list<Obj>(c.temporaryPersonalityTraits ?? [])];
}

/** The trait's data object: shared if a driver already has it, else built from FF20's table on a template. */
function traitData(save: Save, id: SigningTraitId, template: Obj): Obj {
  const g = save.g;
  for (const p of save.people()) {
    if (!p.personalityTraitController) continue;
    const hit = controllerTraits(save, g.deref<Obj>(p.personalityTraitController)).map((t) => g.deref<Obj>(t.data)).find((d) => d?.ID === Number(id));
    if (hit) return hit;
  }
  const t = SIGNING_TRAITS[id];
  const d = g.clone(template);
  const crit = (type: string, info: string, op: number, parsed: number) => ({ criteriaOperator: op, mType: type, mCriteriaInfo: info, mParsedData: float(parsed), $version: "v0" });
  Object.assign(d, {
    ID: Number(id), type: 1, possibleLength: [...t.weeks],
    requirements: [crit("SignedNewContract", "", OP.Equals, 0), ...(t.ageBelow ? [crit("Age", String(t.ageBelow), OP.Smaller, t.ageBelow)] : [])],
    probability: float(1 - t.chance), evolvesInto: [], opposites: [...t.opposites], removesTraits: [...t.removes],
    triggerCriteria: [], triggerEndCriteria: [], shownType: 0, eventTriggerType: 0, allStats: t.allStats,
    moraleModifier: float(t.morale), mechanicModifier: t.mechanic, teammateModifier: float(0), chairmanModifier: t.chairman,
    improveabilityModifier: float(t.improveability), potentialModifier: t.potential, desiredWinsModifier: 0, desiredEarningsModifier: 0,
    specialCaseDescriptionID: null, isRepeatable: t.repeatable, nameID: "0", descriptionID: "0",
    mCustomTraitName: t.name, mCustomTraitDescription: t.description,
  });
  const mods = d.driverStatsModifier;
  for (const k of DRIVER_STATS) mods[k] = float(0);
  mods.marketability = float(t.marketability);
  const cases = g.deref<Obj>(d.specialCases);
  g.rawList(cases).length = 0;
  return d;
}

/**
 * Give a driver an FF20 trait as PersonalityTraitController.AddPersonalityTrait does: skipped if
 * they have it, had a non-repeatable one before, or have its opposite; removes the traits it
 * replaces; starts now and ends after `weeks`; and adds its potential to their room to grow
 * (Driver.UpdateModifiedPotentialValue), which stays when the trait ends.
 */
export function grantTrait(save: Save, op: GrantTraitOp): string {
  const g = save.g;
  const p = save.person(op.person);
  const t = SIGNING_TRAITS[op.trait];
  if (!t) throw new Error(`Unknown signing trait ${op.trait}`);
  if (!p.personalityTraitController) throw new Error(`${personName(p)} has no personality traits (not a driver)`);
  const c = g.deref<Obj>(p.personalityTraitController);
  const now = controllerTraits(save, c);
  const ids = now.map((x) => g.deref<Obj>(x.data).ID as number);
  const history = g.list<number>(c.mTraitHistory ?? []);
  if (ids.includes(Number(op.trait)) || (!t.repeatable && history.includes(Number(op.trait))) || t.opposites.some((o) => ids.includes(o))) {
    return `${personName(p)}: already has ${t.name} (or had it, or its opposite); skipped`;
  }
  const template = now.find((x) => g.deref<Obj>(x.data).type === 1) ?? findAnyTrait(save);
  if (!template) throw new Error("No personality trait in the save to copy");

  // Traits it replaces (its own ID: a repeatable one restarts).
  const temp = g.rawList(c.temporaryPersonalityTraits);
  const all = g.rawList(c.allTraits);
  for (const list of [temp, all]) {
    for (let i = list.length - 1; i >= 0; i--) if ((t.removes as readonly number[]).includes(g.deref<Obj>(g.deref<Obj>(list[i]).data).ID)) list.splice(i, 1);
  }

  const data = traitData(save, op.trait, g.deref<Obj>(template.data));
  const trait = g.clone(template);
  const end = new Date(Date.parse(save.now.slice(0, 19) + "Z") + op.weeks * 7 * 86_400_000).toISOString().slice(0, 19) + ".0000000";
  trait.data = g.ref(data);
  trait.mDriver = g.ref(p);
  trait.mTraitStartDate = save.now;
  trait.mTraitEndTime = end;
  for (const k of DRIVER_STATS) trait.mDriverStats[k] = float(0);
  const b = trait.specialCaseBehaviour;
  Object.assign(b, { mSpecialCases: g.ref(g.deref<Obj>(data.specialCases)), mDriver: g.ref(p), mPersonalityTraitName: null, mCircuit: null, mFightTeammateDriver: null });
  temp.push(trait);
  all.push(g.ref(trait));
  if (!t.repeatable) g.rawList(c.mTraitHistory).push(Number(op.trait));

  // Driver.UpdateModifiedPotentialValue: the pool grows, capped at what's left below 207.
  const stats = g.deref<Obj>(p.mStats);
  const total = Math.trunc(DRIVER_STATS.reduce((a, k) => a + num(stats[k] ?? 0), 0));
  const modified = Math.min(Math.max(0, num(p.mModifiedPotential ?? 0) + t.potential), TRAINED_MAX - total);
  p.mModifiedPotential = float(modified);
  stats.totalStatsMax = Math.min(total + Math.trunc(modified), TRAINED_MAX);
  if (p.mModifiedStats) g.deref<Obj>(p.mModifiedStats).totalStatsMax = stats.totalStatsMax;
  return `${personName(p)}: ${t.name} (+${t.potential} potential, ${op.weeks} week${op.weeks === 1 ? "" : "s"})`;
}

function findAnyTrait(save: Save): Obj | null {
  for (const p of save.people()) {
    if (!p.personalityTraitController) continue;
    const t = controllerTraits(save, save.g.deref<Obj>(p.personalityTraitController)).find((x) => save.g.deref<Obj>(x.data).type === 1);
    if (t) return t;
  }
  return null;
}
