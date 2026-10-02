// Pit crew: the league's site-run crew for member teams. In MM only the player's career team has
// crew people; AI teams (so every member team) have an AIPitCrew with one skill and confidence per
// pit stop task. The site keeps a full MM-style crew, and before each race the toolkit writes the
// assigned crew's skills into those per-task values, which MM's pit stop simulation reads.
// On plain data so the site, the database tests and the toolkit agree. No imports: the site
// bundles this file.

/**
 * A seeded number in [0, 1): FNV-1a with a murmur3 finalizer. (politics.ts' `roll` correlates
 * keys that differ only at the end, which made neighbouring crew members look alike.)
 */
export function roll(...keys: (string | number)[]): number {
  let h = 2166136261;
  for (const ch of keys.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** PitCrewMember.PitCrewRole, by value (0..9); 11 is a reserve. */
export const CREW_ROLES = [
  "FrontJack", "RearJack", "FrontLeftWheel", "FrontRightWheel", "RearLeftWheel", "RearRightWheel",
  "FrontLeftFixing", "FrontRightFixing", "RearLeftRefueling", "RearRightRefueling",
] as const;
export const RESERVE = 11;
export const ROLE_NAMES = [
  "Front jack", "Rear jack", "Front left wheel", "Front right wheel", "Rear left wheel", "Rear right wheel",
  "Front left fixing", "Front right fixing", "Rear left refuelling", "Rear right refuelling",
];

/** PitCrewMemberStats.PitCrewStatType. */
export const CREW_STATS = ["Tyres", "FrontJack", "RearJack", "FixingParts", "Refuelling"] as const;
export const STAT_NAMES = ["Tyres", "Front jack", "Rear jack", "Fixing parts", "Refuelling"];
/** PitCrewMember.GetActiveStatType: the skill each position uses. */
export const ROLE_STAT = [1, 2, 0, 0, 0, 0, 3, 3, 4, 4];

/** ChampionshipRules.PitStopCrewSize. */
export const CREW_SIZES = ["Small", "Large", "SemiSequential"] as const;
export type CrewSize = (typeof CREW_SIZES)[number];

/** PitCrewController.IsPitCrewRoleAllowedInSeries: jacks and wheels; Large adds fixing, and refuelling where it's on. */
export function activeRoles(size: CrewSize, refuelling: boolean): number[] {
  if (size !== "Large") return [0, 1, 2, 3, 4, 5];
  return refuelling ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [0, 1, 2, 3, 4, 5, 6, 7];
}

/**
 * SessionSetupChangeEntry.Target (the index into AIPitCrew task stats) and the positions doing
 * that task (SessionPitstopTask.GetStatTypeBasedOnTarget + PitCrewMember.IsAssignedToTask).
 * Driver change (6) has no crew.
 */
export const TASKS = [
  { target: 0, name: "Fuel", roles: [8, 9], stat: 4 },
  { target: 1, name: "Tyres", roles: [2, 3, 4, 5], stat: 0 },
  { target: 2, name: "Parts repair", roles: [6, 7], stat: 3 },
  { target: 3, name: "Front jack", roles: [0], stat: 1 },
  { target: 4, name: "Rear jack", roles: [1], stat: 2 },
  { target: 5, name: "Battery recharge", roles: [8, 9], stat: 4 },
];

export const FUNDING = [
  { name: "Low", cost: 0, training: 0.1 },
  { name: "Medium", cost: 50_000, training: 0.25 },
  { name: "High", cost: 120_000, training: 0.45 },
];

export const CREW_SETTINGS = {
  /** Crew people a team may have (active and reserves). */
  maxCrew: 15,
  /** Reserves in the starting crew. */
  startingReserves: 4,
  applicants: 8,
  /** An applicant stays on the list this many races. */
  applicantRaces: 2,
  /** PitCrewDesignData.contractSignOnFee, as in Tatra's transactions. */
  signOnFee: 45_000,
  /** ContractPitCrew.canRenewContract: fewer races left than this. */
  renewBelow: 12,
  /** Confidence lost by a crew member blamed for a pit stop mistake, and regained per clean race. */
  mistakeConfidence: 0.08,
  cleanRaceConfidence: 0.03,
  minConfidence: 0.3,
  /** Crew this old don't renew; they leave when their contract ends. */
  retireAge: 38,
  statMax: 20,
};

/** A crew person as the site keeps them. Dates are ISO (YYYY-MM-DD). */
export interface CrewPerson {
  firstName: string;
  lastName: string;
  nationality: string;
  birth: string;
  /** After this date they lose `decline` of every skill per race. */
  peak: string;
  /** By CREW_STATS. */
  stats: number[];
  confidence: number;
  maxConfidence: number;
  decline: number;
}

export interface CrewMember extends CrewPerson {
  id?: number;
  /** 0..9 a position, RESERVE on the bench. */
  role: number;
  /** Per race. */
  wage: number;
  racesLeft: number;
}

export interface Applicant extends CrewPerson {
  id?: number;
  wage: number;
  /** Races until the application lapses. */
  racesLeft: number;
}

/** Names to build people from: first and last names by nationality, from the save's people. */
export type NamePool = Record<string, { first: string[]; last: string[] }>;

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function age(birth: string, date: string): number {
  const b = new Date(birth.slice(0, 10)), d = new Date(date.slice(0, 10));
  let a = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) a--;
  return a;
}

export const isRetiring = (p: CrewPerson, date: string) => age(p.birth, date) >= CREW_SETTINGS.retireAge;
export const pastPeak = (p: CrewPerson, date: string) => date.slice(0, 10) > p.peak;

/** The skill a crew member uses in a position. */
export const roleSkill = (p: CrewPerson, role: number) => (role === RESERVE ? Math.max(...p.stats) : p.stats[ROLE_STAT[role]]);

/** Stars out of 5 for a skill (MM shows crew ability as stars). */
export const stars = (skill: number) => clamp(Math.round((skill / CREW_SETTINGS.statMax) * 10) / 2, 0, 5);

/**
 * Wage per race. MM prices crew by ability stars (PitCrewContractPerRaceCosts); from Tatra's crew
 * and applicants it comes to about $1K per point of average skill above 2, between $3K and $10K.
 */
export function perRaceWage(stats: number[]): number {
  const avg = stats.reduce((s, x) => s + x, 0) / stats.length;
  return clamp(Math.round(avg) - 2, 3, 10) * 1000;
}

/** ContractPitCrew.SignContract: twice the season's races, plus one. */
export const contractRaces = (raceCount: number) => 2 * raceCount + 1;

function pick<T>(list: T[], r: number): T {
  return list[Math.min(list.length - 1, Math.floor(r * list.length))];
}

function addMonths(iso: string, months: number): string {
  const d = new Date(iso.slice(0, 10));
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/** Someone's identity and age: a name from one nationality of the pool. */
function identity(seed: (string | number)[], names: NamePool, gameDate: string, ageRange: [number, number]) {
  const nats = Object.keys(names).sort();
  const nationality = pick(nats, roll(...seed, "nat"));
  const pool = names[nationality];
  const years = ageRange[0] + roll(...seed, "age") * (ageRange[1] - ageRange[0]);
  const birth = addMonths(gameDate, -Math.round(years * 12));
  return {
    firstName: pick(pool.first, roll(...seed, "first")),
    lastName: pick(pool.last, roll(...seed, "last")),
    nationality,
    birth,
    // PitCrewDesignData min/max months before peak age; MM's crew peak around 29-36.
    peak: addMonths(birth, Math.round((29 + roll(...seed, "peak") * 7) * 12)),
  };
}

/**
 * Skills around `level`: the specialty (if any) at full level, the others lower, as MM's crew and
 * applicants look (one or two strong skills).
 */
function skills(seed: (string | number)[], level: number, specialty: number | null): number[] {
  return CREW_STATS.map((_, i) => {
    const r = roll(...seed, "stat", i);
    const v = i === specialty ? level * (0.95 + 0.15 * r) : level * (0.25 + 0.6 * r);
    return round2(clamp(v, 0, CREW_SETTINGS.statMax));
  });
}

function confidence(seed: (string | number)[]) {
  const c = round2(0.75 + 0.24 * roll(...seed, "conf"));
  // PitCrewMember.mStatsLostPerRaceAfterPeak is ~1.1 (%) in Tatra's crew.
  return { confidence: c, maxConfidence: c, decline: Math.round((0.008 + 0.007 * roll(...seed, "decline")) * 10000) / 10000 };
}

/**
 * A member team's starting crew. Every team gets the same skills, ages and contracts (the user's
 * "equal for everyone"); only names differ. `level` is the series' average pit stop skill (its
 * mechanics' Pit stops stat), so member crews start at the field's average.
 */
export function startingCrew(series: string, team: string, level: number, roles: number[], names: NamePool, gameDate: string, raceCount: number): CrewMember[] {
  const people: CrewMember[] = [];
  const n = Math.min(CREW_SETTINGS.maxCrew, roles.length + CREW_SETTINGS.startingReserves);
  for (let i = 0; i < n; i++) {
    const tpl = [series, "starting-crew", i];
    const role = i < roles.length ? roles[i] : RESERVE;
    const specialty = role === RESERVE ? Math.floor(roll(...tpl, "spec") * CREW_STATS.length) : ROLE_STAT[role];
    const stats = skills(tpl, role === RESERVE ? level * 0.85 : level, specialty);
    const id = identity([series, team, "starting-crew", i], names, gameDate, [24, 24]);
    // Same age and peak for every team: take them from the template, not the team.
    const t = identity(tpl, names, gameDate, [21, 31]);
    people.push({
      ...id, birth: t.birth, peak: t.peak, stats, ...confidence(tpl),
      role, wage: perRaceWage(stats), racesLeft: contractRaces(raceCount),
    });
  }
  return people;
}

/** One applicant, seeded by team and the round it appears. */
export function newApplicant(seed: (string | number)[], names: NamePool, gameDate: string): Applicant {
  const level = 4 + roll(...seed, "level") * 11;
  const specialty = Math.floor(roll(...seed, "spec") * CREW_STATS.length);
  const stats = skills(seed, level, specialty);
  return {
    ...identity(seed, names, gameDate, [19, 33]), stats, ...confidence(seed),
    wage: perRaceWage(stats), racesLeft: CREW_SETTINGS.applicantRaces,
  };
}

/** Top a team's applicant list up to CREW_SETTINGS.applicants. */
export function refillApplicants(list: Applicant[], series: string, team: string, round: number, names: NamePool, gameDate: string): Applicant[] {
  const out = [...list];
  for (let k = 0; out.length < CREW_SETTINGS.applicants; k++) out.push(newApplicant([series, team, "applicant", round, k], names, gameDate));
  return out;
}

/** PitCrewController.FillUpEmptyRoles: each empty position gets the reserve best at it. */
export function fillEmptyRoles(crew: CrewMember[], roles: number[]): CrewMember[] {
  const out = crew.map((c) => ({ ...c }));
  for (const role of roles) {
    if (out.some((c) => c.role === role)) continue;
    const bench = out.filter((c) => c.role === RESERVE || !roles.includes(c.role));
    if (!bench.length) continue;
    bench.sort((a, b) => b.stats[ROLE_STAT[role]] - a.stats[ROLE_STAT[role]]);
    bench[0].role = role;
  }
  return out;
}

/** PitCrewController.AssignRoleToPitCrewMember: whoever holds the position swaps with them. */
export function assignRole(crew: CrewMember[], id: number, role: number): CrewMember[] {
  const who = crew.find((c) => c.id === id);
  if (!who) return crew;
  const from = who.role;
  return crew.map((c) => (c.id === id ? { ...c, role } : role !== RESERVE && c.role === role ? { ...c, role: from } : c));
}

export interface SpendLine { kind: "wages" | "funding" | "signon"; description: string; amount: number }

export interface RaceInput {
  series: string;
  team: string;
  /** The race just run (1-based) and its date. */
  round: number;
  gameDate: string;
  /** Pit stop mistakes MM logged for this team in that race. */
  mistakes: number;
  funding: number;
  roles: number[];
  crew: CrewMember[];
  applicants: Applicant[];
  names: NamePool;
}

export interface RaceOutcome {
  crew: CrewMember[];
  applicants: Applicant[];
  left: { name: string; reason: "contract ended" | "retired" }[];
  spend: SpendLine[];
}

/**
 * What one race does to a member crew (PitCrewController.OnRaceWeekendEnd and friends, with the
 * league's choices): pay wages and funding, count contracts down, train the crew in positions
 * (by funding), age those past their peak, blame mistakes on positions, refill empty positions
 * and the applicant list.
 */
export function crewAfterRace(i: RaceInput): RaceOutcome {
  const s = CREW_SETTINGS;
  const funding = FUNDING[i.funding] ?? FUNDING[1];
  const spend: SpendLine[] = [];
  const wages = i.crew.reduce((sum, c) => sum + c.wage, 0);
  if (wages) spend.push({ kind: "wages", description: `Pit crew wages (round ${i.round})`, amount: wages });
  if (funding.cost) spend.push({ kind: "funding", description: `Pit crew funding: ${funding.name} (round ${i.round})`, amount: funding.cost });

  // Mistakes: MM's log doesn't say who, so each one falls on a random crew member in a position.
  const active = i.crew.filter((c) => i.roles.includes(c.role));
  const blamed = new Map<CrewMember, number>();
  for (let k = 0; k < i.mistakes && active.length; k++) {
    const who = pick(active, roll(i.series, i.team, "mistake", i.round, k));
    blamed.set(who, (blamed.get(who) ?? 0) + 1);
  }

  const left: RaceOutcome["left"] = [];
  let crew: CrewMember[] = [];
  for (const c0 of i.crew) {
    const c = { ...c0, stats: [...c0.stats], racesLeft: c0.racesLeft - 1 };
    if (c.racesLeft <= 0) {
      left.push({ name: `${c.firstName} ${c.lastName}`, reason: isRetiring(c, i.gameDate) ? "retired" : "contract ended" });
      continue;
    }
    if (i.roles.includes(c.role)) {
      const k = ROLE_STAT[c.role];
      c.stats[k] = round2(Math.min(s.statMax, c.stats[k] + funding.training));
    }
    if (pastPeak(c, i.gameDate)) c.stats = c.stats.map((v) => round2(v * (1 - c.decline)));
    const m = blamed.get(c0) ?? 0;
    c.confidence = round2(m
      ? Math.max(s.minConfidence, c.confidence - m * s.mistakeConfidence)
      : Math.min(c.maxConfidence, c.confidence + s.cleanRaceConfidence));
    crew.push(c);
  }
  crew = fillEmptyRoles(crew, i.roles);

  const applicants = refillApplicants(
    i.applicants.map((a) => ({ ...a, racesLeft: a.racesLeft - 1 })).filter((a) => a.racesLeft > 0),
    i.series, i.team, i.round, i.names, i.gameDate,
  );
  return { crew, applicants, left, spend };
}

/** Per race: everyone's wage plus funding. */
export const perRaceCost = (crew: Pick<CrewMember, "wage">[], funding: number) =>
  crew.reduce((s, c) => s + c.wage, 0) + (FUNDING[funding]?.cost ?? 0);

/**
 * The AIPitCrew task values this crew gives (both cars): per task, the average skill and
 * confidence of the people in its positions. Tasks nobody does in this series are left out, so
 * MM keeps its own value there.
 */
export function taskStats(crew: CrewMember[], roles: number[]) {
  return TASKS.flatMap((t) => {
    const people = crew.filter((c) => t.roles.includes(c.role) && roles.includes(c.role));
    if (!people.length) return [];
    const avg = (f: (c: CrewMember) => number) => people.reduce((s, c) => s + f(c), 0) / people.length;
    return [{ target: t.target, name: t.name, stat: round2(avg((c) => c.stats[t.stat])), confidence: round2(avg((c) => c.confidence)) }];
  });
}

// ---------------------------------------------------------------------------------------------
// Database rows (snake_case) for the toolkit and the site.

/** A pit_crew / pit_crew_applicants row (snake_case, as the database has it). */
export interface CrewPersonRow {
  id?: number;
  team?: string;
  first_name: string;
  last_name: string;
  nationality: string;
  birth: string;
  peak: string;
  stats: number[];
  confidence: number;
  max_confidence: number;
  decline: number;
  wage: number | string;
  races_left: number;
}
export interface CrewRow extends CrewPersonRow { role: number }

const personRow = (p: CrewPerson & { id?: number; wage: number; racesLeft: number }): CrewPersonRow => ({
  ...(p.id != null ? { id: p.id } : {}),
  first_name: p.firstName, last_name: p.lastName, nationality: p.nationality, birth: p.birth, peak: p.peak,
  stats: p.stats, confidence: p.confidence, max_confidence: p.maxConfidence, decline: p.decline, wage: p.wage, races_left: p.racesLeft,
});
export const crewRow = (c: CrewMember): CrewRow => ({ ...personRow(c), role: c.role });
export const applicantRow = (a: Applicant): CrewPersonRow => personRow(a);

const person = (r: CrewPersonRow) => ({
  id: r.id, firstName: r.first_name, lastName: r.last_name, nationality: r.nationality, birth: String(r.birth).slice(0, 10),
  peak: String(r.peak).slice(0, 10), stats: r.stats.map(Number), confidence: Number(r.confidence), maxConfidence: Number(r.max_confidence),
  decline: Number(r.decline), wage: Number(r.wage), racesLeft: r.races_left,
});
export const crewMember = (r: CrewRow): CrewMember => ({ ...person(r), role: r.role });
export const applicant = (r: CrewPersonRow): Applicant => person(r);
