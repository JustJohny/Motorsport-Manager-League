import { float } from "../codec/sav.ts";
import { gameScale } from "../game-rules.ts";
import type { Obj } from "../graph.ts";
import type { ContractRenewal, MoraleTrait, RenewalReason } from "../league-types.ts";
import { gameTextName } from "../regulations.ts";
import { JOB, numOrNull, personKind, personName, type Save } from "../model.ts";

/** Save numbers may be wrapped floats. */
const n = (v: unknown): number => (v == null ? 0 : numOrNull(v as never) ?? 0);
import { delayedEvents, insertByDate } from "./calendar.ts";

// MM's contract renewal, from Assembly-CSharp: Person.GetInterestedToTalkReaction (will they talk),
// ContractDesiredValuesHelper (desired wage, sign-on fee, length) and TeamAIController.Renew /
// CalculateYearlyWage (what MM's AI offers). See docs/save-schema.md, "Contract renewals".
// Differences from MM: its random −1/0/+1 on the negotiation weight is taken as 0, and every
// personality trait counts as active (MM skips a few circuit- or event-specific ones).

/** ContractEvaluationWeightings: age and morale lookup tables, as [upper bound, result]. */
const EXISTING_DRIVER_AGE: [number, number][] = [[20, 2], [25, -1], [30, 0], [36, 0], [42, 5], [43, 8]];
const EXISTING_STAFF_AGE: [number, number][] = [[20, -5], [25, -3], [30, 0], [36, 0], [48, 2], [49, 8]];
const EXISTING_DRIVER_MORALE: [number, number][] = [[25, 6], [36, 3], [46, 1], [66, 0], [76, -2], [89, -4], [90, -6]];
/** desiredChampionshipAgainstStarsValue: stars (floored) → the lowest championship order they'll race in. */
const DESIRED_CHAMPIONSHIP = [2, 2, 2, 1, 0, 0];

/** ContractVariablesContainer: base wage curve in $M by ability stars, and sign-on fees by stars and range A..D. */
const WAGE_CURVE: Record<string, number[]> = {
  Driver: [0.1, 0.5, 1, 5, 10, 20, 40],
  Engineer: [0.05, 0.1, 0.5, 1, 5, 7.5, 10],
  Mechanic: [0.05, 0.1, 0.25, 0.5, 1, 5, 10],
};
const SIGN_ON: Record<string, number[][]> = {
  Driver: [[0.09, 0.07, 0.05, 0.03], [0.3, 0.25, 0.2, 0.15], [0.5, 0.45, 0.4, 0.35], [2, 1.75, 1.5, 1.25], [4, 3.5, 3, 2.5]],
  Engineer: [[0.06, 0.05, 0.04, 0.03], [0.3, 0.25, 0.2, 0.15], [0.5, 0.45, 0.4, 0.35], [0.9, 0.8, 0.7, 0.6], [2.5, 2, 1.5, 1]],
  Mechanic: [[0.01, 0.0075, 0.005, 0.0025], [0.04, 0.03, 0.02, 0.01], [0.125, 0.1, 0.075, 0.05], [1, 0.75, 0.5, 0.25], [2, 1.75, 1.5, 1.25]],
};
const DRIVER_STATS = ["braking", "cornering", "smoothness", "overtaking", "consistency", "adaptability", "fitness", "feedback", "focus"];
const MECHANIC_STATS = ["reliability", "performance", "concentration", "speed", "pitStops", "leadership"];
/** PersonalityTrait.SpecialCaseType. */
const WILL_NOT_JOIN_RIVAL = 18;
const WILL_NOT_RENEW = 19;
/** ContractPerson.Status.Reserve. */
const RESERVE = 3;
const TEAM_PRINCIPAL_JOB = 5;
/** Why MM won't talk (Person.InterestedToTalkResponseType), as shown on the site. */
export const REFUSALS = {
  retired: "Retired",
  retiring: "Wants to retire",
  series: "Won't drive in this series",
  higher: "Wants a higher championship",
  wontRenew: "Won't renew while their rival is on the team",
  rival: "Won't stay with a rival on the team",
  morale: "Morale too low",
  notInterested: "Not interested",
} as const;

const gameTime = (d: string) => Date.parse(d.slice(0, 19) + "Z");
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/** EvaluateLookupTableAgainstValue: the first entry whose bound is above the value, else the last. */
function lookup(table: [number, number][], v: number): number {
  for (let i = 0; i < table.length - 1; i++) if (v < table[i][0]) return table[i][1];
  return table[table.length - 1][1];
}

/** Person.GetAge. */
function age(born: string, now: string): number {
  const b = new Date(gameTime(born)), n = new Date(gameTime(now));
  let a = n.getUTCFullYear() - b.getUTCFullYear();
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

/** Contract.GetMonthsRemaining. */
export function monthsRemaining(end: string, now: string): number {
  return Math.round(Math.floor((gameTime(end) - gameTime(now)) / 86_400_000) / 365 * 12);
}

function traits(save: Save, p: Obj): Obj[] {
  if (!p.personalityTraitController) return [];
  const c = save.g.deref<Obj>(p.personalityTraitController);
  return [...save.g.list<Obj>(c.permanentPersonalityTraits ?? []), ...save.g.list<Obj>(c.temporaryPersonalityTraits ?? [])]
    .map((t) => ({ ...t, data: save.g.deref<Obj>(t.data) }));
}

/** Special cases that only hold during a session or at a circuit (CanBeApplied): never between races. */
const SESSION_CASES = new Set([2, 3, 4, 9, 10, 11, 12, 13, 14, 22, 23, 24, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 77, 78, 79, 80]);

/** Driver.GetStatsValue / Mechanic.GetStatsValue: own stats as 0..1. */
function statsValue(save: Save, p: Obj): number {
  const st = save.g.deref<Obj>(p.mStats ?? p.stats);
  const keys = personKind(p) === "Driver" ? DRIVER_STATS : MECHANIC_STATS;
  return keys.reduce((s, k) => s + n(st[k]), 0) / (keys.length * 20);
}

/** Team.GetTeamMate: the other main driver. */
function teammate(save: Save, team: Obj, d: Obj): Obj | null {
  return teamDrivers(save, team).find((x) => x !== d && isMainDriver(save, x)) ?? null;
}

/**
 * PersonalityTraitSpecialCaseBehaviour.CanBeApplied, between races: a trait without special cases
 * always applies; otherwise one of its conditions must hold. Session and circuit conditions don't.
 */
function traitActive(save: Save, p: Obj, t: Obj): boolean {
  const cases = save.g.list<number>(t.data.specialCases ?? []);
  if (!cases.length) return true;
  const team = save.employer(p);
  const c = save.contract(p);
  const mate = team ? teammate(save, team, p) : null;
  return cases.some((k) => {
    if (SESSION_CASES.has(k)) return false;
    switch (k) {
      case 27: return !!team && c.mCurrentStatus !== 1; // NotNumberOne
      case 28: { // MechanicWorseThanDriver
        const mech = team ? slotPeople(save, team, JOB.Mechanic).find((m) => m.driver === p.mCarID) : null;
        return !!mech && statsValue(save, mech) < statsValue(save, p);
      }
      case 29: return !!mate && statsValue(save, mate) > statsValue(save, p); // TeammateBetterThanDriver
      case 30: return !!mate && Math.round(n(save.contract(mate).yearlyWages) / 12) > Math.round(n(c.yearlyWages) / 12); // TeammateEarningMoreThanDriver
      case 39: return !!team && save.championship(team).series === 0; // SingleSeaters
      case 40: return !!team && save.championship(team).series === 1; // GTSeries
      case 68: return !p.mJoinsAnySeries && !save.g.list<number>(p.mDriverPreferedSeries ?? []).includes(2); // AddEnduranceRacing
      case 69: return !p.mJoinsAnySeries && !save.g.list<number>(p.mDriverPreferedSeries ?? []).includes(1); // AddGTRacing
      case 75: return !p.mJoinsAnySeries; // AnySeries
      case 81: return !!team && save.g.same(p.nationality, team.nationality); // HomeTeam
      case 82: return !!mate && save.g.same(p.nationality, mate.nationality); // HomeTeammate
      default: return true;
    }
  });
}

function activeTraits(save: Save, p: Obj): Obj[] {
  return traits(save, p).filter((t) => traitActive(save, p, t));
}

/** PersonalityTrait.GetDriverStatsModifier. */
function traitStats(t: Obj): Obj {
  const d = t.data;
  if (d.allStats) return Object.fromEntries([...DRIVER_STATS.map((k) => [k, n(d.allStats)]), ["marketability", 0]]);
  return d.driverStatsModifier ?? {};
}

/** PersonalityTraitController.GetSingleModifierForStat for the data-field modifiers. */
function traitSum(save: Save, p: Obj, field: string): number {
  return activeTraits(save, p).reduce((s, t) => s + n(t.data[field] ?? 0), 0);
}

function hasSpecialCase(save: Save, p: Obj, kind: number): boolean {
  return traits(save, p).some((t) => save.g.list<number>(t.data.specialCases ?? []).includes(kind));
}

/** Driver.GetStats: own stats plus every trait's, each clamped to 0..20 (FF20: 25). */
function driverStats(save: Save, p: Obj): { total: number; marketability: number; max: number } {
  const own = save.g.deref<Obj>(p.mStats);
  const mods = activeTraits(save, p).map(traitStats);
  const cap = gameScale(save.game).driverStatMax;
  const total = DRIVER_STATS.reduce((s, k) => s + clamp(n(own[k] ?? 0) + mods.reduce((m, x) => m + n(x[k] ?? 0), 0), 0, cap), 0);
  const marketability = clamp01(n(own.marketability ?? 0) + mods.reduce((m, x) => m + n(x.marketability ?? 0), 0));
  // MM's modified stats keep their own totalStatsMax (the save stores it); fall back to the base one.
  const max = n(p.mModifiedStats?.totalStatsMax ?? own.totalStatsMax ?? 0);
  return { total, marketability, max };
}

/** PersonStats.GetAbility (stars, 0..5), GetAbilityPotential and GetPotential (drivers: total / 36, FF20 / 41.4). */
export function abilities(save: Save, p: Obj): { ability: number; abilityPotential: number; potential: number } {
  const kind = personKind(p);
  if (kind === "Driver") {
    const s = driverStats(save, p);
    const div = gameScale(save.game).driverAbilityDivisor;
    return { ability: s.total / div, abilityPotential: s.max / div, potential: s.max - s.total };
  }
  const st = save.g.deref<Obj>(p.stats);
  const total = kind === "Engineer"
    ? Object.entries(st.partContributionStats ?? {}).filter(([k]) => !k.startsWith("$")).reduce((s, [, v]) => s + n(v), 0)
    : MECHANIC_STATS.reduce((s, k) => s + n(st[k] ?? 0), 0);
  const max = n(st.totalStatsMax ?? 0);
  return { ability: total / 24, abilityPotential: max / 24, potential: max - total };
}

/** Conditions of trait special cases, as the site words them (PersonalityTrait.SpecialCaseType). */
const CASE_TEXT: Record<number, string> = {
  20: "while they're fighting with their teammate",
  27: "while they aren't the number 1 driver",
  28: "while their mechanic is rated lower than them",
  29: "while their teammate is rated higher",
  30: "while their teammate earns more",
  31: "until the neck injury heals",
  32: "until the face injury heals",
};
/** PersonalityTrait.SpecialCaseType.FightWithTeammate: the only case that reaches a teammate (CanBeAppliedToOtherPerson). */
const FIGHT_WITH_TEAMMATE = 20;

function traitName(t: Obj): string {
  return (t.data.nameID && gameTextName(t.data.nameID)) || t.data.mCustomTraitName || "A personality trait";
}

/**
 * Driver.GetMorale: own morale plus the driver's applicable traits (PersonalityTraitController
 * .GetSingleModifierForStat(Morale)), plus every teammate trait that reaches them
 * (CanBeAppliedToOtherPerson: no special case, or a fight with this driver) with a teammate effect.
 * MM adds such a trait's morale modifier as well as its teammate modifier, as its code does.
 */
export function moraleBreakdown(save: Save, p: Obj, team: Obj | null): { base: number; total: number; traits: MoraleTrait[] } {
  const base = n(p.mMorale ?? 0);
  const out: MoraleTrait[] = [];
  const describe = (t: Obj, value: number, via?: string): MoraleTrait => {
    const cases = save.g.list<number>(t.data.specialCases ?? []);
    const condition = cases.map((k) => CASE_TEXT[k]).find(Boolean);
    return { name: traitName(t), value, temporary: t.data.type === 1, ...(via ? { via } : {}), ...(condition ? { condition } : {}),
      ...(t.data.type === 1 && t.mTraitEndTime && !String(t.mTraitEndTime).startsWith("0001") ? { until: t.mTraitEndTime } : {}) };
  };
  for (const t of activeTraits(save, p)) if (n(t.data.moraleModifier ?? 0)) out.push(describe(t, n(t.data.moraleModifier)));
  if (personKind(p) === "Driver" && team) {
    for (const d of teamDrivers(save, team)) {
      if (d === p) continue;
      for (const t of traits(save, d)) {
        const mate = n(t.data.teammateModifier ?? 0);
        if (!mate) continue;
        const cases = save.g.list<number>(t.data.specialCases ?? []);
        const fight = t.specialCaseBehaviour ? save.g.deref<Obj>(t.specialCaseBehaviour)?.mFightTeammateDriver : null;
        if (cases.length && !(cases.includes(FIGHT_WITH_TEAMMATE) && fight && save.g.deref(fight) === p)) continue;
        out.push(describe(t, mate + n(t.data.moraleModifier ?? 0), personName(d)));
      }
    }
  }
  return { base, total: clamp01(base + out.reduce((a, x) => a + x.value, 0)), traits: out };
}

function morale(save: Save, p: Obj, team: Obj | null): number {
  return moraleBreakdown(save, p, team).total;
}

function slotPeople(save: Save, team: Obj, job: number): Obj[] {
  return save.slots(team).filter((s) => s.jobType === job && s.personHired).map((s) => save.g.deref<Obj>(s.personHired));
}
const teamDrivers = (save: Save, team: Obj) => slotPeople(save, team, JOB.Driver);
const isMainDriver = (save: Save, d: Obj) => save.contract(d).mCurrentStatus !== RESERVE;

/** TeamStatistics.GetTeamStars: car 45 %, HQ 15 %, drivers 25 %, staff 15 %, as 0..5 stars. */
export function teamStars(save: Save, team: Obj): number {
  const g = save.g;
  // Car: the better car's six stats (each part sets its stat to stat + performance), over the main championship's season max.
  const carTotal = Math.max(0, ...save.cars(team).map((car) => {
    const stats: number[] = [0, 0, 0, 0, 0, 0];
    for (const p of g.list<Obj>(car.mCurrentPart ?? [])) {
      if (!p) continue;
      const s = g.deref<Obj>(p.mStats);
      if (s.statType >= 0 && s.statType < 6) stats[s.statType] = n(s.mStat ?? 0) + n(s.mPerformance ?? 0);
    }
    return Math.round(stats.reduce((a, b) => a + b, 0));
  }));
  const main = g.list<Obj>(save.data.championshipManager.mEntities).find((c) => c.championshipID === 0) ?? save.championship(team);
  const maxValues = g.deref<Obj>(main.rules).partStatSeasonMaxValue;
  const maxCar = (Array.isArray(maxValues) ? maxValues as Obj[] : []).reduce((s, kv) => s + n(kv.Value ?? 0), 0);

  // HQ: Headquarters.GetNormalizedRating, design and factory weigh 5, performance 2, the rest 1.
  let hq = 0, weights = 0;
  for (const b of save.buildings(team)) {
    const info = save.buildingInfo(b);
    const w = info.category === 0 || info.category === 1 ? 5 : info.category === 2 ? 2 : 1;
    const built = b.state === 2 || b.state === 3;
    hq += (built ? 0.4 + 0.6 * (b.currentLevel / Math.max(info.maxLevel, 1)) : 0) * w;
    weights += w;
  }

  const main2 = teamDrivers(save, team).filter((d) => isMainDriver(save, d));
  const drivers = main2.length ? main2.reduce((s, d) => s + abilities(save, d).ability, 0) / main2.length : 0;
  const tp = slotPeople(save, team, TEAM_PRINCIPAL_JOB)[0];
  const engineer = slotPeople(save, team, JOB.EngineerLead)[0];
  const mechanics = slotPeople(save, team, JOB.Mechanic);
  let staff = 0;
  if (tp && engineer && mechanics.length >= 2) {
    const tps = save.g.deref<Obj>(tp.stats);
    const tpAbility = (n(tps.raceManagement ?? 0) + n(tps.financial ?? 0) + n(tps.loyalty ?? 0)) / gameScale(save.game).principalAbilityDivisor * 5;
    staff = (tpAbility + abilities(save, mechanics[0]).ability + abilities(save, mechanics[1]).ability + abilities(save, engineer).ability) / 4;
  }
  const sum = clamp01(maxCar ? carTotal / maxCar : 0) * 0.45 + clamp01(weights ? hq / weights : 0) * 0.15
    + clamp01(drivers / 5) * 0.25 + clamp01(staff / 5) * 0.15;
  return clamp01(sum) * 5;
}

function careerTotal(save: Save, p: Obj, field: string): number {
  return save.g.list<Obj>(save.g.deref<Obj>(p.careerHistory).mCareer ?? []).reduce((s, e) => s + n(e?.[field] ?? 0), 0);
}

/** Mechanic.GetRelationshipAmmount for the driver's mechanic: the average over that mechanic's drivers. */
function mechanicRelationship(save: Save, team: Obj, d: Obj): number {
  const mech = slotPeople(save, team, JOB.Mechanic).find((m) => m.driver === d.mCarID);
  if (!mech) return 0;
  const drivers = teamDrivers(save, team).filter((x) => x.mCarID === mech.driver && isMainDriver(save, x));
  if (!drivers.length) return 0;
  return drivers.reduce((s, x) => s + clamp(n(mech.mDictDriversRelationships?.[x.name]?.relationshipAmount ?? 0) + traitSum(save, x, "mechanicModifier"), 0, 100), 0) / drivers.length;
}

/** Person.GetImprovementRateForAge. */
function improvementRateForAge(p: Obj, now: string, rate: number): number {
  const t = gameTime(now), peak = gameTime(p.peakAge);
  const years = new Date(t).getUTCFullYear() - new Date(peak).getUTCFullYear();
  if (t >= peak) return years <= n(p.peakDuration ?? 0) ? 0 : ((t - peak) / 86_400_000) * n(p.mImprovementRateDecay ?? 0);
  const y = new Date(t).getUTCFullYear();
  const yearDays = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  const days = (peak - t) / 86_400_000;
  return days < yearDays ? rate * (days / yearDays) : rate;
}

/** Driver.WantsToRetire: past the peak with the career goals met, or declining fast. */
function wantsToRetire(save: Save, d: Obj, now: string): boolean {
  const rate = improvementRateForAge(d, now, n(d.mImprovementRate ?? 0) + traitSum(save, d, "improveabilityModifier"));
  const wins = Math.max(0, n(d.mDesiredWins ?? 0) + Math.round(traitSum(save, d, "desiredWinsModifier")));
  const goals = careerTotal(save, d, "championships") >= n(d.desiredChampionships ?? 0)
    && careerTotal(save, d, "wins") >= wins
    && n(save.contract(d).yearlyWages) >= n(d.desiredBudget ?? 0);
  return (goals && rate < 0) || rate < -2;
}

function rivalOf(save: Save, d: Obj): Obj | null {
  const r = d.mDriverRivalries ? save.g.deref<Obj>(d.mDriverRivalries) : null;
  const rival = r?.mRivalDriver ?? r?.currentRival;
  return rival ? save.g.deref<Obj>(rival) : null;
}

/**
 * MM's renewal terms for one person at their own team: whether they'd talk, the wage MM's AI would
 * offer, the sign-on fee they want and the length they'd like.
 */
export function renewalTerms(save: Save, team: Obj, p: Obj): Omit<ContractRenewal, "slotID"> {
  const now = save.now;
  const kind = personKind(p);
  const isDriver = kind === "Driver";
  const c = save.contract(p);
  const ch = save.championship(team);
  const player = save.data.player.stats ?? {};
  const loyalty = n(player.loyalty ?? 0), financial = n(player.financial ?? 0);
  const { ability, abilityPotential, potential } = abilities(save, p);
  const stars = teamStars(save, team);
  const years = age(p.dateOfBirth, now);
  const wins = careerTotal(save, p, "wins");
  const main = isDriver && isMainDriver(save, p);
  const m = morale(save, p, team);
  const marketability = isDriver ? driverStats(save, p).marketability : 0;

  // GetNegotiationWeightForTargetPerson (RenewDriver / RenewStaff); MM's random term is 0 here.
  const parts = isDriver
    ? [
      ability - stars, lookup(EXISTING_DRIVER_AGE, years), lookup(EXISTING_DRIVER_MORALE, Math.round(m * 100)),
      main ? 0 : -3, Math.floor(wins * 0.06), Math.floor(marketability * 100 * 0.08),
      years < 24 ? (ability - stars) * 2 : 0, -Math.floor(loyalty / 8), -Math.floor(financial / 8),
      main ? -mechanicRelationship(save, team, p) * 0.05 : 0, potential * 0.06,
    ]
    : [ability - stars, lookup(EXISTING_STAFF_AGE, years), Math.floor(wins * 0.18), -Math.floor(loyalty / 2), -Math.floor(financial / 2), potential * 0.06];
  const weight = clamp(parts.reduce((a, b) => a + b, 0), -5, 5);
  const t = (weight + 5) / 10;

  // CalculateDesiredWage, in $; the Endurance series pays half.
  const scale = 1_000_000 * (ch.series === 2 ? 0.5 : 1);
  const curve = WAGE_CURVE[kind] ?? WAGE_CURVE.Mechanic;
  const lo = Math.floor(ability), hi = Math.ceil(ability);
  let base = lerp(curve[lo] ?? curve.at(-1)!, curve[hi] ?? curve.at(-1)!, ability - lo);
  if (isDriver) base += Math.max(0, n(p.mDesiredEarnings ?? 0) + traitSum(save, p, "desiredEarningsModifier")) / scale;
  const desired = (base + base * lerp(-0.35, 0.35, t) + base * (abilityPotential / 5) * 0.1) * scale;
  const baseWage = base * scale;

  // TeamAIController.CalculateYearlyWage: what MM's AI offers, never less than they earn now (within a step).
  const current = n(c.yearlyWages);
  let max = baseWage * 1.5;
  if (max < current) max = current * 1.1;
  const step = (max - baseWage * 0.5) / 10;
  let asking: number;
  if (current - desired > step) asking = current;
  else {
    const want = Math.max(desired, current);
    if (want < baseWage) asking = want + step;
    else {
      let w = baseWage + Math.ceil((want - baseWage) / step) * step;
      if (w - want <= step * 0.5) w += step;
      asking = Math.min(w, max);
    }
  }

  // CalculateDesiredSignOnFee: wanted above a weight of −2, from the stars' fee table.
  const range = (v: number) => (v < -3 ? 3 : v < 0 ? 2 : v < 4 ? 1 : 0);
  const fees = (SIGN_ON[kind] ?? SIGN_ON.Mechanic)[clamp(Math.round(ability) - 1, 0, 4)];
  const signOnFee = weight > -2 ? fees[range(weight - 1)] * scale : 0;

  // CalculateDesiredContractLength: Short / Medium / Long as 1 / 2 / 3 seasons.
  let length: number;
  if (isDriver) {
    const w = weight - 1;
    length = years < 24 && (ability - stars) * 2 > 2 ? 1 : w < -1 ? 3 : w < 3 ? 2 : 1;
  } else {
    const w = weight - 4;
    length = w < -1 ? 3 : w < 2 ? 2 : 1;
  }

  const ans = answer(save, team, p, { ability, stars, years, morale: m, marketability, loyalty, financial, main });
  const mb = isDriver ? moraleBreakdown(save, p, team) : undefined;
  return {
    guid: p.id, name: personName(p), kind, wage: current, end: c.mEndDate, monthsLeft: monthsRemaining(c.mEndDate, now),
    askingWage: Math.round(asking / 1000) * 1000, signOnFee: Math.round(signOnFee / 1000) * 1000, preferredYears: length,
    refusal: ans.key ? REFUSALS[ans.key] : null,
    why: { key: ans.key, ...(mb ? { morale: mb } : {}), ...(ans.score ? { score: ans.score } : {}), tips: tips(ans, mb, { morale: m, main, ability, stars }, isDriver) },
  };
}

/** Person.GetInterestedToTalkReaction for a renewal at an AI-run team; null when they'll talk. */
type RefusalKey = keyof typeof REFUSALS;
interface Answer { key: RefusalKey | null; score?: RenewalReason["score"]; rival?: string }

/** MM's age table: the bands of EXISTING_DRIVER_AGE as the site words them. */
const pct = (v: number) => Math.round(v * 100);

/**
 * Person.GetInterestedToTalkReaction for a renewal, in MM's order, then CalculateWantsToTalk
 * (RenewDriver / RenewStaff) with its parts.
 */
function answer(save: Save, team: Obj, p: Obj, x: {
  ability: number; stars: number; years: number; morale: number; marketability: number; loyalty: number; financial: number; main: boolean;
}): Answer {
  const isDriver = personKind(p) === "Driver";
  const ch = save.championship(team);
  if (n(p.retirementAge ?? 0) > 0) return { key: "retired" };
  if (isDriver && !p.mJoinsAnySeries && !save.g.list<number>(p.mDriverPreferedSeries ?? []).includes(ch.series)) return { key: "series" };
  if (isDriver && wantsToRetire(save, p, save.now)) return { key: "retiring" };
  if (n(ch.championshipOrder ?? 0) > DESIRED_CHAMPIONSHIP[clamp(Math.floor(x.ability), 0, 5)]) return { key: "higher" };
  const others = teamDrivers(save, team).filter((d) => d !== p);
  if (isDriver) {
    const rival = rivalOf(save, p);
    const rivalHere = !!rival && others.includes(rival);
    if (hasSpecialCase(save, p, WILL_NOT_RENEW) && rivalHere) return { key: "wontRenew", rival: personName(rival!) };
    if (hasSpecialCase(save, p, WILL_NOT_JOIN_RIVAL) && rivalHere) return { key: "rival", rival: personName(rival!) };
    const hater = others.find((d) => hasSpecialCase(save, d, WILL_NOT_JOIN_RIVAL) && rivalOf(save, d) === p);
    if (hater) return { key: "rival", rival: personName(hater) };
    if (x.morale <= 0.2) return { key: "morale" };
  }
  // CalculateWantsToTalk (RenewDriver / RenewStaff). Staff use the drivers' age table, as MM does.
  const tooOld = isDriver ? x.years > 44 : x.years > 55;
  const parts = tooOld ? [{ label: `Age ${x.years} (MM's limit is ${isDriver ? 44 : 55})`, value: 10 }]
    : isDriver ? [
      { label: `Morale ${pct(x.morale)}`, value: lookup(EXISTING_DRIVER_MORALE, Math.round(x.morale * 100)) },
      { label: `Age ${x.years}`, value: lookup(EXISTING_DRIVER_AGE, x.years) },
      { label: x.main ? "Race driver" : "Reserve driver", value: x.main ? 0 : -3 },
      { label: `Marketability ${pct(x.marketability)}`, value: Math.floor(x.marketability * 100 * 0.08) },
      { label: `Career manager's loyalty ${x.loyalty.toFixed(1)}`, value: -Math.floor(x.loyalty / 8) || 0 },
      { label: `Career manager's finances ${x.financial.toFixed(1)}`, value: -Math.floor(x.financial / 8) || 0 },
    ] : [
      { label: `Age ${x.years}`, value: lookup(EXISTING_DRIVER_AGE, x.years) },
      { label: `Their stars ${x.ability.toFixed(1)} against the team's ${x.stars.toFixed(1)}`, value: x.ability - x.stars },
      { label: `Career manager's loyalty ${x.loyalty.toFixed(1)}`, value: -Math.floor(x.loyalty / 2) || 0 },
      { label: `Career manager's finances ${x.financial.toFixed(1)}`, value: -Math.floor(x.financial / 2) || 0 },
    ];
  const threshold = isDriver ? 3 : 1;
  const total = parts.reduce((a, b) => a + b.value, 0);
  return { key: total < threshold ? null : "notInterested", score: { total, threshold, parts } };
}

const fmtPts = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v * 100))}`;

/** What would change MM's answer, in MM's own terms. */
function tips(a: Answer, morale: RenewalReason["morale"] | undefined, x: { morale: number; main: boolean; ability: number; stars: number }, isDriver: boolean): string[] {
  const out: string[] = [];
  const moraleWays = "Morale rises after sessions where they beat the position MM expects of them (at most +20 a weekend, so a win " +
    "helps little if they were expected near the front), and by +40 when they get a better contract status or are promoted from reserve.";
  switch (a.key) {
    case "morale": {
      out.push(`MM won't even talk while morale is 20 or lower; it's ${pct(x.morale)}.`);
      for (const t of (morale?.traits ?? []).filter((t) => t.value < 0)) {
        const src = t.via ? `${t.via}'s ${t.name}` : t.name;
        if (t.temporary) out.push(`${src} (${fmtPts(t.value)}) is temporary${t.until ? ` and ends on ${t.until.slice(0, 10)}` : ""}.`);
        else if (t.condition) out.push(`${src} (${fmtPts(t.value)}) only counts ${t.condition}: change that and it goes.`);
        else out.push(`${src} (${fmtPts(t.value)}) is permanent.`);
      }
      out.push(moraleWays);
      break;
    }
    case "notInterested": {
      const sc = a.score!;
      const need = sc.total - (sc.threshold - 1);
      out.push(`MM's score is ${sc.total.toFixed(1)}; they talk below ${sc.threshold}, so it has to drop by ${need.toFixed(1)}.`);
      if (isDriver && sc.parts[0].label.startsWith("Morale")) {
        const now = sc.parts[0].value;
        const band = EXISTING_DRIVER_MORALE.find(([, v]) => now - v >= need);
        if (band) {
          const from = EXISTING_DRIVER_MORALE[EXISTING_DRIVER_MORALE.indexOf(band) - 1]?.[0] ?? 0;
          out.push(`Morale of ${from} or more would be enough (now ${pct(x.morale)}).`);
        } else out.push("Even top morale wouldn't be enough on its own.");
        out.push(moraleWays);
        if (x.main && need <= 3) out.push("As the reserve driver the score would be 3 lower: MM's reserves are keener to stay.");
      }
      if (!isDriver) out.push("Each star your team gains takes 1 off: the car, HQ, drivers and staff make up MM's team rating.");
      out.push("Marketable drivers want to test the market, and the career manager's loyalty and finances (MM uses the organizer's for every team) only help in steps of 8.");
      break;
    }
    case "retiring": out.push("Past their peak and declining, or with their career goals met (wins, titles, wage): MM won't renew them."); break;
    case "retired": out.push("Retired: they won't race again."); break;
    case "series": out.push("They only race in other series, so MM won't renew them here."); break;
    case "higher": out.push(`At ${x.ability.toFixed(1)} stars they want a higher championship.`); break;
    case "wontRenew": case "rival": out.push(`Changes if ${a.rival ?? "their rival"} leaves the team.`); break;
    default: break;
  }
  if (a.key) out.push("MM's answer is worked out again at every publish.");
  return out;
}

/**
 * Staff whose contract ends within 12 months (MM won't renew earlier, TooEarlyToRenew), with MM's
 * terms. Drivers, the lead engineer and mechanics, as the site manages them.
 */
export function teamRenewals(save: Save, team: Obj): ContractRenewal[] {
  return save.slots(team)
    .filter((s) => s.personHired && [JOB.Driver, JOB.EngineerLead, JOB.Mechanic].includes(s.jobType))
    .map((s) => ({ slotID: s.slotID as number, p: save.g.deref<Obj>(s.personHired) }))
    .filter(({ p }) => monthsRemaining(save.contract(p).mEndDate, save.now) < 12)
    .map(({ slotID, p }) => ({ slotID, ...renewalTerms(save, team, p) }));
}

export interface RenewContractOp {
  op: "renewContract";
  team: string | number;
  /** The person's GUID. */
  person: string;
  yearlyWages: number;
  /** C# date the new contract ends. */
  endDate: string;
  /** The end date the order was placed against; the renewal is refused if the contract changed since. */
  expectedEnd?: string;
  signOnFee?: number;
}

/**
 * ContractManagerTeam.RenewContractForPerson, done in place: new wage, start and end, the
 * contract-end event moved to the new date, and a driver's morale boost for signing. The sign-on
 * fee is a separate `adjustBudget`, as MM's AI pays it as its own transaction.
 */
export function renewContract(save: Save, op: RenewContractOp): string {
  const team = save.team(op.team);
  const p = save.person(op.person);
  if (save.employer(p) !== team) throw new Error(`${personName(p)} doesn't work for ${team.name}`);
  const c = save.contract(p);
  if (op.expectedEnd && c.mEndDate !== op.expectedEnd) {
    throw new Error(`${personName(p)}'s contract changed since the order (ends ${String(c.mEndDate).slice(0, 10)}, expected ${op.expectedEnd.slice(0, 10)})`);
  }
  if (op.endDate <= c.mEndDate) throw new Error(`${personName(p)}: the new end ${op.endDate.slice(0, 10)} isn't after the current one`);
  const years = new Date(gameTime(op.endDate)).getUTCFullYear() - new Date(gameTime(save.now)).getUTCFullYear();
  c.yearlyWages = Math.round(op.yearlyWages);
  c.startDate = save.now;
  c.mEndDate = op.endDate;
  c.length = clamp(years - 1, 0, 2); // ContractLength Short/Medium/Long
  c.hasSignOnFee = !!op.signOnFee;
  c.signOnFee = Math.round(op.signOnFee ?? 0);

  if (c.mCalendarEvent) {
    const ev = save.g.deref<Obj>(c.mCalendarEvent);
    const list = delayedEvents(save);
    const i = list.findIndex((e) => save.g.deref(e) === ev);
    if (i >= 0) list.splice(i, 1);
    ev.triggerDate = op.endDate;
    ev.triggerCacheDayDate = op.endDate.slice(0, 10) + "T00:00:00.0000000";
    insertByDate(save, ev, op.endDate);
    c.mCalendarEvent = save.g.ref(ev);
  }
  // Driver.UpdateMoraleOnContractSigned.
  if (personKind(p) === "Driver" && p.moraleSignedContractBonus != null) {
    p.mMorale = float(clamp01(n(p.mMorale ?? 0) + n(p.moraleSignedContractBonus)));
  }
  return `${team.name}: renewed ${personName(p)} at $${c.yearlyWages.toLocaleString()}/yr until ${op.endDate.slice(0, 10)}`;
}
