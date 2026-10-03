import type { ChangeSet } from "./apply.ts";
import type { TeamDesign } from "./league-types.ts";
import { rest, type SupabaseEnv } from "./supabase.ts";

type NextYearCar = NonNullable<TeamDesign["nextYearCar"]>;
export interface ChassisChoiceRow { team: string; season: number; nose: number | string; rear: number | string }
export interface InvestmentRow { team: string; level: number }

/**
 * Next year's car: every member's fund level (a standing choice, every pull) and, once MM designs
 * the car (pre-season, main championship), their chassis sliders. Runs after setSuppliers.
 */
export function carChanges(chassis: ChassisChoiceRow[], investment: InvestmentRow[], cars: Map<string, NextYearCar>, memberTeams: string[]) {
  const changes: ChangeSet["changes"] = [];
  const waiting: string[] = [];
  for (const r of investment) if (memberTeams.includes(r.team)) changes.push({ op: "setCarInvestment", team: r.team, level: r.level });
  for (const r of chassis) {
    const car = cars.get(r.team);
    if (!car || !memberTeams.includes(r.team) || r.season !== car.season || !car.chassisDesign) continue;
    if (car.state !== "designing") { if (car.state === "waiting") waiting.push(r.team); continue; }
    changes.push({ op: "setChassis", team: r.team, nose: Number(r.nose), rear: Number(r.rear) });
  }
  return { changes, waiting };
}

export async function fetchCarChoices(env: SupabaseEnv) {
  // Before migration 017 the tables don't exist (PGRST205): no choices yet.
  const soft = <T,>(p: Promise<T[]>) => p.catch((e: Error) => { if (/PGRST205/.test(e.message)) return null; throw e; });
  const [chassis, investment] = await Promise.all([
    soft(rest<ChassisChoiceRow[]>(env, "GET", "chassis_choices?select=*")),
    soft(rest<InvestmentRow[]>(env, "GET", "car_investment?select=*")),
  ]);
  return { chassis: chassis ?? [], investment: investment ?? [], missing: chassis === null || investment === null };
}
