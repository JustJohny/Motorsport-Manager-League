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

export interface Championship {
  id: number;
  name: string;
  eventNumber: number;
  calendar: CalendarEvent[];
  standings: { drivers: DriverStanding[]; teams: TeamStanding[] };
  lastRace: RaceResults | null;
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
  progressEnd: string;
  /** Cost to go from level n to n+1 is upgradeCosts[n-1]. */
  upgradeCosts: (number | null)[];
  /** Cost to build level 1. */
  initialCost: number | null;
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
export type TeamPublic = Omit<TeamState, "budget" | "hq" | "parts">;
export type TeamPrivate = Pick<TeamState, "budget" | "hq" | "parts">;

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
