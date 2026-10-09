import { float, type Json } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import { CONTRACT_STATUS, JOB, NULL_DATE, personKind, personName, type Save } from "../model.ts";
import { delayedEvents, insertByDate } from "./calendar.ts";

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
    // An empty driver slot past the two race seats is the reserve's.
    status: outC?.mCurrentStatus ?? (kind === "Driver" && driverSlots(save, team).indexOf(slot) >= 2 ? DRIVER_STATUS.Reserve : inC.mCurrentStatus),
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
    // Cloned from a spread copy, so carry the template's runtime type over for $type annotation.
    const type = save.types.runtime.get(template);
    if (type) save.types.runtime.set(ev, type);
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

/** ContractPerson.Status: a driver's standing in the team. */
export const DRIVER_STATUS = { Equal: 0, One: 1, Two: 2, Reserve: 3 } as const;

/**
 * The team's driver slots in MM's order. In single-seater series the first is car 1, the second
 * car 2 and any further slot the reserve (Team.GetDriversForCar); endurance uses `mCarID`.
 */
function driverSlots(save: Save, team: Obj): Obj[] {
  return save.slots(team).filter((s) => s.jobType === JOB.Driver);
}

function slotOf(save: Save, team: Obj, guid: string): Obj {
  const slot = save.slots(team).find((s) => s.personHired && save.g.deref<Obj>(s.personHired).id === guid);
  if (!slot) throw new Error(`${team.name}: nobody with id ${guid} on the team`);
  return slot;
}

/** Swap the people in two of a team's slots, with their status and car (Team.PromoteDriver does the slots and status). */
function swapSlots(save: Save, a: Obj, b: Obj) {
  const g = save.g;
  const pa = g.deref<Obj>(a.personHired), pb = g.deref<Obj>(b.personHired);
  a.personHired = g.ref(pb);
  b.personHired = g.ref(pa);
  const ca = save.contract(pa), cb = save.contract(pb);
  [ca.mCurrentStatus, cb.mCurrentStatus] = [cb.mCurrentStatus, ca.mCurrentStatus];
  [ca.mProposedStatus, cb.mProposedStatus] = [cb.mProposedStatus, ca.mProposedStatus];
  [pa.mCarID, pb.mCarID] = [pb.mCarID, pa.mCarID];
}

/** MM's Team.ClearSelectedDriversForSession: the game picks the drivers again when the next session starts. */
function clearSessionDrivers(team: Obj) {
  for (const e of Array.isArray(team.mSelectedSessionDrivers) ? team.mSelectedSessionDrivers : []) e.Value = [];
  for (const e of Array.isArray(team.mVehicleSessionDrivers) ? team.mVehicleSessionDrivers : []) e.Value = null;
}

export interface PromoteDriverOp {
  op: "promoteDriver";
  team: string | number;
  /** GUID of the reserve driver who takes the race seat. */
  reserve: string;
  /** GUID of the race driver who becomes the reserve. */
  driver: string;
}

/**
 * The reserve driver takes a race driver's seat and status, and the race driver becomes the
 * reserve, as MM's ContractManagerTeam.PromoteDriver (without its morale change). A demoted
 * driver who hasn't raced this season leaves the standings, as in MM.
 */
export function promoteDriver(save: Save, op: PromoteDriverOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const slots = driverSlots(save, team);
  const up = slotOf(save, team, op.reserve), down = slotOf(save, team, op.driver);
  const upIdx = slots.indexOf(up), downIdx = slots.indexOf(down);
  if (downIdx < 0 || downIdx > 1) throw new Error(`${team.name}: ${op.driver} isn't a race driver`);
  if (upIdx < 2) throw new Error(`${team.name}: ${op.reserve} isn't the reserve driver`);
  const promoted = g.deref<Obj>(up.personHired), demoted = g.deref<Obj>(down.personHired);
  swapSlots(save, down, up);
  save.contract(demoted).mCurrentStatus = DRIVER_STATUS.Reserve;
  save.contract(demoted).mProposedStatus = DRIVER_STATUS.Reserve;
  clearSessionDrivers(team);
  const st = g.deref<Obj>(save.championship(team).standings);
  const rows = g.rawList(st.mDrivers);
  const i = rows.findIndex((r) => g.deref<Obj>(g.deref<Obj>(r).mEntity) === demoted);
  if (i >= 0 && !(g.deref<Obj>(rows[i]).races > 0)) rows.splice(i, 1);
  ensureStandingsEntry(save, team, promoted);
  ensureMechanicRelationships(save, team);
  return `${team.name}: ${personName(promoted)} promoted to car ${downIdx + 1}, ${personName(demoted)} now reserve`;
}

export interface SwapCarDriversOp {
  op: "swapCarDrivers";
  team: string | number;
}

/** The two race drivers swap cars. Mechanics stay with their car. */
export function swapCarDrivers(save: Save, op: SwapCarDriversOp): string {
  const team = save.team(op.team);
  const [a, b] = driverSlots(save, team);
  if (!a?.personHired || !b?.personHired) throw new Error(`${team.name}: needs two race drivers to swap cars`);
  swapSlots(save, a, b);
  clearSessionDrivers(team);
  const p = (s: Obj) => personName(save.g.deref<Obj>(s.personHired));
  return `${team.name}: car 1 ${p(a)}, car 2 ${p(b)}`;
}

export interface SwapMechanicsOp {
  op: "swapMechanics";
  team: string | number;
}

/** The two race mechanics swap drivers (ContractManagerTeam.SwapMechanicForDriver). */
export function swapMechanics(save: Save, op: SwapMechanicsOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const mechanics = save.slots(team).filter((s) => s.jobType === JOB.Mechanic && s.personHired).map((s) => g.deref<Obj>(s.personHired));
  if (mechanics.length !== 2) throw new Error(`${team.name}: needs two mechanics to swap (has ${mechanics.length})`);
  const [a, b] = mechanics;
  [a.driver, b.driver] = [b.driver, a.driver];
  ensureMechanicRelationships(save, team);
  return `${team.name}: ${personName(a)} now on car ${Number(a.driver) + 1}, ${personName(b)} on car ${Number(b.driver) + 1}`;
}

export interface ReleasePersonOp {
  op: "releasePerson";
  team: string | number;
  person: string;
}

/**
 * Release someone to the free-agent market, leaving their slot empty. Only the reserve driver:
 * MM can't race with an empty race seat, engineer or mechanic, so those are released by signing
 * a replacement (`hire` with `replacing`).
 */
export function releasePerson(save: Save, op: ReleasePersonOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const slot = slotOf(save, team, op.person);
  const idx = driverSlots(save, team).indexOf(slot);
  const p = g.deref<Obj>(slot.personHired);
  if (idx < 2) throw new Error(`${team.name}: only the reserve driver can leave without a replacement (${personName(p)} is ${idx < 0 ? personKind(p).toLowerCase() : "a race driver"})`);
  release(save, p);
  slot.personHired = null;
  const cached = g.rawList(save.contractManager(team).mCachedPeople);
  const i = cached.findIndex((x) => g.deref(x) === p);
  if (i >= 0) cached.splice(i, 1);
  for (const s of g.list<Obj>(save.contractManager(team).mNextYearEmployeeSlots)) {
    if (s.personHired && g.deref(s.personHired) === p) s.personHired = null;
  }
  return `${team.name}: released reserve driver ${personName(p)}`;
}
