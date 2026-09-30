// League auction rules, for showing prices on the website. The database enforces the same rules
// (supabase/migrations/002_auctions.sql), and test/db.test.ts checks that both agree.
// It imports only types from league-types.ts, so the website can import it directly.

import type { Person } from "./league-types.ts";

export interface LeagueSettings {
  sign_on_fee_pct: number;
  min_increment_pct: number;
  min_wage_base: Record<string, number>;
  min_wage_exponent: number;
  min_wage_floor: number;
  max_contract_years: number;
  /** Multiplier on MM's HQ build times; 1 is the game's own duration. */
  hq_speed: number;
}

export const DEFAULT_SETTINGS: LeagueSettings = {
  sign_on_fee_pct: 0.25,
  min_increment_pct: 0.05,
  min_wage_base: { Driver: 1_500_000, Engineer: 250_000, Mechanic: 300_000 },
  min_wage_exponent: 2,
  min_wage_floor: 50_000,
  max_contract_years: 3,
  hq_speed: 1,
};

const DAY = 86_400_000;
/** Game dates look like "2016-08-11T06:00:00.0000000"; read them as UTC. */
const gameTime = (d: string) => Date.parse(d.slice(0, 19) + "Z");

export function statAverage(p: Pick<Person, "stats">): number {
  const v = Object.values(p.stats).filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

/** Opening price of an auction. */
export function minWage(p: Pick<Person, "stats" | "kind">, s: LeagueSettings): number {
  const base = s.min_wage_base[p.kind] ?? 0;
  return Math.max(s.min_wage_floor, roundTo(base * (statAverage(p) / 10) ** s.min_wage_exponent, 10_000));
}

/** The lowest next bid: the opening price, or the leader plus the step, rounded up to $1K. */
export function nextMinBid(minWageValue: number, leadingWage: number | null, s: LeagueSettings): number {
  return leadingWage == null ? minWageValue : Math.ceil((leadingWage * (1 + s.min_increment_pct)) / 1000) * 1000;
}

/** Remaining contract value of someone under contract at an AI team. */
export function buyout(p: Pick<Person, "contract">, gameDate: string): number {
  const years = (gameTime(p.contract.end) - gameTime(gameDate)) / (365.25 * DAY);
  return roundTo(Math.max(0, p.contract.yearlyWages * years), 1000);
}

/** Fraction of the game year left; contracts and seasons end on 31 December. */
export function seasonLeft(gameDate: string): number {
  const t = gameTime(gameDate);
  const end = Date.UTC(new Date(t).getUTCFullYear(), 11, 31);
  return Math.max(0, (end - t) / (365 * DAY));
}

export interface BidCost {
  signOnFee: number;
  buyout: number;
  /** Extra wage over the replaced person for the rest of this season. */
  seasonWages: number;
  total: number;
}

/** What a bid commits from the budget. Mirrors public.bid_cost. */
export function bidCost(wage: number, buyoutValue: number, replacingWage: number, gameDate: string, s: LeagueSettings): BidCost {
  const signOnFee = wage * s.sign_on_fee_pct;
  const seasonWages = Math.max(0, wage - replacingWage) * seasonLeft(gameDate);
  return { signOnFee, buyout: buyoutValue, seasonWages, total: Math.round(signOnFee + buyoutValue + seasonWages) };
}

/** C# date for a contract of `years` seasons signed in the game year of `gameDate`. */
export function contractEnd(gameDate: string, years: number): string {
  return `${new Date(gameTime(gameDate)).getUTCFullYear() + years - 1}-12-31T00:00:00.0000000`;
}

type HqBuilding = {
  type: number; level: number; state: string; maxLevel: number; initialCost: number | null; upgradeCosts: (number | null)[];
  buildWeeks: number; upgradeWeeks: number[]; progressStart: string;
}

/** Level the team really has: a building under construction isn't built yet. */
export const ownedLevel = (b: Pick<HqBuilding, "state" | "level">) => (b.state === "BuildingInProgress" ? 0 : b.level);

/** Level a construction in progress is heading to. */
export const targetLevel = (b: Pick<HqBuilding, "state" | "level">) => (b.state === "BuildingInProgress" ? 1 : b.level + 1);

/**
 * A construction on a member team that the league didn't order: the in-game AI started it
 * after the league began. `pull` cancels and refunds these, so the member may order it anew.
 */
export function unorderedProject(b: HqBuilding, applied: { building_type: number; to_level: number }[], leagueStart: string | null) {
  if (b.state !== "BuildingInProgress" && b.state !== "Upgrading") return false;
  if (!leagueStart || b.progressStart <= leagueStart) return false;
  return !applied.some((o) => o.building_type === b.type && o.to_level === targetLevel(b));
}

/**
 * Cost and MM build time of a building's next step, or null at max level / not buildable /
 * under construction. `unordered` treats an AI-started construction as not started.
 */
export function nextHqStep(b: Omit<HqBuilding, "type" | "progressStart">, unordered = false) {
  if ((b.state === "BuildingInProgress" || b.state === "Upgrading") && !unordered) return null;
  const level = ownedLevel(b);
  if (level >= b.maxLevel) return null;
  const cost = level === 0 ? b.initialCost : b.upgradeCosts[level - 1];
  const weeks = level === 0 ? b.buildWeeks : b.upgradeWeeks[level - 1];
  if (cost == null || !weeks) return null;
  return { toLevel: level + 1, cost, weeks };
}
