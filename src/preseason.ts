import type { Person, StaffSlot } from "./league-types.ts";

/**
 * The save changes a replay makes: the same shapes as the toolkit's `hire`, `promoteDriver`,
 * `swapCarDrivers`, `swapMechanics` and `releasePerson` ops (src/ops/staff.ts), kept here so the
 * site doesn't import the toolkit.
 */
export type LineupChange =
  | { op: "hire"; team: string; person: string; replacing?: string; slotID?: number; yearlyWages?: number; endDate?: string }
  | { op: "promoteDriver"; team: string; reserve: string; driver: string }
  | { op: "swapCarDrivers"; team: string }
  | { op: "swapMechanics"; team: string }
  | { op: "releasePerson"; team: string; person: string };

/**
 * The league's pre-season (the user's rules, 2026-10-09): while the organizer has it open, members
 * sign free agents straight away (first come wins, no fees, the market's opening wage, 1..max
 * seasons), rearrange their own team (promote the reserve, swap cars, swap mechanics, release
 * anyone) and pick this season's suppliers for free. Moves are kept in order and replayed here,
 * both by the site (to show the line-up) and by `mmsave pull` (to build the save changes).
 */
export type PreseasonMoveKind = "sign" | "promote" | "swapCars" | "swapMechanics" | "release";

/** A row of league.preseason_moves (numeric columns may arrive as strings). */
export interface PreseasonMove {
  id: number;
  team: string;
  kind: PreseasonMoveKind;
  /** sign: the free agent; promote: the reserve; release: who goes. */
  person_guid: string | null;
  person_name: string | null;
  /** sign: who they replace (null = an empty seat); promote: the race driver who steps down. */
  other_guid: string | null;
  other_name: string | null;
  years: number | null;
  yearly_wage: number | string | null;
  /** sign: the contract's end (C# date). */
  new_end: string | null;
  /** sign: the free agent as published, so the site can show them in their new seat. */
  person: Person | null;
  status: string;
  created_at: string;
}

export type SeatRole = "car1" | "car2" | "reserve" | "engineer" | "mechanic" | "other";

export interface Seat {
  slotID: number;
  job: string;
  role: SeatRole;
  /** Who sits there after the moves; null when empty or released. */
  person: Person | null;
  /** Released by a move but still in the save until someone takes the seat (or the pull ends). */
  leaving: Person | null;
  /** Signed in pre-season (by this team's moves). */
  signed: boolean;
  /** MM can't race without someone here. */
  required: boolean;
}

export interface Lineup {
  seats: Seat[];
  /** The save changes, in order. */
  changes: LineupChange[];
  /** Moves that no longer fit the line-up (skipped), by move id. */
  invalid: Map<number, string>;
  /** People released from a seat MM needs filled: they stay. */
  kept: Person[];
}

const KIND_JOB: Record<string, string> = { Driver: "Driver", Engineer: "EngineerLead", Mechanic: "Mechanic" };

/** The team's seats in MM's slot order, with their role (car 1, car 2, reserve…); spare slots are "other". */
export function seats(staff: StaffSlot[]): Seat[] {
  let drivers = 0;
  return staff.filter((s) => ["Driver", "EngineerLead", "Mechanic"].includes(s.job)).map((s) => {
    // MM's third driver slot is the reserve; FF20 teams have spare driver slots past it, which aren't seats.
    const role: SeatRole = s.job === "Driver" ? ((["car1", "car2", "reserve"][drivers++] ?? "other") as SeatRole)
      : s.job === "EngineerLead" ? "engineer" : "mechanic";
    return {
      slotID: s.slotID, job: s.job, role, person: s.person, leaving: null, signed: false,
      required: role === "car1" || role === "car2" || role === "engineer" || role === "mechanic",
    };
  });
}

/** The two mechanics' cars after the moves: mechanic GUID → car index. */
export function mechanicCars(lineup: Lineup): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of lineup.seats) if (s.role === "mechanic" && s.person?.mechanicCar != null) out.set(s.person.guid, s.person.mechanicCar);
  return out;
}

/**
 * Replay a team's queued moves (oldest first) over its published staff. A released person stays in
 * the save until someone is signed into their seat (one `hire` replacing them), so MM never sees an
 * empty race seat; a released reserve leaves at the end, and anyone else still unreplaced stays.
 */
export function replay(team: string, staff: StaffSlot[], moves: PreseasonMove[]): Lineup {
  const st = seats(staff).map((s) => ({ ...s, person: s.person ? { ...s.person } : null }));
  const changes: LineupChange[] = [];
  const invalid = new Map<number, string>();
  const seatOf = (guid: string | null) => (guid ? st.find((s) => s.person?.guid === guid) : undefined);
  /** Who MM has in the seat: the person, or the one leaving it. */
  const inSave = (s: Seat) => s.person ?? s.leaving;

  const time = (m: PreseasonMove) => new Date(m.created_at).getTime();
  for (const m of [...moves].sort((a, b) => time(a) - time(b) || Number(a.id) - Number(b.id))) {
    const bad = (why: string) => invalid.set(m.id, why);
    if (m.kind === "sign") {
      const p = m.person;
      if (!p || !m.person_guid) { bad("No free agent"); continue; }
      const job = KIND_JOB[p.kind];
      const seat = m.other_guid ? seatOf(m.other_guid)
        : st.find((s) => s.job === job && !s.person && (s.leaving || s.role !== "other"));
      if (!seat) { bad(m.other_guid ? `${m.other_name ?? "That person"} isn't on the team any more` : `No free ${p.kind.toLowerCase()} seat`); continue; }
      if (seat.job !== job) { bad(`${p.name} can't take a ${seat.job === "EngineerLead" ? "engineer" : seat.job.toLowerCase()}'s seat`); continue; }
      const out = inSave(seat);
      changes.push({
        op: "hire", team, person: p.guid, ...(out ? { replacing: out.guid } : { slotID: seat.slotID }),
        yearlyWages: Number(m.yearly_wage), endDate: m.new_end ?? undefined,
      });
      // The newcomer takes the seat's car and mechanic pairing, as `hire` does.
      seat.person = { ...p, mechanicCar: out?.mechanicCar ?? p.mechanicCar ?? null, status: out?.status ?? (seat.role === "reserve" ? "Reserve" : p.status) };
      seat.leaving = null;
      seat.signed = true;
    } else if (m.kind === "promote") {
      const up = seatOf(m.person_guid), down = st.find((s) => inSave(s)?.guid === m.other_guid);
      if (!up || up.role !== "reserve") { bad(`${m.person_name} isn't the reserve driver`); continue; }
      if (!down || (down.role !== "car1" && down.role !== "car2")) { bad(`${m.other_name} isn't in a race seat`); continue; }
      changes.push({ op: "promoteDriver", team, reserve: up.person!.guid, driver: inSave(down)!.guid });
      const promoted = up.person!;
      [up.person, up.leaving, up.signed, down.person, down.leaving, down.signed] = [down.person, down.leaving, down.signed, promoted, null, up.signed];
      if (up.person) up.person.status = "Reserve";
    } else if (m.kind === "swapCars") {
      const [a, b] = [st.find((s) => s.role === "car1"), st.find((s) => s.role === "car2")];
      if (!a || !b || !inSave(a) || !inSave(b)) { bad("Needs two race drivers"); continue; }
      changes.push({ op: "swapCarDrivers", team });
      [a.person, a.leaving, a.signed, b.person, b.leaving, b.signed] = [b.person, b.leaving, b.signed, a.person, a.leaving, a.signed];
    } else if (m.kind === "swapMechanics") {
      const mech = st.filter((s) => s.role === "mechanic" && inSave(s));
      if (mech.length !== 2) { bad("Needs two mechanics"); continue; }
      changes.push({ op: "swapMechanics", team });
      const [a, b] = mech.map(inSave) as Person[];
      [a.mechanicCar, b.mechanicCar] = [b.mechanicCar, a.mechanicCar];
    } else if (m.kind === "release") {
      const seat = seatOf(m.person_guid);
      if (!seat) { bad(`${m.person_name} isn't on the team any more`); continue; }
      // Someone signed earlier is in the save by now, so they leave like anyone else.
      seat.leaving = seat.person;
      seat.person = null;
      seat.signed = false;
    }
  }

  const kept: Person[] = [];
  for (const s of st) {
    if (!s.leaving) continue;
    if (s.required) {
      kept.push(s.leaving);
      s.person = s.leaving;
      s.leaving = null;
    } else {
      changes.push({ op: "releasePerson", team, person: s.leaving.guid });
    }
  }
  return { seats: st, changes, invalid, kept };
}
