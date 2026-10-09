// FIRE Fantasy 20's driver development, on plain data so the site and the toolkit agree. FF20
// starts drivers with no potential: a driver only gains stats while there's room to grow
// (DriverStats.GetPotential = totalStatsMax − total), and every point gained uses it up. Room comes
// from traits with a potential modifier, mostly rewarded for race results and by age (the trait
// table in src/ff20-potential-traits.ts). Only type imports: the site bundles this file.

/** A trait from FF20's table that changes potential (see tools/gen-potential-traits.ts). */
export interface PotentialTrait {
  id: number;
  name: string;
  /** Potential added (or removed when negative). */
  potential: number;
  /** MM's chance per roll, 0..1 (the table's Probability). */
  chance: number;
  permanent: boolean;
  /** How long a temporary trait lasts, in weeks: [n] or [min, max]. */
  weeks: number[] | null;
  req: {
    ageAbove?: number;
    ageBelow?: number;
    /** The driver's room to grow must be below this. */
    potentialBelow?: number;
    /** Another trait the driver must have (one of). */
    traits?: number[];
    employed?: boolean;
    /** The championship's order in its series + 1 (Formula 1 = 1, F2 = 2, F3 = 3). */
    tier?: number;
    tierGT?: number;
    tierEndurance?: number;
    /** Conditions the site can't check, as FF20 writes them. */
    other?: string[];
  };
}

/** The traits MM gives after every race for the finish (the post-race marker traits). */
export const RESULT_BANDS = [
  { trait: 909, label: "Win" },
  { trait: 910, label: "Podium (2nd–3rd)" },
  { trait: 911, label: "4th–5th" },
  { trait: 912, label: "6th–10th" },
  { trait: 913, label: "11th–15th" },
  { trait: 914, label: "16th or lower" },
] as const;

/** FF20's stat ceiling from training alone (DriverStats.GetMaxPotential): 23 per skill. */
export const TRAINED_TOTAL_MAX = 207;

/** The series as MM's trait requirements see it. */
export type SeriesKind = "single" | "gt" | "endurance";

export interface DriverForRules {
  age: number;
  /** Room to grow now. */
  room: number;
  employed: boolean;
  series: SeriesKind;
  /** Championship order in its series (0 = top). */
  order: number;
}

function matches(t: PotentialTrait, d: DriverForRules, withTraits: number[]): boolean {
  const r = t.req;
  if (r.ageAbove !== undefined && !(d.age > r.ageAbove)) return false;
  if (r.ageBelow !== undefined && !(d.age < r.ageBelow)) return false;
  if (r.potentialBelow !== undefined && !(d.room < r.potentialBelow)) return false;
  if (r.employed !== undefined && r.employed !== d.employed) return false;
  if (r.tier !== undefined && !(d.series === "single" && d.order + 1 === r.tier)) return false;
  if (r.tierGT !== undefined && !(d.series === "gt" && d.order + 1 === r.tierGT)) return false;
  if (r.tierEndurance !== undefined && !(d.series === "endurance" && d.order + 1 === r.tierEndurance)) return false;
  if (r.traits && !r.traits.some((x) => withTraits.includes(x))) return false;
  return !r.other?.length;
}

/**
 * For each race result, the potential rewards this driver could get, biggest chance first. FF20
 * often has a general and a series-specific version of the same reward; they're shown once, with
 * the better chance.
 */
export function raceRewards(traits: PotentialTrait[], d: DriverForRules) {
  return RESULT_BANDS.map((band) => {
    const best = new Map<string, PotentialTrait>();
    for (const t of traits.filter((x) => x.req.traits?.includes(band.trait) && matches(x, d, [band.trait]))) {
      const key = `${t.name}|${t.potential}`;
      if ((best.get(key)?.chance ?? -1) < t.chance) best.set(key, t);
    }
    return { ...band, rewards: [...best.values()].sort((a, b) => b.chance - a.chance || b.potential - a.potential) };
  });
}

/** FF20's tier placeholders in trait names ("Reigning {Tier1} Champion"). */
const TIER_NAMES: Record<string, string> = {
  Tier1: "F1", Tier2: "F2", Tier3: "F3", Tier1GT: "GT World", Tier2GT: "GT Cup", Tier1Endurance: "WEC", Tier2Endurance: "GET",
};
export const traitDisplayName = (name: string) => name.replace(/\{(\w+)\}/g, (m, k: string) => TIER_NAMES[k] ?? m);

/** Weeks as the site says them: "1–2 weeks", "permanent". */
export function traitLength(t: Pick<PotentialTrait, "permanent" | "weeks">): string {
  if (t.permanent) return "permanent";
  if (!t.weeks?.length) return "temporary";
  const [a, b] = t.weeks;
  return b !== undefined && b !== a ? `${a}–${b} weeks` : `${a} week${a === 1 ? "" : "s"}`;
}

/** The race whose result counts at MM's next trait roll: the marker trait lasts a week after it. */
export function raceForRoll<T extends { date: string; ended: boolean }>(calendar: T[], nextRoll: string): T | null {
  const roll = Date.parse(nextRoll.slice(0, 19) + "Z");
  return calendar.find((e) => {
    const race = Date.parse(e.date.slice(0, 19) + "Z");
    return roll >= race && roll < race + 7 * 86_400_000;
  }) ?? null;
}

/**
 * The league's signing bonus (the user's rule, 2026-10-09): FF20's "Young Driver Signed" and "New
 * Contract Signed" traits, which FF20's game never gives, for drivers signed through the site.
 */
export const SIGNING_BONUS = {
  ageBelow: 21,
  young: { id: 724, name: "Young Driver Signed", potential: 12, chance: 0.99 },
  other: { id: 723, name: "New Contract Signed", potential: 1, chance: 0.8 },
} as const;

/** What signing this driver may bring: "99 % chance of +12 potential (Young Driver Signed)". */
export function signingBonusText(age: number): string {
  const b = age < SIGNING_BONUS.ageBelow ? SIGNING_BONUS.young : SIGNING_BONUS.other;
  return `${Math.round(b.chance * 100)} % chance of +${b.potential} potential (${b.name})`;
}
