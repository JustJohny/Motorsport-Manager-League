import { float, num } from "../codec/sav.ts";
import { gameScale } from "../game-rules.ts";
import type { Obj } from "../graph.ts";
import { BUILDING_STATES, JOB, PART_TYPES, type PartType, type Save } from "../model.ts";
import type { EqualizeSettings } from "../league-types.ts";
import { cancelBuilding, setBuilding } from "./hq.ts";
import { cancelDesign, carPartDesign, isSpecPart } from "./design.ts";
import { setBudget } from "./finance.ts";

/**
 * Make every listed team equal (usually the whole championship at the start of a league): the
 * organizer's HQ levels, part stats, lead designer and mechanic stats, AI pit crew and budget.
 * Drivers keep their own stats. Member teams' site-run crews are reset by the toolkit's pull.
 */
export interface EqualizeOp extends EqualizeSettings {
  op: "equalizeTeams";
  teams: string[];
}

/** The team field holding each part type's development rate (component boosts x this). */
const DEV_RATE: Partial<Record<PartType, string>> = {
  Brakes: "brakesDevelopmentRate", Engine: "engineDevelopmentRate", FrontWing: "frontWingDevelopmentRate",
  Gearbox: "gearboxDevelopmentRate", RearWing: "rearWingDevelopmentRate", Suspension: "suspensionDevelopmentRate",
};
export const DESIGNER_STATS = ["topSpeed", "acceleration", "braking", "lowSpeedCorners", "mediumSpeedCorners", "highSpeedCorners"] as const;
export const MECHANIC_STATS = ["reliability", "performance", "concentration", "speed", "pitStops", "leadership"] as const;

function staff(save: Save, team: Obj, job: number): Obj[] {
  return save.slots(team).filter((s) => s.jobType === job && s.personHired).map((s) => save.g.deref<Obj>(s.personHired));
}

function setStats(target: Obj, values: Record<string, number> | undefined, keys: readonly string[], max: number): number {
  let n = 0;
  for (const k of keys) {
    const v = values?.[k];
    if (v === undefined) continue;
    if (!(v >= 0 && v <= max)) throw new Error(`${k} must be 0..${max}`);
    target[k] = float(v);
    n++;
  }
  return n;
}

export function equalizeTeams(save: Save, op: EqualizeOp): string[] {
  const g = save.g;
  const log: string[] = [];
  for (const name of op.teams) {
    const team = save.team(name);
    const done: string[] = [];

    // HQ: stop constructions (the budget is set below, so no refund), then the organizer's levels.
    for (const [building, level] of Object.entries(op.hq ?? {})) {
      const b = save.buildings(team).find((x) => save.buildingInfo(x).name === building);
      if (!b) continue;
      const state = BUILDING_STATES[b.state];
      if (state === "BuildingInProgress" || state === "Upgrading") cancelBuilding(save, { op: "cancelBuilding", team: name, building, refund: false });
      setBuilding(save, { op: "setBuilding", team: name, building, level });
    }
    if (op.hq) done.push(`HQ ${Object.keys(op.hq).length} buildings`);

    // Car: no design may finish later with old stats; every part of a designable type gets the
    // same stats, and new designs start from them (seasonPartStartingStat).
    if (op.parts) {
      const cpd = carPartDesign(save, team);
      if (cpd.mStage === 1 && cpd.mCarPart) cancelDesign(save, { op: "cancelDesign", team: name, refund: false });
      for (const [type, v] of Object.entries(op.parts) as [PartType, NonNullable<EqualizeSettings["parts"]>[string]][]) {
        if (!DEV_RATE[type] || isSpecPart(save, team, type)) continue;
        for (const p of save.parts(team, type)) {
          const s = p.mStats;
          s.mStat = float(v.stat);
          s.mPerformance = float(0);
          s.maxPerformance = float(v.maxPerformance);
          s.mReliability = float(v.reliability);
          s.maxReliability = float(v.maxReliability);
          s.rulesRisk = float(0);
          if (v.level) s.level = v.level;
          if (s.partCondition) { s.partCondition.mCondition = float(v.reliability); s.partCondition.mState = 0; }
        }
        const start = (cpd.seasonPartStartingStat as Obj[] | undefined)?.find((x) => x.Key === PART_TYPES.indexOf(type));
        if (start) start.Value = float(v.stat);
      }
      done.push(`parts ${Object.keys(op.parts).length} types`);
    }
    if (op.developmentRate !== undefined) {
      // Rebirth only: FF20 (like vanilla MM) has no team development rates.
      const fields = Object.values(DEV_RATE).filter((f) => f! in team);
      for (const field of fields) team[field!] = float(op.developmentRate);
      done.push(fields.length ? `development rate ${op.developmentRate}` : "development rate skipped (not in this game)");
    }

    // Staff: the lead designer's part contributions and every mechanic's stats.
    for (const p of staff(save, team, JOB.EngineerLead)) {
      const pcs = g.deref<Obj>(g.deref<Obj>(p.mStats ?? p.stats).partContributionStats);
      if (setStats(pcs, op.leadDesigner, DESIGNER_STATS, gameScale(save.game).engineerStatMax)) done.push("lead designer");
    }
    let mechanics = 0;
    for (const p of staff(save, team, JOB.Mechanic)) mechanics += setStats(g.deref<Obj>(p.mStats ?? p.stats), op.mechanics, MECHANIC_STATS, gameScale(save.game).mechanicStatMax) ? 1 : 0;
    if (mechanics) done.push(`${mechanics} mechanics`);

    // Pit crew: an AI team's task values (MM rebuilds them from the mechanics' Pit stops after each
    // race); the career team's real crew gets the skill on every stat.
    if (op.pitCrew) {
      const pc = team.pitCrewController ? g.deref<Obj>(team.pitCrewController) : null;
      const ai = pc?.mAIPitCrew ? g.deref<Obj>(pc.mAIPitCrew) : null;
      if (ai) {
        for (const list of [ai.carOneTaskStats, ai.carTwoTaskStats]) {
          for (const x of (list ?? []).map((e: unknown) => g.deref<Obj>(e))) {
            x.taskStat = float(op.pitCrew.skill);
            x.taskConfidence = float(op.pitCrew.confidence);
          }
        }
        done.push("AI pit crew");
      } else if (pc) {
        for (const m of g.list<Obj>(pc.mPitCrewTeamMembers ?? [])) {
          m.mStats.mPitStats = m.mStats.mPitStats.map(() => float(op.pitCrew!.skill));
          m.mStats.mConfidence = float(op.pitCrew.confidence);
          m.mStats.mMaxConfidence = float(Math.max(op.pitCrew.confidence, num(m.mStats.mMaxConfidence)));
        }
        done.push("career pit crew");
      }
    }

    if (op.budget !== undefined) setBudget(save, { op: "setBudget", team: name, amount: op.budget, reason: "League equalization" });
    if (op.budget !== undefined) done.push(`budget ${op.budget}`);
    log.push(`${team.name}: equalized (${done.join(", ")})`);
  }
  return log;
}
