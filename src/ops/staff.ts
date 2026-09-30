import { float, type Json } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import { CONTRACT_STATUS, JOB, NULL_DATE, personKind, personName, type Save } from "../model.ts";

export interface HireOp {
  op: "hire";
  team: string | number;
  /** GUID of the person to sign: a free agent, or someone at another team (a straight swap). */
  person: string;
  /** GUID of the team member they replace. Required unless `slotID` names an empty slot. */
  replacing?: string;
  slotID?: number;
  yearlyWages?: number;
  /** C# date string for the contract end; defaults to the replaced person's end date. */
  endDate?: string;
}

const SLOT_JOB: Record<string, number> = { Driver: JOB.Driver, Engineer: JOB.EngineerLead, Mechanic: JOB.Mechanic };

/**
 * Put `person` into a slot at `team`. If they were a free agent, the person they replace
 * becomes a free agent. If they were employed at another team, the two swap slots
 * (the only move the game's own save editor treats as safe).
 */
export function hire(save: Save, op: HireOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const incoming = save.person(op.person);
  const kind = personKind(incoming);
  const jobType = SLOT_JOB[kind];
  if (jobType === undefined) throw new Error(`Can only hire drivers, engineers and mechanics (got ${kind})`);

  const slots = save.slots(team);
  const slot = op.replacing
    ? slots.find((s) => s.personHired && g.deref<Obj>(s.personHired).id === op.replacing)
    : slots.find((s) => s.slotID === op.slotID);
  if (!slot) throw new Error(`${team.name}: no slot ${op.replacing ? `holding ${op.replacing}` : `#${op.slotID}`}`);
  if (slot.jobType !== jobType) throw new Error(`${team.name}: slot ${slot.slotID} is not a ${kind} slot`);
  const outgoing = slot.personHired ? g.deref<Obj>(slot.personHired) : null;
  if (outgoing === incoming) return `${team.name}: ${personName(incoming)} already in slot ${slot.slotID}`;

  const fromTeam = save.employer(incoming);
  if (fromTeam === team) throw new Error(`${personName(incoming)} already works for ${team.name}`);
  const fromSlot = fromTeam ? save.slots(fromTeam).find((s) => s.personHired && g.deref(s.personHired) === incoming) : null;
  if (fromTeam && !fromSlot) throw new Error(`Could not find ${personName(incoming)}'s slot at ${fromTeam.name}`);
  if (fromTeam && !outgoing) throw new Error(`Transfers are swaps: name who goes to ${fromTeam.name} with 'replacing'`);

  const inC = save.contract(incoming);
  const outC = outgoing ? save.contract(outgoing) : null;
  const eventTemplate = (outC?.mCalendarEvent && save.g.deref<Obj>(outC.mCalendarEvent)) || findContractEvent(save);
  const terms = {
    yearlyWages: op.yearlyWages ?? inC.yearlyWages,
    end: op.endDate ?? outC?.mEndDate ?? inC.mEndDate,
    status: outC?.mCurrentStatus ?? inC.mCurrentStatus,
  };

  if (fromTeam && fromSlot && outgoing && outC) {
    // Swap: outgoing takes incoming's old place, with incoming's old terms.
    const swapTerms = { yearlyWages: inC.yearlyWages, end: inC.mEndDate, status: inC.mCurrentStatus };
    employ(save, outgoing, fromTeam, jobType, swapTerms);
    fromSlot.personHired = g.ref(outgoing);
    replaceInTeamCaches(save, fromTeam, incoming, outgoing);
    setContractEvent(save, outgoing, eventTemplate);
  } else if (outgoing) {
    release(save, outgoing);
  }
  employ(save, incoming, team, jobType, terms);
  setContractEvent(save, incoming, eventTemplate);
  slot.personHired = g.ref(incoming);
  if (outgoing) replaceInTeamCaches(save, team, outgoing, incoming);
  else g.rawList(save.contractManager(team).mCachedPeople).push(g.ref(incoming));

  if (outgoing) swapAssignments(incoming, outgoing, kind);
  if (kind === "Driver") ensureStandingsEntry(save, team, incoming);
  ensureMechanicRelationships(save, team);
  if (fromTeam) ensureMechanicRelationships(save, fromTeam);

  const who = outgoing ? ` replacing ${personName(outgoing)}` : "";
  const where = fromTeam ? ` (swap with ${fromTeam.name})` : outgoing ? ` (${personName(outgoing)} released)` : "";
  return `${team.name}: hired ${kind} ${personName(incoming)}${who}${where}`;
}

function employ(save: Save, p: Obj, team: Obj, jobType: number, t: { yearlyWages: number; end: string; status: number }) {
  const c = save.contract(p);
  c.employeer = save.g.ref(team);
  c.mEmployeerTeam = save.g.ref(team);
  c.job = jobType;
  c.mContractStatus = CONTRACT_STATUS.OnGoing;
  c.startDate = save.now;
  c.mEndDate = t.end;
  c.yearlyWages = t.yearlyWages;
  c.mCurrentStatus = t.status;
  c.mProposedStatus = t.status;
  startCareerEntry(save, p, team);
}

function release(save: Save, p: Obj) {
  const c = save.contract(p);
  c.employeer = null;
  c.mEmployeerTeam = null;
  c.employeerName = "";
  c.job = JOB.Unemployed;
  c.mContractStatus = CONTRACT_STATUS.Terminated;
  finishCareerEntry(save, p);
  removeContractEvent(save, p);
}

// Every running contract has a calendar event that fires ContractEndDateReached on its end
// date (and shows as "Contract ending with …"). Free agents have none, and the game's own
// termination code dereferences it, so hires get one and releases lose theirs.

function delayedEvents(save: Save): Json[] {
  return save.g.rawList(save.data.calendar.mDelayedEvents);
}

function findContractEvent(save: Save): Obj | null {
  for (const e of delayedEvents(save)) {
    const ev = save.g.deref<Obj>(e);
    if (ev?.OnEventTrigger?.methodNames?.[0] === "ContractEndDateReached") return ev;
  }
  return null;
}

function removeContractEvent(save: Save, p: Obj) {
  const c = save.contract(p);
  if (!c.mCalendarEvent) return;
  const ev = save.g.deref<Obj>(c.mCalendarEvent);
  const list = delayedEvents(save);
  const i = list.findIndex((e) => save.g.deref(e) === ev);
  if (i >= 0) list.splice(i, 1);
  c.mCalendarEvent = null;
}

function setContractEvent(save: Save, p: Obj, template: Obj | null) {
  const g = save.g;
  const c = save.contract(p);
  // Free agents sometimes keep a stale inline event (with no $id); reuse it if so.
  let ev = c.mCalendarEvent ? g.deref<Obj>(c.mCalendarEvent) : null;
  if (!ev) {
    if (!template) throw new Error("No contract calendar event in the save to copy");
    ev = g.clone({ ...template, OnEventTrigger: { ...template.OnEventTrigger, targets: [] }, displayEffect: { ...template.displayEffect, person: null } });
  }
  // Aim the event at this person's contract and rename the calendar text.
  const shownPerson = ev.displayEffect?.person ? g.deref<Obj>(ev.displayEffect.person) : null;
  const oldName = shownPerson?.name ?? (template?.displayEffect?.person ? g.deref<Obj>(template.displayEffect.person).name : null);
  ev.OnEventTrigger.targets = [g.ref(c)];
  if (ev.displayEffect) ev.displayEffect.person = g.ref(p);
  const texts = ev.mDynamicDescription?.translatedText ?? {};
  if (oldName && oldName !== p.name) {
    for (const lang of Object.keys(texts)) texts[lang] = String(texts[lang]).split(oldName).join(p.name);
  }
  ev.triggerDate = c.mEndDate;
  ev.triggerCacheDayDate = c.mEndDate;
  ev.showOnCalendar = true;

  // The contract and the calendar list must share one object, so both hold references.
  c.mCalendarEvent = g.ref(ev);
  const list = delayedEvents(save);
  const i = list.findIndex((e) => g.deref(e) === ev);
  if (i >= 0) list.splice(i, 1);
  insertByDate(save, ev, c.mEndDate);
}

function insertByDate(save: Save, ev: Obj, date: string) {
  const list = delayedEvents(save);
  const i = list.findIndex((e) => (save.g.deref<Obj>(e).triggerDate as string) > date);
  list.splice(i < 0 ? list.length : i, 0, save.g.ref(ev));
}

/**
 * The game reads `careerHistory.currentEntry` (the last entry) for employed staff after every
 * session. Free agents usually have an empty history, which crashes the game in
 * Team.IncreaseStaffHistoryStat, so a hire closes the old entry and opens one for the new team.
 */
function startCareerEntry(save: Save, p: Obj, team: Obj) {
  finishCareerEntry(save, p);
  const history = save.g.deref<Obj>(p.careerHistory);
  save.g.rawList(history.mCareer).push({
    team: save.g.ref(team),
    championship: save.g.ref(save.championship(team)),
    year: Number(save.now.slice(0, 4)),
    wins: 0, podiums: 0, races: 0, poles: 0, DNFs: 0, DNFsViaError: 0, DNS: 0, careerPoints: 0, championships: 0,
    mIsFinished: false,
    mEndDate: NULL_DATE,
    mStartDate: save.now,
    $version: "v0",
  });
}

function finishCareerEntry(save: Save, p: Obj) {
  const history = save.g.deref<Obj>(p.careerHistory);
  const last = save.g.rawList(history.mCareer).at(-1);
  if (last && !last.mIsFinished) {
    last.mIsFinished = true;
    last.mEndDate = save.now;
  }
}

/** Car assignment (drivers) and driver pairing (mechanics) stay with the seat, not the person. */
function swapAssignments(a: Obj, b: Obj, kind: string) {
  const key = kind === "Driver" ? "mCarID" : kind === "Mechanic" ? "driver" : null;
  if (!key) return;
  [a[key], b[key]] = [b[key], a[key]];
}

/** Point the team's cached person lists (and AI / part-improvement assignments) at the new person. */
function replaceInTeamCaches(save: Save, team: Obj, from: Obj, to: Obj) {
  const cm = save.contractManager(team);
  const carManager = save.g.deref<Obj>(team.carManager);
  const targets: Json[] = [
    cm.mCachedPeople, team.mMechanics, team.mSelectedSessionDrivers, team.mVehicleSessionDrivers,
    save.g.deref<Obj>(team.teamAIController)?.mDrivers, carManager.partImprovement,
  ];
  for (const s of save.g.list<Obj>(cm.mNextYearEmployeeSlots)) {
    if (s.personHired && save.g.deref(s.personHired) === from) s.personHired = save.g.ref(to);
  }
  // The caches reference teams (partImprovement.mTeam, and from there rivalTeam) and people of
  // other teams; following those would rewrite another team's slots. Stay inside this team.
  const teams = new Set(save.teams());
  const people = new Set(save.people());
  const outside = (o: Obj) => teams.has(o) || (people.has(o) && save.employer(o) !== team);
  for (const t of targets) replaceRefs(save, t, from, to, 4, outside);
}

function replaceRefs(save: Save, v: Json, from: Obj, to: Obj, depth: number, outside: (o: Obj) => boolean): void {
  if (depth < 0 || v == null || typeof v !== "object") return;
  const container = save.g.deref<Json>(v);
  const entries: [Json, string | number][] = Array.isArray(container)
    ? container.map((_, i) => [container, i])
    : Object.keys(container).filter((k) => !k.startsWith("$") || k === "$content").map((k) => [container, k]);
  for (const [parent, key] of entries) {
    const x = parent[key];
    if (x && typeof x === "object" && (x === from || (x.$ref !== undefined && save.g.deref(x) === from))) {
      parent[key] = save.g.ref(to);
    } else if (x && typeof x === "object" && x.$id === undefined) {
      if (x.$ref !== undefined && outside(save.g.deref<Obj>(x))) continue;
      replaceRefs(save, x, from, to, depth - 1, outside);
    } else if (Array.isArray(x) || (x && typeof x === "object" && "$content" in x)) {
      replaceRefs(save, x, from, to, depth - 1, outside);
    }
  }
}

/**
 * Each mechanic keeps a relationship record per driver, keyed by the driver's name. The game
 * creates zeroed ones on every hire (Mechanic.SetDefaultDriverRelationship). Without them it
 * crashes at the start of the next race weekend (Mechanic.GetModifiedRelationshipWithDriver).
 */
function ensureMechanicRelationships(save: Save, team: Obj) {
  const people = save.slots(team).filter((s) => s.personHired).map((s) => ({ job: s.jobType, p: save.g.deref<Obj>(s.personHired) }));
  const drivers = people.filter((x) => x.job === JOB.Driver).map((x) => x.p);
  for (const { p: m } of people.filter((x) => x.job === JOB.Mechanic)) {
    m.mDictDriversRelationships ??= {};
    m.mDictRelationshipModificationHistory ??= {};
    for (const d of drivers) {
      const key = d.name as string;
      m.mDictDriversRelationships[key] ??= {
        relationshipAmount: float(0), relationshipAmountAfterDecay: float(-1), numberOfWeeks: 0, $version: "v0",
      };
      m.mDictRelationshipModificationHistory[key] ??= {
        mMaxHistoryEntries: 5, mStatModificationHistoryEntries: [], $version: "v0",
      };
    }
  }
}

/** A driver new to the championship needs a standings row, like the game adds on signing. */
function ensureStandingsEntry(save: Save, team: Obj, driver: Obj) {
  const g = save.g;
  const st = g.deref<Obj>(save.championship(team).standings);
  const rows = g.rawList(st.mDrivers);
  if (rows.some((r) => g.deref<Obj>(g.deref<Obj>(r).mEntity) === driver)) return;
  const inactive = g.rawList(st.mInactiveDrivers);
  const idx = inactive.findIndex((r) => g.deref<Obj>(g.deref<Obj>(r).mEntity) === driver);
  if (idx >= 0) {
    rows.push(inactive.splice(idx, 1)[0]);
    return;
  }
  const template = g.deref<Obj>(rows[rows.length - 1]);
  const row = g.clone({ ...template, mEntity: null });
  row.mEntity = g.ref(driver);
  row.races = row.podiums = row.wins = row.DNFs = 0;
  row.mCurrentPosition = rows.length + 1;
  for (const k of ["mQualifyingPositions", "mRacePositions", "mChampionshipPositions", "mPoints", "mExpectedRacePositions", "mEventPositions"]) {
    if (Array.isArray(row[k])) row[k] = row[k].map(() => 0);
  }
  rows.push(row);
}
