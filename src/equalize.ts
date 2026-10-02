// Equalizing the field: the organizer's form starts from the championship's averages, computed
// here from what the organizer sees (every team's public and private data). Only type imports:
// the site bundles this file.

import type { EqualizeSettings, TeamPrivate, TeamPublic } from "./league-types.ts";

const DESIGNER = ["topSpeed", "acceleration", "braking", "lowSpeedCorners", "mediumSpeedCorners", "highSpeedCorners"];
const MECHANIC = ["reliability", "performance", "concentration", "speed", "pitStops", "leadership"];

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Per stat key, the average over these people. */
function statAverages(people: { stats: Record<string, number | null> }[], keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, r1(avg(people.map((p) => p.stats[k]).filter((v): v is number => v != null)))]));
}

/** The field's averages as equalize settings (budget to $100K, HQ levels rounded, stats to 0.1). */
export function fieldDefaults(teams: { pub: TeamPublic; priv: TeamPrivate | undefined }[], aiPitLevel: number): EqualizeSettings {
  const privs = teams.map((t) => t.priv).filter((p): p is TeamPrivate => !!p);
  const hq: Record<string, number> = {};
  for (const name of [...new Set(privs.flatMap((p) => p.hq.map((b) => b.name)))]) {
    hq[name] = Math.round(avg(privs.map((p) => p.hq.find((b) => b.name === name)?.level ?? 0)));
  }
  const parts: NonNullable<EqualizeSettings["parts"]> = {};
  const designable = [...new Set(privs.flatMap((p) => Object.keys(p.design?.types ?? {})))];
  for (const type of designable) {
    // The parts on the cars: what each team races with now.
    const fitted = privs.flatMap((p) => (p.parts[type] ?? []).filter((x) => x.fittedToCar != null));
    if (!fitted.length) continue;
    parts[type] = {
      stat: r1(avg(fitted.map((x) => (x.stat ?? 0) + (x.performance ?? 0)))),
      maxPerformance: r1(avg(fitted.map((x) => x.maxPerformance ?? 0))),
      reliability: r3(avg(fitted.map((x) => x.reliability ?? 0))),
      maxReliability: r3(avg(fitted.map((x) => x.maxReliability ?? 0))),
      level: Math.max(1, Math.round(avg(fitted.map((x) => x.level)))),
    };
  }
  const rates = privs.flatMap((p) => Object.values(p.design?.types ?? {}).map((o) => o.base?.developmentRate)).filter((v): v is number => v != null);
  const staff = (job: string) => teams.flatMap((t) => t.pub.staff.filter((s) => s.job === job && s.person).map((s) => s.person!));
  const mechanics = statAverages(staff("Mechanic"), MECHANIC);
  return {
    budget: Math.round(avg(privs.map((p) => p.budget ?? 0)) / 100_000) * 100_000,
    hq,
    parts,
    developmentRate: rates.length ? r3(avg(rates)) : undefined,
    leadDesigner: statAverages(staff("EngineerLead"), DESIGNER),
    mechanics,
    // MM rebuilds AI crews from the mechanics' Pit stops after every race, so start the crews there.
    pitCrew: { skill: mechanics.pitStops || r1(aiPitLevel), confidence: 0.85 },
  };
}

export type Preset = "low" | "medium" | "high";

/** The presets' fixed values (see presetSettings). */
export const PRESETS: Record<Preset, {
  budget: number; hq: number; staff: number; pit: { skill: number; confidence: number };
  partStat: number; reliability: number; maxReliability: number; maxPerformance: number; level: number; developmentRate: number;
}> = {
  low: { budget: 10_000_000, hq: 0, staff: 6, pit: { skill: 6, confidence: 0.75 }, partStat: 0.9, reliability: 0.6, maxReliability: 0.65, maxPerformance: 10, level: 1, developmentRate: 0.6 },
  medium: { budget: 25_000_000, hq: 0.5, staff: 10, pit: { skill: 10, confidence: 0.85 }, partStat: 1, reliability: 0.75, maxReliability: 0.8, maxPerformance: 20, level: 2, developmentRate: 0.75 },
  high: { budget: 50_000_000, hq: 1, staff: 15, pit: { skill: 15, confidence: 0.95 }, partStat: 1.1, reliability: 0.9, maxReliability: 0.95, maxPerformance: 30, level: 3, developmentRate: 0.9 },
};

/** Buildings a team can't do without: Low keeps them at level 1. */
const CORE_BUILDINGS = ["Design Centre", "Factory"];

/**
 * A preset as equalize settings, for the buildings and part types in `field` (the field averages).
 * Everything is fixed except part performance: its scale depends on the series, so it's the
 * field average x 0.9 / 1 / 1.1. HQ: Low = core buildings at 1, Medium = half of each building's
 * max, High = max.
 */
export function presetSettings(preset: Preset, field: EqualizeSettings, maxLevel: (building: string) => number): EqualizeSettings {
  const p = PRESETS[preset];
  const stats = (keys: Record<string, number> | undefined) => Object.fromEntries(Object.keys(keys ?? {}).map((k) => [k, p.staff]));
  return {
    budget: p.budget,
    hq: Object.fromEntries(Object.keys(field.hq ?? {}).map((b) => [b,
      preset === "low" ? (CORE_BUILDINGS.includes(b) ? 1 : 0) : Math.round(maxLevel(b) * p.hq)])),
    parts: Object.fromEntries(Object.entries(field.parts ?? {}).map(([type, v]) => [type, {
      stat: r1(v.stat * p.partStat), maxPerformance: p.maxPerformance, reliability: p.reliability, maxReliability: p.maxReliability, level: p.level,
    }])),
    developmentRate: p.developmentRate,
    leadDesigner: stats(field.leadDesigner),
    mechanics: stats(field.mechanics),
    pitCrew: { ...p.pit },
  };
}
