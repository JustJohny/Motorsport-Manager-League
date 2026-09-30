import { num, readSav, writeSav, type Json, type SaveFile } from "./codec/sav.ts";
import { Graph, type Obj } from "./graph.ts";
import { loadSchema, Types } from "./schema.ts";

// Enum values mirrored from the game (see docs/save-schema.md).
export const PART_TYPES = [
  "Brakes", "Engine", "FrontWing", "Gearbox", "RearWing", "Suspension",
  "RearWingGT", "BrakesGT", "EngineGT", "GearboxGT", "SuspensionGT",
  "BrakesGET", "EngineGET", "FrontWingGET", "GearboxGET", "RearWingGET", "SuspensionGET",
] as const;
export type PartType = (typeof PART_TYPES)[number];

export const BUILDING_STATES = ["NotBuilt", "BuildingInProgress", "Constructed", "Upgrading"] as const;

export const JOBS: Record<number, string> = {
  0: "Driver", 1: "Staff", 2: "Engineer", 3: "EngineerLead", 4: "TeamAssistant", 5: "TeamPrincipal",
  6: "Scout", 7: "Mechanic", 8: "Chairman", 18: "Unemployed",
};
export const JOB = { Driver: 0, EngineerLead: 3, Mechanic: 7, Unemployed: 18 } as const;
export const CONTRACT_STATUS = { InProposalState: 0, OnGoing: 1, InOptionClause: 2, Terminated: 3 } as const;

export const NULL_DATE = "0001-01-01T00:00:00.0000000";

/** A loaded save plus navigation helpers over its object graph. */
export class Save {
  readonly g: Graph;
  readonly types: Types;

  constructor(readonly file: SaveFile) {
    this.g = new Graph(file.data);
    this.types = new Types(loadSchema());
    this.types.record(file.data);
    this.g.onClone = (original, copy) => {
      const t = this.types.runtime.get(original);
      if (t) this.types.runtime.set(copy, t);
    };
  }

  static load(path: string): Save {
    return new Save(readSav(path));
  }

  /**
   * Put the object graph back in the layout the game can read: every definition at its first
   * occurrence, with "$type" added wherever it now sits in a field of a different declared type.
   */
  prepareForWrite(): void {
    this.g.normalizeRefOrder();
    const { unknown } = this.types.annotate(this.data);
    if (unknown) throw new Error(`${unknown} object(s) with unknown runtime type; the game could not load them`);
  }

  write(path: string): void {
    this.prepareForWrite();
    const problems = this.g.validate();
    if (problems.length) throw new Error(`Refusing to write an invalid save:\n  ${problems.slice(0, 10).join("\n  ")}`);
    writeSav(path, this.file);
  }

  get data(): Obj { return this.file.data; }

  /** Current in-game date/time as a C# DateTime string. */
  get now(): string { return this.data.time.mNow; }

  teams(): Obj[] {
    return this.g.list(this.data.teamManager.mEntities);
  }

  team(key: string | number): Obj {
    const t = this.teams().find((t) =>
      typeof key === "number" ? t.teamID === key : t.name === key || t.id === key || String(t.teamID) === key);
    if (!t) throw new Error(`No team ${JSON.stringify(key)}`);
    return t;
  }

  championship(team: Obj): Obj {
    return this.g.deref(team.championship);
  }

  championshipName(ch: Obj): string {
    return ch.mCustomChampionshipName && ch.mCustomChampionshipName !== "0" ? ch.mCustomChampionshipName : ch.mName;
  }

  contractManager(team: Obj): Obj {
    return this.g.deref(team.contractManager);
  }

  slots(team: Obj): Obj[] {
    return this.g.list(this.contractManager(team).mEmployeeSlots);
  }

  buildings(team: Obj): Obj[] {
    return this.g.list(this.g.deref<Obj>(team.headquarters).hqBuildings);
  }

  buildingInfo(b: Obj): Obj {
    return this.g.deref(b.info);
  }

  cars(team: Obj): Obj[] {
    return this.g.list(this.g.deref<Obj>(team.carManager).mCar);
  }

  finance(team: Obj): Obj {
    return this.g.deref(this.g.deref<Obj>(team.financeController).finance);
  }

  /** Raw array holding a team's parts of one type. */
  partList(team: Obj, type: PartType): Json[] {
    const inv = this.g.deref<Obj>(this.g.deref<Obj>(team.carManager).partInventory);
    const key = type[0].toLowerCase() + type.slice(1) + "Inventory";
    if (!(key in inv)) throw new Error(`No inventory ${key}`);
    return this.g.rawList(inv[key]);
  }

  parts(team: Obj, type: PartType): Obj[] {
    return this.partList(team, type).map((p) => this.g.deref<Obj>(p));
  }

  /** Every person in the driver, engineer and mechanic pools. */
  people(): Obj[] {
    const pools = [this.data.driverManager, this.data.engineerManager, this.data.mechanicManager];
    return pools.flatMap((m) => this.g.list(m.mEntities));
  }

  person(id: string): Obj {
    const p = this.people().find((p) => p.id === id);
    if (!p) throw new Error(`No person with id ${id}`);
    return p;
  }

  contract(person: Obj): Obj {
    return this.g.deref(person.contract);
  }

  employer(person: Obj): Obj | null {
    const c = this.contract(person);
    return c.employeer ? this.g.deref(c.employeer) : null;
  }

  isFreeAgent(person: Obj): boolean {
    return this.employer(person) === null && this.contract(person).job === JOB.Unemployed;
  }
}

export function personName(p: Obj): string {
  return `${p.mFirstName} ${p.mLastName}`;
}

export function personKind(p: Obj): "Driver" | "Engineer" | "Mechanic" | string {
  return p.$type ?? "Driver"; // drivers are the declared list type, so they carry no $type
}

export function numOrNull(v: Json): number | null {
  return v == null ? null : num(v);
}

/** Add days to a C# DateTime string, keeping its format. */
export function addDays(date: string, days: number): string {
  const d = new Date(date.slice(0, 19) + "Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19) + ".0000000";
}
