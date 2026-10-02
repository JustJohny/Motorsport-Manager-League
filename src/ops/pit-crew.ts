import { float, num } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
import type { GameCrew, PitCrewRules, PitStopRound } from "../league-types.ts";
import { activeRoles, CREW_SIZES, type NamePool } from "../pit-crew.ts";

export interface SetPitCrewOp {
  op: "setPitCrew";
  team: string;
  /** SessionSetupChangeEntry.Target → skill and confidence, for both cars' AIPitCrew. */
  tasks: { target: number; stat: number; confidence: number }[];
}

function controller(save: Save, team: Obj): Obj | null {
  return team.pitCrewController ? save.g.deref<Obj>(team.pitCrewController) : null;
}

/** The series' crew rule, and the field's average AI pit stop skill (its mechanics' Pit stops stat). */
export function pitCrewRules(save: Save, champ: Obj): PitCrewRules {
  const g = save.g;
  const rules = g.deref<Obj>(champ.rules);
  const size = CREW_SIZES[num(rules?.pitCrewSize ?? 0)] ?? "Small";
  const refuelling = !!rules?.isRefuelingOn;
  const levels: number[] = [];
  for (const t of save.teams().filter((t) => g.same(t.championship, champ))) {
    const ai = controller(save, t)?.mAIPitCrew ? g.deref<Obj>(controller(save, t)!.mAIPitCrew) : null;
    if (!ai) continue;
    for (const list of [ai.carOneTaskStats, ai.carTwoTaskStats]) {
      const tyres = (list ?? []).map((x: unknown) => g.deref<Obj>(x)).find((x: Obj) => x?.taskType === 1);
      if (tyres) levels.push(num(tyres.taskStat));
    }
  }
  const aiLevel = levels.length ? Math.round((levels.reduce((s, x) => s + x, 0) / levels.length) * 100) / 100 : 10;
  return { size, refuelling, roles: activeRoles(size, refuelling), aiLevel };
}

/** MM's per-race pit stop log (PitCrewController.mPitStopLogs, one per calendar round) for finished rounds. */
export function pitStopLog(save: Save, champ: Obj): PitStopRound[] {
  const g = save.g;
  const teams = save.teams().filter((t) => g.same(t.championship, champ));
  // A round not run yet has no stops logged, so it drops out.
  return g.list<Obj>(champ.calendar).flatMap((_ev, i) => {
    const rows = teams.flatMap((t) => {
      const log = (controller(save, t)?.mPitStopLogs ?? [])[i];
      const l = log ? g.deref<Obj>(log) : null;
      const times: number[] = (l?.mPitstopTimes ?? []).map(num);
      if (!l || !num(l.mNumberOfPitstops ?? 0)) return [];
      return [{
        team: t.name as string,
        stops: num(l.mNumberOfPitstops),
        fastest: Math.round(num(l.mFastestPitStop) * 1000) / 1000,
        average: Math.round((times.reduce((s, x) => s + x, 0) / Math.max(1, times.length)) * 1000) / 1000,
        mistakes: num(l.mNumberOfMistakes ?? 0),
        catastrophic: num(l.mNumberOfCatastrophicMistakes ?? 0),
        fire: !!l.mCatastrophicFireHappened,
      }];
    });
    return rows.length ? [{ round: i + 1, teams: rows.sort((a, b) => a.fastest - b.fastest) }] : [];
  });
}

/** The career team's real MM crew, shown read-only (it's managed in game). */
export function gameCrew(save: Save, team: Obj): GameCrew | null {
  const g = save.g;
  const pc = controller(save, team);
  if (!pc || pc.mAIPitCrew) return null;
  const person = (m: Obj) => {
    const c = g.deref<Obj>(m.contract);
    return {
      name: `${m.mFirstName} ${m.mLastName}`,
      nationality: g.deref<Obj>(m.nationality)?.mCountryKey ?? null,
      birth: String(m.dateOfBirth ?? "").slice(0, 10),
      role: num(m.mPitCrewRole),
      stats: (m.mStats?.mPitStats ?? []).map((x: unknown) => Math.round(num(x) * 100) / 100),
      confidence: Math.round(num(m.mStats?.mConfidence ?? 0) * 100) / 100,
      maxConfidence: Math.round(num(m.mStats?.mMaxConfidence ?? 0) * 100) / 100,
      wage: Math.round(num(c?.yearlyWages ?? 0) / 12),
      racesLeft: num(c?.mRacesLeft ?? 0),
    };
  };
  const apps = g.list<Obj>(g.deref<Obj>(pc.mPitCrewApplicationManager)?.mPitCrewApplications ?? []);
  return {
    funding: num(pc.mCurrentPitCrewFunding ?? 1),
    members: g.list<Obj>(pc.mPitCrewTeamMembers ?? []).map(person),
    applicants: apps.map((a) => ({ ...person(g.deref<Obj>(a.mPitCrewMember)), racesLeft: num(a.mRacesLeft) })),
  };
}

/** First and last names by nationality, from every person in the save, to name generated crew. */
export function crewNamePool(save: Save): NamePool {
  const g = save.g;
  const pool: NamePool = {};
  for (const p of save.people()) {
    const nat = g.deref<Obj>(p.nationality)?.mCountryKey;
    if (!nat || !p.mFirstName || !p.mLastName) continue;
    const e = (pool[nat] ??= { first: [], last: [] });
    if (!e.first.includes(p.mFirstName)) e.first.push(p.mFirstName);
    if (!e.last.includes(p.mLastName)) e.last.push(p.mLastName);
  }
  // Nationalities with a handful of people only, so names don't repeat too often.
  for (const k of Object.keys(pool)) if (pool[k].first.length < 3 || pool[k].last.length < 3) delete pool[k];
  for (const e of Object.values(pool)) e.first.sort(), e.last.sort();
  return pool;
}

/** Write a site-run crew's task values into the team's AIPitCrew (both cars). */
export function setPitCrew(save: Save, op: SetPitCrewOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const pc = controller(save, team);
  const ai = pc?.mAIPitCrew ? g.deref<Obj>(pc.mAIPitCrew) : null;
  if (!ai) throw new Error(`${op.team} has no AI pit crew (the career team's crew is managed in game)`);
  let n = 0;
  for (const list of [ai.carOneTaskStats, ai.carTwoTaskStats]) {
    for (const t of op.tasks) {
      const entry = (list ?? []).map((x: unknown) => g.deref<Obj>(x)).find((x: Obj) => x?.taskType === t.target);
      if (!entry) throw new Error(`${op.team}: no AI pit crew task ${t.target}`);
      if (!(t.stat >= 0 && t.stat <= 20) || !(t.confidence > 0 && t.confidence <= 1)) throw new Error(`${op.team}: task ${t.target} values out of range`);
      entry.taskStat = float(t.stat);
      entry.taskConfidence = float(t.confidence);
      n++;
    }
  }
  return `${op.team}: pit crew tasks set (${op.tasks.map((t) => `${t.target}=${t.stat}/${t.confidence}`).join(", ")}), ${n / 2} per car`;
}
