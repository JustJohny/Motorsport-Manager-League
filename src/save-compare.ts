// What changed between two saves of the same career, team by team, in plain words: budget, HQ,
// parts, the design in progress, staff, sponsors and standings. The TUI's Compare screen shows it;
// `diffSaves` (src/diff.ts) has the raw field-level view.
import type { Obj } from "./graph.ts";
import { building, part } from "./extract.ts";
import { JOBS, PART_TYPES, Save, numOrNull, personName, type PartType } from "./model.ts";
import { carPartDesign } from "./ops/design.ts";
import { teamSponsors } from "./ops/sponsors.ts";
import { SPONSOR_SLOTS } from "./league-types.ts";

export type ChangeArea = "Team" | "Budget" | "HQ" | "Parts" | "Design" | "Staff" | "Sponsors" | "Standings";

export interface Change {
  area: ChangeArea;
  text: string;
  /** Good or bad for the team, where it's obvious (money, positions). */
  tone?: "up" | "down";
}

export interface TeamChanges {
  teamID: number;
  name: string;
  /** The name in the first save (differs after a rename). */
  fromName: string;
  championship: string;
  changes: Change[];
}

export interface SaveComparison {
  a: { gameDate: string; teams: number; freeAgents: number };
  b: { gameDate: string; teams: number; freeAgents: number };
  teams: TeamChanges[];
}

const money = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(Math.round(v)).toLocaleString("en-US")}`;
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const one = (v: number | null) => (v == null ? "—" : String(Math.round(v * 10) / 10));

function standingsOf(save: Save) {
  const out = new Map<number, { position: number; points: number }>();
  for (const ch of save.g.list<Obj>(save.data.championshipManager.mEntities ?? [])) {
    const st = ch?.standings ? save.g.deref<Obj>(ch.standings) : null;
    for (const e of st ? save.g.list<Obj>(st.mTeams ?? []) : []) {
      const t = save.g.deref<Obj>(e.mEntity);
      const points = numOrNull(e.mPoints?.[Math.max(0, (e.races ?? 1) - 1)]) ?? 0;
      if (t) out.set(t.teamID as number, { position: e.mCurrentPosition as number, points });
    }
  }
  return out;
}

function partsOf(save: Save, t: Obj) {
  const out: { type: PartType; p: ReturnType<typeof part> }[] = [];
  for (const type of PART_TYPES) {
    let list: Obj[] = [];
    try { list = save.parts(t, type); } catch { continue; }
    for (const p of list) if (p) out.push({ type, p: part(save, p) });
  }
  return out;
}

function staffOf(save: Save, t: Obj) {
  return new Map(save.slots(t).map((s) => {
    const p = s.personHired ? save.g.deref<Obj>(s.personHired) : null;
    const c = p ? save.contract(p) : null;
    return [`${s.jobType}:${s.slotID}`, { job: JOBS[s.jobType as number] ?? String(s.jobType), name: p ? personName(p) : null, wage: c?.yearlyWages as number | undefined }];
  }));
}

function designOf(save: Save, t: Obj) {
  const cpd = carPartDesign(save, t);
  if (!cpd || cpd.mStage !== 1 || !cpd.mCarPart) return null;
  const p = save.g.deref<Obj>(cpd.mCarPart);
  return { type: String(p?.$type ?? "").replace(/Part$/, ""), end: String(cpd.endDate).slice(0, 10) };
}

const JOB_ORDER = ["Driver", "EngineerLead", "Mechanic"];

/** Every change on one team between save `a` and save `b`. */
export function compareTeam(a: Save, ta: Obj, b: Save, tb: Obj, st: { a: ReturnType<typeof standingsOf>; b: ReturnType<typeof standingsOf> }): Change[] {
  const out: Change[] = [];
  if (ta.name !== tb.name) out.push({ area: "Team", text: `Renamed: ${ta.name} → ${tb.name}` });
  if ((ta.mShortName ?? "") !== (tb.mShortName ?? "")) out.push({ area: "Team", text: `Short name: ${ta.mShortName} → ${tb.mShortName}` });

  const ba = Number(a.finance(ta).currentBudget), bb = Number(b.finance(tb).currentBudget);
  if (ba !== bb) out.push({ area: "Budget", text: `${money(bb - ba)} (now $${Math.round(bb).toLocaleString("en-US")})`, tone: bb > ba ? "up" : "down" });

  const sa = st.a.get(ta.teamID as number), sb = st.b.get(tb.teamID as number);
  if (sa && sb && (sa.position !== sb.position || sa.points !== sb.points)) {
    out.push({ area: "Standings", text: `P${sa.position} → P${sb.position}, ${sa.points} → ${sb.points} pts`, tone: sb.position < sa.position ? "up" : sb.position > sa.position ? "down" : undefined });
  }

  // HQ, by building type.
  const ha = new Map(a.buildings(ta).map((x) => building(a, x)).map((x) => [x.type, x]));
  for (const hb of b.buildings(tb).map((x) => building(b, x))) {
    const h0 = ha.get(hb.type);
    if (!h0) continue;
    const label = (x: typeof hb) => (x.state === "NotBuilt" ? "not built" : x.state === "BuildingInProgress" ? "being built" : x.state === "Upgrading" ? `level ${x.level}, upgrading` : `level ${x.level}`);
    if (h0.level !== hb.level || h0.state !== hb.state) {
      const until = hb.state === "BuildingInProgress" || hb.state === "Upgrading" ? ` (done ${String(hb.progressEnd).slice(0, 10)})` : "";
      out.push({ area: "HQ", text: `${hb.name}: ${label(h0)} → ${label(hb)}${until}` });
    }
  }

  // Design in progress.
  const da = designOf(a, ta), db = designOf(b, tb);
  if (JSON.stringify(da) !== JSON.stringify(db)) {
    if (db && (!da || da.type !== db.type || da.end !== db.end)) out.push({ area: "Design", text: `Designing ${db.type}, done ${db.end}` });
    else if (da && !db) out.push({ area: "Design", text: `${da.type} design finished or cancelled` });
  }

  // Parts, by GUID.
  const pa = new Map(partsOf(a, ta).map((x) => [x.p.guid, x]));
  const pb = new Map(partsOf(b, tb).map((x) => [x.p.guid, x]));
  for (const [guid, x] of pb) {
    const y = pa.get(guid);
    if (!y) { out.push({ area: "Parts", text: `New ${x.type} ${x.p.name} (level ${x.p.level}, stat ${one(x.p.stat)} + ${one(x.p.performance ?? 0)}, reliability ${pct(x.p.reliability)})`, tone: "up" }); continue; }
    const bits: string[] = [];
    // Only what shows after rounding (MM's screens round the same way).
    if (one(x.p.performance ?? 0) !== one(y.p.performance ?? 0)) bits.push(`perf. ${one(y.p.performance ?? 0)} → ${one(x.p.performance ?? 0)}`);
    if (pct(x.p.reliability) !== pct(y.p.reliability)) bits.push(`reliability ${pct(y.p.reliability)} → ${pct(x.p.reliability)}`);
    if (x.p.fittedToCar !== y.p.fittedToCar) bits.push(x.p.fittedToCar == null ? `taken off car ${(y.p.fittedToCar ?? 0) + 1}` : `fitted to car ${x.p.fittedToCar + 1}`);
    if (bits.length) out.push({ area: "Parts", text: `${x.type} ${x.p.name}: ${bits.join(", ")}` });
  }
  for (const [guid, y] of pa) if (!pb.has(guid)) out.push({ area: "Parts", text: `Gone: ${y.type} ${y.p.name}`, tone: "down" });

  // Staff, by contract slot.
  const fa = staffOf(a, ta), fb = staffOf(b, tb);
  const keys = [...new Set([...fa.keys(), ...fb.keys()])].sort((x, y) => JOB_ORDER.indexOf(fa.get(x)?.job ?? fb.get(x)!.job) - JOB_ORDER.indexOf(fa.get(y)?.job ?? fb.get(y)!.job));
  for (const k of keys) {
    const x = fa.get(k), y = fb.get(k);
    const job = (y ?? x)!.job;
    if (!JOB_ORDER.includes(job)) continue;
    if (x?.name !== y?.name) out.push({ area: "Staff", text: `${job}: ${x?.name ?? "vacant"} → ${y?.name ?? "vacant"}` });
    else if (x?.wage !== y?.wage && x?.name) out.push({ area: "Staff", text: `${job} ${x.name}: wage $${(x.wage ?? 0).toLocaleString("en-US")} → $${(y?.wage ?? 0).toLocaleString("en-US")}` });
  }

  // Sponsors, by slot.
  const sna = new Map((teamSponsors(a, ta)?.onCar ?? []).map((s) => [s.slot, s.sponsor]));
  const snb = new Map((teamSponsors(b, tb)?.onCar ?? []).map((s) => [s.slot, s.sponsor]));
  for (let slot = 0; slot < 6; slot++) {
    const x = sna.get(slot), y = snb.get(slot);
    if (x !== y) out.push({ area: "Sponsors", text: `${SPONSOR_SLOTS[slot]}: ${x ?? "empty"} → ${y ?? "empty"}` });
  }
  return out;
}

/** Every team in both saves (matched by teamID) that changed, in championship order. */
export function compareSaves(a: Save, b: Save): SaveComparison {
  const st = { a: standingsOf(a), b: standingsOf(b) };
  const bTeams = new Map(b.teams().map((t) => [t.teamID as number, t]));
  const teams: TeamChanges[] = [];
  for (const ta of a.teams()) {
    const tb = bTeams.get(ta.teamID as number);
    if (!tb || !ta.championship) continue;
    const changes = compareTeam(a, ta, b, tb, st);
    if (changes.length) teams.push({ teamID: ta.teamID as number, name: tb.name as string, fromName: ta.name as string, championship: b.championshipName(b.championship(tb)), changes });
  }
  const info = (s: Save) => ({ gameDate: s.now, teams: s.teams().length, freeAgents: s.people().filter((p) => s.isFreeAgent(p)).length });
  return { a: info(a), b: info(b), teams };
}
