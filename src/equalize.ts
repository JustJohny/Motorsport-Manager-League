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
