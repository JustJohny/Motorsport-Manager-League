// Shapes of the league data the toolkit exports and the website reads.
// This file must not import anything: the website (site/) imports it directly.

export interface LeagueConfig {
  /** Championship the league runs in, by name ("European Racing Series") or championshipID. */
  championship?: string | number;
  /**
   * `discord` is the member's Discord username, which the website uses to match logins to teams.
   * `organizer: true` lets that member see every team's private data on the website.
   */
  members: { member: string; team: string | number; discord?: string; organizer?: boolean }[];
}

export interface CalendarEvent {
  round: number;
  date: string;
  circuit: string;
  layout: number;
  ended: boolean;
}

interface StandingBase {
  name: string;
  position: number;
  points: number;
  races: number;
  wins: number;
  podiums: number;
  dnfs: number;
}
export interface DriverStanding extends StandingBase { guid: string; team: string | null }
export interface TeamStanding extends StandingBase { teamID: number }

export interface SessionResult {
  position: number;
  driver: string;
  driverGuid: string;
  team: string | null;
  grid: number;
  laps: number;
  /** Seconds. */
  time: number | null;
  bestLap: number | null;
  stops: number;
  points: number;
  carState: number;
}

export interface RaceResults {
  round: number;
  circuit: string;
  date: string;
  qualifying: SessionResult[];
  race: SessionResult[];
}

/**
 * A part caught by MM's post-race scrutineering (PenaltyDirector.ScrutinizePartRules): the car
 * dropped `placesLost` places in the race result and the team paid `fine`. Public, like a
 * stewards' decision; which part it was stays with the team (TeamDesign.rules).
 */
export interface RulesBreach {
  round: number;
  circuit: string;
  date: string;
  team: string | null;
  driver: string;
  placesLost: number;
  fine: number;
}

export interface Championship {
  id: number;
  name: string;
  eventNumber: number;
  calendar: CalendarEvent[];
  standings: { drivers: DriverStanding[]; teams: TeamStanding[] };
  lastRace: RaceResults | null;
  /** Every part caught this season. Missing in snapshots published before 2026-10-01. */
  rulesBreaches?: RulesBreach[];
}

export type BuildingState = "NotBuilt" | "BuildingInProgress" | "Constructed" | "Upgrading";

export interface Building {
  type: number;
  name: string;
  state: BuildingState;
  /** 0 = not built, otherwise the level shown in game (1..maxLevel). BuildingInProgress reports 1. */
  level: number;
  maxLevel: number;
  progress: number | null;
  /** When the current construction started (who started it: see league-rules unorderedProject). */
  progressStart: string;
  progressEnd: string;
  /** Cost to go from level n to n+1 is upgradeCosts[n-1]. */
  upgradeCosts: (number | null)[];
  /** Cost to build level 1. */
  initialCost: number | null;
  /** MM's build time for level 1, in weeks. */
  buildWeeks: number;
  /** MM's time to go from level n to n+1 is upgradeWeeks[n-1], in weeks. */
  upgradeWeeks: number[];
  dependencies: { buildingType: number; requiredLevel: number }[];
}

export interface Part {
  guid: string;
  name: string;
  /** Game class name, e.g. "FrontWingPart". */
  type: string;
  level: number;
  stat: number | null;
  performance: number | null;
  maxPerformance: number | null;
  reliability: number | null;
  maxReliability: number | null;
  condition: number | null;
  rulesRisk: number | null;
  /** 0 or 1, or null when in storage. */
  fittedToCar: number | null;
  buildDate: string;
  components: number;
  /** Ids of the components it was designed with (matches league design orders). */
  componentIds: number[];
}

/** One component a team can put in a design (see src/part-design.ts). */
export interface DesignComponent {
  id: number;
  level: number;
  /** A lead engineer's own component (ComponentType.Engineer): never charged per slot level. */
  engineer: boolean;
  statBoost: number;
  maxStatBoost: number;
  reliabilityBoost: number;
  maxReliabilityBoost: number;
  /** Own cost / production days; 0 means "use the slot level's" (non-engineer only). */
  cost: number;
  days: number;
  risk: number;
  bonuses: { type: string; value: number }[];
  /** MM's own rich-text summary, e.g. "<b>Performance:</b> +10". MM components have no names. */
  summary: string;
}

export interface DesignSettings {
  materialsCost: number;
  buildTimeDays: number;
  costPerLevel: number[];
  timePerLevel: number[];
}

export interface DesignContext {
  settings: DesignSettings;
  /** Normal slots: highest level of a part of this type in inventory + 1, clamped 1..5. */
  slots: number;
  /** Design Centre currentLevel when built, else null. */
  designCentreLevel: number | null;
  /** The player's career team pays full materials; AI teams 10 %. */
  isPlayer: boolean;
  /** The player's backstory time reduction, in days (player team only). */
  playerTimeModifierDays?: number;
}

/** A new part before its components, as MM's SetBaseStats makes it. */
export interface DesignBase {
  /** Season starting stat + 1.5 x the lead engineer's skill for this part. */
  stat: number;
  /** The chassis' improvability. */
  maxPerformance: number;
  reliability: number;
  maxReliability: number;
  /** The team's development rate for this part: components' stat boosts are multiplied by it. */
  developmentRate: number;
}

export interface PartDesignOptions {
  ctx: DesignContext;
  base: DesignBase;
  components: DesignComponent[];
  /** Highest component level the HQ allows now (1..5). */
  maxLevel: number;
  /** What opens the next levels: building type and the level it must reach (as shown in game). */
  locked: { level: number; buildingType: number; buildingLevel: number }[];
}

export interface TeamDesign {
  /** Part type ("FrontWing") -> what the team can design for it. */
  types: Record<string, PartDesignOptions>;
  /**
   * Part types that are spec in this championship (championship.rules.specParts, e.g. ERS
   * engines and gearboxes): every team runs the supplier's part, so they can't be designed or
   * improved. Missing in snapshots published before 2026-10-01.
   */
  specParts?: string[];
  /** The design in progress (MM designs one part at a time). */
  current: { type: string; components: number[]; start: string; end: string; extraCopies: number } | null;
  /** MM's scrutineering for this team (missing in snapshots published before 2026-10-01). */
  rules?: {
    /** Offences this season: the next bust costs 2 x (this + 1) places and $100K x (this + 1). */
    brokenThisSeason: number;
    /** The investor's part-risk bonus, added to every risky part's risk. */
    riskBonus: number;
    /** This team's own busts, with the part. */
    breaches: (RulesBreach & { part: string; partType: string })[];
  };
  improvement: {
    /** Part GUIDs the mechanics work on. */
    performance: string[];
    reliability: string[];
    /** Share of the mechanics on performance, 0..1. */
    split: number;
    /** Parts per list: 2/4/6/8 for Factory level 0-3. */
    slots: number;
    mechanics: number;
  };
}

export interface Person {
  guid: string;
  name: string;
  kind: "Driver" | "Engineer" | "Mechanic" | string;
  dateOfBirth: string;
  nationality: string | null;
  stats: Record<string, number | null>;
  potential: number | null;
  carID: number | null;
  contract: {
    team: string | null;
    job: string;
    yearlyWages: number;
    start: string;
    end: string;
  };
}

export interface StaffSlot {
  slotID: number;
  job: string;
  person: Person | null;
}

export interface TeamState {
  member: string | null;
  teamID: number;
  guid: string;
  name: string;
  isPlayerTeam: boolean;
  budget: number | null;
  reputation: number;
  marketability: number | null;
  fanBase: number | null;
  hq: Building[];
  /** Part type ("FrontWing") -> parts the team owns. */
  parts: Record<string, Part[]>;
  /** Part design, fitting and improvement (single-seater series only). */
  design: TeamDesign | null;
  staff: StaffSlot[];
}

export interface LeagueState {
  extractedAt: string;
  gameDate: string;
  championship: Championship;
  teams: TeamState[];
  freeAgents: Person[];
}

/**
 * What every league member may see about a team. Budget, HQ and parts stay private to the
 * team's member (and the organizer), as MM itself hides them for rival teams.
 */
export type TeamPublic = Omit<TeamState, "budget" | "hq" | "parts" | "design">;
export type TeamPrivate = Pick<TeamState, "budget" | "hq" | "parts" | "design">;

export interface PublicSnapshot {
  extractedAt: string;
  gameDate: string;
  championship: Championship;
  teams: TeamPublic[];
}

export interface SplitSnapshot {
  public: PublicSnapshot;
  teams: { team: string; private: TeamPrivate }[];
  freeAgents: Person[];
}

export interface LeagueMemberRow {
  discord_username: string;
  member: string;
  team: string;
  role: "member" | "organizer";
}
