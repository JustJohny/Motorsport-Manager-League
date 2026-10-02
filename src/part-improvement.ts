// MM's part improvement timing (PartImprovement in Assembly-CSharp) on plain data, so the league
// site can say when the mechanics finish. See docs/save-schema.md, "Part design and improvement".
// Only type imports: the site bundles this file.

import type { Part, TeamDesign } from "./league-types.ts";

export type ImprovementList = "performance" | "reliability";

const WORK_DAY_HOURS = 9; // 09:00-18:00, Monday to Friday
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Mechanics on each list: MM's SplitMechanics (performance = round(split x total)). */
export function splitMechanics(total: number, split: number): Record<ImprovementList, number> {
  const performance = Math.round(split * total);
  return { performance, reliability: total - performance };
}

const lerp01 = (to: number, t: number) => to * Math.min(1, Math.max(0, t));

/**
 * What one list gains per working day (GetWorkRate + GetChiefMechanicWorkRate): performance
 * points, or reliability as a fraction. 40 mechanics give the full 8 points / 12 %, and the chief
 * mechanic adds up to 1 point / 1 % at stat 20.
 */
export function improvementRate(list: ImprovementList, mechanics: number, chiefStat: number): number {
  if (list === "performance") return (mechanics > 0 ? lerp01(8, mechanics / 40) : 0) + lerp01(1, chiefStat / 20);
  return (mechanics > 0 ? lerp01(0.12, mechanics / 40) : 0) + lerp01(0.01, chiefStat / 20);
}

/**
 * Working days until a list is done. MM shares the work by what each part still lacks, so every
 * part in a list reaches its max at the same moment. Null when nobody works on it.
 */
export function improvementWorkDays(gaps: number[], rate: number): number | null {
  const work = gaps.reduce((s, g) => s + Math.max(0, g), 0);
  if (!work) return 0;
  return rate > 0 ? work / rate : null;
}

const parse = (d: string) => new Date(d.slice(0, 19) + "Z");
const weekday = (d: Date) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6;

/** The game date when `workDays` of mechanics' time is done, as MM's GetTotalSecondsToEndDate counts it. */
export function workDaysEnd(now: string, workDays: number): Date {
  const t = parse(now);
  let work = workDays * WORK_DAY_HOURS * HOUR_MS;
  const day = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  const start = day + 9 * HOUR_MS, end = day + 18 * HOUR_MS, midnight = day + DAY_MS;
  const shift = WORK_DAY_HOURS * HOUR_MS;
  const today = Math.min(end - t.getTime(), shift);
  if (weekday(t)) work -= today;
  if (work <= 0) return new Date(t.getTime() + Math.max(0, start - t.getTime()) + today + work);
  let ms = midnight - t.getTime();
  for (let cur = new Date(midnight); ; cur = new Date(cur.getTime() + DAY_MS)) {
    if (weekday(cur)) work -= shift;
    if (work <= 0) return new Date(t.getTime() + ms + shift + work + 9 * HOUR_MS);
    ms += DAY_MS;
  }
}

/** Whole calendar days between two game dates (b - a), counted by date. */
export function daysBetween(a: string, b: string | Date): number {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((day(typeof b === "string" ? parse(b) : b) - day(parse(a))) / DAY_MS);
}

export interface ListEstimate {
  mechanics: number;
  /** Working days left; null when nobody works on the list. */
  workDays: number | null;
  /** Game date the list is done; null when it never finishes. */
  end: Date | null;
}

/**
 * When each improvement list is done, from a team's published data and its chosen lists and split.
 * With parts in only one list, MM puts every mechanic on it (UpdateMechanicsDistribution).
 */
export function improvementEstimate(
  imp: TeamDesign["improvement"], parts: Part[], choice: Record<ImprovementList, string[]> & { split: number }, now: string,
): Record<ImprovementList, ListEstimate | null> {
  const byGuid = new Map(parts.map((p) => [p.guid, p]));
  const split = !choice.reliability.length && choice.performance.length ? 1 : choice.reliability.length && !choice.performance.length ? 0 : choice.split;
  const crew = splitMechanics(imp.mechanics, split);
  const estimate = (list: ImprovementList): ListEstimate | null => {
    const chosen = choice[list].map((g) => byGuid.get(g)).filter((p): p is Part => !!p);
    if (!chosen.length) return null;
    const gaps = chosen.map((p) => list === "performance"
      ? (p.maxPerformance ?? 0) - (p.performance ?? 0)
      : (p.maxReliability ?? 0) - (p.reliability ?? 0));
    const chief = list === "performance" ? imp.chiefPerformance : imp.chiefReliability;
    const workDays = improvementWorkDays(gaps, improvementRate(list, crew[list], chief ?? 0));
    return { mechanics: crew[list], workDays, end: workDays == null ? null : workDaysEnd(now, workDays) };
  };
  return { performance: estimate("performance"), reliability: estimate("reliability") };
}
