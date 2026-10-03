import type { Obj } from "./graph.ts";
import type {
  Building, CalendarEvent, Championship, LeagueConfig, LeagueState, Part, Person, RaceResults, RulesBreach, SessionResult, TeamDesign, TeamState,
} from "./league-types.ts";
import { teamDesign } from "./ops/design.ts";
import { gameCrew, pitCrewRules, pitStopLog } from "./ops/pit-crew.ts";
import { teamSponsors } from "./ops/sponsors.ts";
import { extractRegulations } from "./regulations.ts";
import { carInvestment, currentSuppliers, hasChassisDesign, nextCarSeason, nextYearDesignState, pendingSuppliers, seasonOver, supplierOptions } from "./ops/suppliers.ts";
import { BUILDING_STATES, JOBS, PART_TYPES, Save, numOrNull, personKind, personName, type PartType } from "./model.ts";

export type { LeagueConfig, LeagueState, TeamState } from "./league-types.ts";

// Part inventories used by each championship series (single seater, GT, endurance).
const SERIES_PART_TYPES: Record<number, PartType[]> = {
  0: ["Brakes", "Engine", "FrontWing", "Gearbox", "RearWing", "Suspension"],
  1: ["BrakesGT", "EngineGT", "GearboxGT", "RearWingGT", "SuspensionGT"],
  2: ["BrakesGET", "EngineGET", "FrontWingGET", "GearboxGET", "RearWingGET", "SuspensionGET"],
};

export function extractLeague(save: Save, cfg: LeagueConfig): LeagueState {
  const { g } = save;
  const memberTeams = cfg.members.map((m) => ({ member: m.member, team: save.team(m.team) }));
  const champ = cfg.championship !== undefined
    ? g.list<Obj>(save.data.championshipManager.mEntities ?? []).find((c) =>
        c.championshipID === cfg.championship || save.championshipName(c) === cfg.championship)
      ?? save.championship(save.team(cfg.members[0].team))
    : save.championship(memberTeams[0].team);

  const teamsInChamp = save.teams().filter((t) => g.same(t.championship, champ));
  const memberOf = new Map(memberTeams.map((m) => [m.team, m.member]));

  return {
    extractedAt: new Date().toISOString(),
    gameDate: save.now,
    championship: {
      id: champ.championshipID,
      name: save.championshipName(champ),
      eventNumber: champ.mEventNumber,
      calendar: calendar(save, champ),
      standings: standings(save, champ),
      lastRace: raceResults(save, champ).at(-1) ?? null,
      races: raceResults(save, champ),
      rulesBreaches: rulesBreaches(save, champ).map(({ part: _p, partType: _t, ...b }) => b),
      regulations: extractRegulations(save, champ, new Set(memberTeams.map((m) => m.team.name as string))),
      pitCrew: pitCrewRules(save, champ),
      pitStops: pitStopLog(save, champ),
    },
    teams: teamsInChamp.map((t) => team(save, t, champ, memberOf.get(t) ?? null)),
    freeAgents: save.people().filter((p) => save.isFreeAgent(p)).map((p) => person(save, p)),
  };
}

/** One team as the site sees it (also used by the TUI's save browser for any team). */
export function team(save: Save, t: Obj, champ: Obj, member: string | null): TeamState {
  const fin = save.finance(t);
  const partTypes = SERIES_PART_TYPES[champ.series as number] ?? SERIES_PART_TYPES[0];
  const sponsors = teamSponsors(save, t);
  return {
    member,
    teamID: t.teamID,
    guid: t.id,
    name: t.name,
    isPlayerTeam: save.g.same(save.data.player.mPlayerTeam, t),
    budget: numOrNull(fin.currentBudget),
    reputation: t.reputation,
    marketability: numOrNull(t.marketability),
    fanBase: numOrNull(t.fanBase),
    hq: save.buildings(t).map((b) => building(save, b)),
    parts: Object.fromEntries(partTypes.map((type) => [type, save.parts(t, type).map((p) => part(save, p))])),
    design: champ.series === 0 ? withRules(save, t, champ, teamDesign(save, t)) : null,
    gameCrew: gameCrew(save, t),
    engine: engineOf(save, t),
    sponsors: sponsors?.onCar ?? [],
    sponsorship: sponsors?.sponsorship ?? null,
    staff: save.slots(t).map((s) => {
      const p = s.personHired ? save.g.deref<Obj>(s.personHired) : null;
      return { slotID: s.slotID, job: JOBS[s.jobType] ?? String(s.jobType), person: p ? person(save, p) : null };
    }).filter((s) => ["Driver", "EngineerLead", "Mechanic"].includes(s.job as string)),
  };
}

function engineOf(save: Save, t: Obj): TeamState["engine"] {
  const e = currentSuppliers(save, t).Engine;
  return e ? { name: e.name, stats: e.stats } : null;
}

export function building(save: Save, b: Obj): Building {
  const info = save.buildingInfo(b);
  const built = b.state !== 0;
  return {
    type: info.type,
    name: info.name,
    state: BUILDING_STATES[b.state],
    /** 0 = not built, otherwise the level shown in game (1..maxLevel+1). */
    level: built ? b.currentLevel + 1 : 0,
    maxLevel: info.maxLevel + 1,
    progress: numOrNull(b.normalizedProgress),
    progressStart: b.mDateProgressStarted,
    progressEnd: b.mDateProgressEnd,
    upgradeCosts: (info.upgradeCost ?? []).map(numOrNull),
    initialCost: numOrNull(info.initialCost),
    buildWeeks: info.buildTime ?? 0,
    upgradeWeeks: info.upgradeTime ?? [],
    dependencies: (info.dependencies ?? []).map((d: Obj) => ({ buildingType: d.buildingType, requiredLevel: d.requiredLevel })),
  };
}

export function part(save: Save, p: Obj): Part {
  const s = p.mStats;
  const fittedCar = p.fittedCar ? save.g.deref<Obj>(p.fittedCar) : null;
  return {
    guid: p.id,
    name: p.name,
    type: p.$type,
    level: s.level,
    stat: numOrNull(s.mStat),
    performance: numOrNull(s.mPerformance),
    maxPerformance: numOrNull(s.maxPerformance),
    reliability: numOrNull(s.mReliability),
    maxReliability: numOrNull(s.maxReliability),
    condition: numOrNull(s.partCondition?.mCondition),
    rulesRisk: numOrNull(s.rulesRisk),
    fittedToCar: fittedCar ? fittedCar.identifier : null,
    buildDate: p.buildDate,
    components: (p.components ?? []).length,
    componentIds: save.g.list<Obj>(p.components ?? []).filter(Boolean).map((c) => c.id as number),
  };
}

export function person(save: Save, p: Obj): Person {
  const c = save.contract(p);
  const kind = personKind(p);
  const stats = save.g.deref<Obj>(p.mStats ?? p.stats);
  let s: Record<string, number | null> = {};
  if (kind === "Driver") {
    for (const k of ["braking", "cornering", "smoothness", "overtaking", "consistency", "adaptability", "fitness", "feedback", "focus"]) s[k] = numOrNull(stats[k]);
  } else if (kind === "Mechanic") {
    for (const k of ["reliability", "performance", "concentration", "speed", "pitStops", "leadership"]) s[k] = numOrNull(stats[k]);
  } else if (kind === "Engineer") {
    const pcs = save.g.deref<Obj>(stats.partContributionStats);
    for (const k of ["topSpeed", "acceleration", "braking", "lowSpeedCorners", "mediumSpeedCorners", "highSpeedCorners"]) s[k] = numOrNull(pcs?.[k]);
  }
  const employer = save.employer(p);
  return {
    guid: p.id,
    name: personName(p),
    kind,
    dateOfBirth: p.dateOfBirth,
    nationality: save.g.deref<Obj>(p.nationality)?.mCountryKey ?? null,
    stats: s,
    potential: numOrNull(p.mPotential ?? null),
    carID: p.mCarID ?? null,
    contract: {
      team: employer?.name ?? null,
      job: JOBS[c.job] ?? String(c.job),
      yearlyWages: c.yearlyWages,
      start: c.startDate,
      end: c.mEndDate,
    },
  };
}

function calendar(save: Save, ch: Obj): CalendarEvent[] {
  return save.g.list<Obj>(ch.calendar).map((ev, i) => {
    const circuit = save.g.deref<Obj>(ev.circuit);
    return { round: i + 1, date: ev.eventDate, circuit: circuit.locationName, layout: circuit.trackLayout, ended: !!ev.mHasEventEnded };
  });
}

function standings(save: Save, ch: Obj): Championship["standings"] {
  const st = save.g.deref<Obj>(ch.standings);
  const row = (e: Obj, name: string) => ({
    name,
    position: e.mCurrentPosition,
    points: numOrNull(e.mPoints?.[Math.max(0, (e.races ?? 1) - 1)]) ?? 0,
    races: e.races, wins: e.wins, podiums: e.podiums, dnfs: e.DNFs,
  });
  const drivers = save.g.list<Obj>(st.mDrivers).map((e) => {
    const d = save.g.deref<Obj>(e.mEntity);
    return { ...row(e, personName(d)), guid: d.id, team: save.employer(d)?.name ?? null };
  });
  const teams = save.g.list<Obj>(st.mTeams).map((e) => {
    const t = save.g.deref<Obj>(e.mEntity);
    return { ...row(e, t.name), teamID: t.teamID };
  });
  const byPos = (a: { position: number }, b: { position: number }) => a.position - b.position;
  return { drivers: drivers.sort(byPos), teams: teams.sort(byPos) };
}

/** Results of every finished round this season (MM keeps them on the calendar events). */
function raceResults(save: Save, ch: Obj): RaceResults[] {
  return save.g.list<Obj>(ch.calendar).flatMap((ev, idx) => {
    if (!ev.mHasEventEnded || !ev.results) return [];
    const r = eventResults(save, ev, idx);
    return r.race.length ? [r] : [];
  });
}

function eventResults(save: Save, ev: Obj, idx: number): RaceResults {
  const results = save.g.deref<Obj>(ev.results);
  const session = (key: string): SessionResult[] => {
    const s = results[key]?.[0] ? save.g.deref<Obj>(results[key][0]) : null;
    return (s?.resultData ?? []).map((r: Obj) => {
      r = save.g.deref<Obj>(r);
      const d = save.g.deref<Obj>(r.driver);
      return {
        position: r.position,
        driver: personName(d), driverGuid: d.id,
        team: save.g.deref<Obj>(r.team)?.name,
        grid: r.gridPosition, laps: r.laps, time: numOrNull(r.time), bestLap: numOrNull(r.bestLapTime),
        stops: r.stops, points: r.points, carState: r.carState,
      };
    }).sort((a: Obj, b: Obj) => a.position - b.position);
  };
  return {
    round: idx + 1,
    circuit: save.g.deref<Obj>(ev.circuit).locationName,
    date: ev.eventDate,
    qualifying: session("qualifyingSessions"),
    race: session("raceSessions"),
  };
}

/** Parts caught by MM's post-race scrutineering, from the race results' PenaltyPartRulesBroken. */
function rulesBreaches(save: Save, ch: Obj): (RulesBreach & { part: string; partType: string })[] {
  const out: (RulesBreach & { part: string; partType: string })[] = [];
  save.g.list<Obj>(ch.calendar).forEach((ev, i) => {
    if (!ev.mHasEventEnded) return;
    const results = save.g.deref<Obj>(ev.results);
    const race = results?.raceSessions?.[0] ? save.g.deref<Obj>(results.raceSessions[0]) : null;
    for (const raw of race?.resultData ?? []) {
      const r = save.g.deref<Obj>(raw);
      for (const pen of (r.penalties ?? []).map((x: Obj) => save.g.deref<Obj>(x))) {
        if (pen?.$type !== "PenaltyPartRulesBroken") continue;
        const part = pen.mPart ? save.g.deref<Obj>(pen.mPart) : null;
        out.push({
          round: i + 1,
          circuit: save.g.deref<Obj>(ev.circuit).locationName,
          date: ev.eventDate,
          team: save.g.deref<Obj>(r.team)?.name ?? null,
          driver: personName(save.g.deref<Obj>(r.driver)),
          placesLost: pen.mPlacesLost ?? 0,
          fine: numOrNull(pen.mPenaltyCashAmount) ?? 0,
          part: part?.name ?? "",
          partType: String(part?.$type ?? "").replace(/Part$/, ""),
        });
      }
    }
  });
  return out;
}

function withRules(save: Save, t: Obj, champ: Obj, design: TeamDesign): TeamDesign {
  const investor = t.investor ? save.g.deref<Obj>(t.investor) : null;
  return {
    ...design,
    nextYearCar: {
      state: nextYearDesignState(save, t),
      season: nextCarSeason(save, t),
      current: currentSuppliers(save, t) as Record<string, never>,
      // MM's draw from the season's end until the car is built. It may outlive the season it was
      // drawn for, so it only counts once the season is over or MM is designing the car.
      options: (nextYearDesignState(save, t) === "designing" || (nextYearDesignState(save, t) === "waiting" && seasonOver(save, t))
        ? supplierOptions(save, t) : {}) as Record<string, never>,
      chassisDesign: hasChassisDesign(save, t),
      pending: (nextYearDesignState(save, t) === "designing" ? pendingSuppliers(save, t) : undefined) as Record<string, never> | undefined,
      investment: carInvestment(save, t),
    },
    rules: {
      brokenThisSeason: t.rulesBrokenThisSeason ?? 0,
      riskBonus: investor?.partRiskBonus ?? 0,
      breaches: rulesBreaches(save, champ).filter((b) => b.team === t.name),
    },
  };
}
