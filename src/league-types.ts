// Shapes of the league data the toolkit exports and the website reads.
// This file must not import anything: the website (site/) imports it directly.

export interface LeagueConfig {
  /**
   * The series on the website this league file publishes to and pulls from: one per MM save.
   * `id` is a short slug (lower case, digits, dashes), `name` what the site shows.
   */
  series?: { id: string; name?: string };
  /** Championship the league runs in, by name ("European Racing Series") or championshipID. */
  championship?: string | number;
  /**
   * `discord` is the member's Discord username, which the website uses to match logins to teams.
   * `organizer: true` lets that member see every team's private data on the website.
   */
  members: { member: string; team: string | number; discord?: string; organizer?: boolean }[];
  /**
   * Looks for the AI teams (colours and a pinned livery), a file relative to the league file,
   * e.g. "f1-2016-looks.json". Member teams are never touched. See src/ai-looks.ts.
   */
  aiLooks?: string;
  /**
   * The game's MM_Data folder. With FIRE Fantasy 20 its race data export is read from here and
   * uploaded by `publish` (src/race-data.ts).
   */
  gameData?: string;
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
 * dropped `placesLost` places in the race result (FF20: 23, i.e. to the back) and the team paid `fine`. Public, like a
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

/** A rule definition (MM's PoliticalVote), e.g. "Short Practice Sessions" in group PracticeLength. */
export interface Rule {
  id: number;
  group: string;
  /** MM's effect summary, e.g. "Practice(Short)". */
  effect: string;
  /** English name from the game's text, or null when the game data wasn't found. */
  name: string | null;
  description: string | null;
  /** Team characteristics (see TEAM_CHARACTERISTICS in src/politics.ts) the rule helps or hurts. */
  beneficial: number[];
  detrimental: number[];
}

export type VoteChoice = "yes" | "no" | "abstain";

/** One of the season's rule votes, as MM scheduled it. */
export interface RuleVote {
  ruleId: number;
  /** MM's vote date. */
  date: string;
  /** Held in game (or concluded by the league), or still to come. */
  status: "held" | "upcoming";
  result?: { yes: number; no: number; abstained: number; accepted: boolean };
  /** Upcoming votes: how each AI team votes, by MM's logic (see predictAiVote). */
  aiVotes?: { team: string; vote: VoteChoice; power: number }[];
}

export interface Regulations {
  /** Game year the votes and next season's rules belong to. */
  season: number;
  /** Rule ids in force now, and confirmed for next season. */
  current: number[];
  next: number[];
  /** Every rule definition found in the save, by id (the organizer chooses from these). */
  rules: Record<number, Rule>;
  votes: RuleVote[];
  teams: { team: string; member: boolean; votingPower: number; characteristics: number[] }[];
}

export interface Championship {
  id: number;
  name: string;
  eventNumber: number;
  calendar: CalendarEvent[];
  /**
   * MM's pre-season (ERS 2016: 13 Dec to 5 Mar). At its start MM draws next season's suppliers, its AI
   * starts next year's car, and the calendar is reset to the new season. Missing before 2026-10-03.
   */
  preSeason?: { start: string; end: string };
  standings: { drivers: DriverStanding[]; teams: TeamStanding[] };
  lastRace: RaceResults | null;
  /** Every finished round this season, in calendar order. Missing in snapshots published before 2026-10-01. */
  races?: RaceResults[];
  /** Every part caught this season. Missing in snapshots published before 2026-10-01. */
  rulesBreaches?: RulesBreach[];
  /** Whose game rules apply (scrutineering etc.). Missing before 2026-10-08 (Rebirth). */
  game?: GameRules;
  /** Rules and the season's votes. Missing in snapshots published before 2026-10-01. */
  regulations?: Regulations;
  /** The series' pit crew rule. Missing in snapshots published before 2026-10-02. */
  pitCrew?: PitCrewRules;
  /** Every team's pit stops per finished round (MM's log), fastest first. Missing before 2026-10-02. */
  pitStops?: PitStopRound[];
  /** Livery patterns the championship's teams may use. Missing before 2026-10-05. */
  liveries?: LiveryOption[];
}

/** A livery pattern (MM's `LiveryData`), with its side-view colour mask for previews. */
export interface LiveryOption {
  id: number;
  /** MM's own number for it in the championship ("Livery 7"). */
  number: number;
  /** From the Livery Pack DLC. */
  dlc: boolean;
  /**
   * File name of the side-view mask in the site's livery image store (`tools/livery-masks.py`):
   * black = primary, red = secondary, green = tertiary, blue = trim. With `model` it's a render of
   * that car from the side (alpha 0 off the livery), drawn under `<model>-overlay.png`.
   */
  mask: string;
  /** FF20: the car model's asset prefix ("ff20-f1"): `<model>-car.glb`, `<model>-overlay.png`. */
  model?: string;
  /** FF20: the livery's UV colour key (base + detail) for the 3D car. */
  texture?: string;
  /** A display name when MM's number doesn't say it (FF20's own designs). */
  name?: string;
  /** Teams in the save that run it now. */
  usedBy?: string[];
}

/** Four "#rrggbb" livery colours, as members pick them (src/team-colours.ts derives the rest). */
export interface TeamColours {
  primary: string;
  secondary: string;
  tertiary: string;
  trim: string;
}

/** A team's colours and livery as the save has them. */
export interface TeamLookInfo {
  colorID: number;
  liveryID: number;
  /** From MM's Team Colours table; null for a league colour row (the site has those). */
  colours: TeamColours | null;
}

/** What `equalizeTeams` sets on every team (anything left out is untouched). Drivers keep their stats. */
export interface EqualizeSettings {
  budget?: number;
  /** Building name → level (0 = not built). */
  hq?: Record<string, number>;
  /** Designable part type → the stats every part of that type gets (spec parts are skipped). */
  parts?: Record<string, { stat: number; maxPerformance: number; reliability: number; maxReliability: number; level?: number }>;
  /** Every part type's development rate (component boosts are multiplied by it). */
  developmentRate?: number;
  /** The lead designer's part contributions (topSpeed, acceleration, braking, …Corners), 0..20 (FF20 0..25). */
  leadDesigner?: Record<string, number>;
  /** Every mechanic's stats (reliability, performance, concentration, speed, pitStops, leadership), 0..20. */
  mechanics?: Record<string, number>;
  /** AI crews' task values; the career team's crew gets the skill on every stat; member crews restart at it. */
  pitCrew?: { skill: number; confidence: number };
}

export interface PitCrewRules {
  /** ChampionshipRules.pitCrewSize. */
  size: "Small" | "Large" | "SemiSequential";
  refuelling: boolean;
  /** The positions (PitCrewRole 0..9) used in this series. */
  roles: number[];
  /** The field's average AI pit stop skill (mechanics' Pit stops stat): member crews start here. */
  aiLevel: number;
}

export interface PitStopRound {
  round: number;
  teams: { team: string; stops: number; fastest: number; average: number; mistakes: number; catastrophic: number; fire: boolean }[];
}

/** One person of the career team's real MM crew (read-only on the site). */
export interface GameCrewPerson {
  name: string;
  nationality: string | null;
  birth: string;
  /** PitCrewRole 0..9, 11 = reserve. */
  role: number;
  /** By PitCrewStatType: Tyres, FrontJack, RearJack, FixingParts, Refuelling. */
  stats: number[];
  confidence: number;
  maxConfidence: number;
  /** Per race. */
  wage: number;
  racesLeft: number;
}

/** The career team's crew, which MM runs (only the player's team has real crew people). */
export interface GameCrew {
  /** PitCrewController.PitCrewFunding: 0 Low, 1 Medium, 2 High. */
  funding: number;
  members: GameCrewPerson[];
  /** racesLeft here is how long the application stays open. */
  applicants: GameCrewPerson[];
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
  /** Banned (FF20: caught by the scrutineers): MM won't fit or improve it. */
  banned?: boolean;
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

/**
 * Which game code's rules apply: FIRE Fantasy 20 (the league) or the old Rebirth: Redux install.
 * Mirrors GameCode in src/schema.ts (this file can't import).
 */
export type GameRules = "ff20" | "rebirth";

export interface DesignContext {
  settings: DesignSettings;
  /** Game rules for cost and time; absent means Rebirth (contexts published before FF20). */
  rules?: GameRules;
  /** Normal slots: highest level of a part of this type in inventory + 1, clamped 1..5. */
  slots: number;
  /** Design Centre currentLevel when built, else null. */
  designCentreLevel: number | null;
  /** The player's career team pays full materials; AI teams 10 % (FF20: 1 %, and 10 days faster). */
  isPlayer: boolean;
  /** The player's backstory time reduction, in days (player team only). */
  playerTimeModifierDays?: number;
}

/** A new part before its components, as MM's SetBaseStats makes it. */
export interface DesignBase {
  /** Season starting stat + the lead engineer's skill for this part (x 1.5 in Rebirth). */
  stat: number;
  /** The chassis' improvability (x 2 in FF20). */
  maxPerformance: number;
  reliability: number;
  maxReliability: number;
  /** Rebirth: the team's development rate for this part, multiplying components' stat boosts. FF20 has none (1). */
  developmentRate: number;
}

/** An MM supplier a team can buy (engine, brakes, fuel, materials…), priced for that team. */
export interface SupplierOffer {
  id: number;
  type: string;
  name: string;
  tier: number;
  price: number;
  /** CarChassisStats.Stats index (0 tyre wear, 1 tyre heating, 2 fuel efficiency, 3 improvability…) → value. */
  stats: Record<number, number>;
  engineLevel?: [number, number];
  /** Engines: the level MM adds to engine parts when a car with it is built. Missing before 2026-10-09. */
  level?: number;
  /** Supplier.CarAspect (0 rear package, 1 nose height) → how far it narrows MM's design sliders from each end. */
  minBound?: Record<number, number>;
  maxBound?: Record<number, number>;
}

export interface PartDesignOptions {
  ctx: DesignContext;
  base: DesignBase;
  components: DesignComponent[];
  /** Highest component level the HQ allows now (1..5). */
  maxLevel: number;
  /** What opens the next levels: building type and the level it must reach (as shown in game). */
  locked: { level: number; buildingType: number; buildingLevel: number }[];
  /**
   * This season's components at levels the HQ doesn't open yet, shown greyed so members can see
   * what an upgrade unlocks (grey-area "Risk" components are only at levels 3-5). Missing in
   * snapshots published before 2026-10-02.
   */
  lockedComponents?: DesignComponent[];
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
  /** Next season's car: MM's supplier choice (missing in snapshots published before 2026-10-01). */
  nextYearCar?: {
    /** MM's AI starts next year's design when pre-season starts; choices apply from then. */
    state: "waiting" | "designing" | "complete";
    /** The season the car is for (the year pre-season ends): choices are stored against it. */
    season: number;
    current: Record<string, SupplierOffer>;
    options: Record<string, SupplierOffer[]>;
    /** MM's design sliders are open to this team (main championship only). Missing before 2026-10-03. */
    chassisDesign?: boolean;
    /** While MM designs the car: the suppliers its AI put on the pending chassis. */
    pending?: Record<string, SupplierOffer>;
    /**
     * The car fund: level 0 Low / 1 Medium / 2 High, the amount paid in per level (`monthly`: each
     * month, or with `per: "race"` after each race, as FF20 does), saved so far.
     */
    investment?: { level: number; monthly: number[]; per?: "month" | "race"; fund: number };
  };
  /**
   * This season's car (FF20 only): its suppliers and every supplier the team may switch to in the
   * league's pre-season. Missing before 2026-10-09.
   */
  currentCar?: {
    current: Record<string, SupplierOffer>;
    options: Record<string, SupplierOffer[]>;
    /** Engines are spec: a new engine changes the chassis stats only. */
    specEngine: boolean;
  };
  /** MM's scrutineering for this team (missing in snapshots published before 2026-10-01). */
  rules?: {
    /** Offences this season: the next bust's fine (and on Rebirth its places) scale with this + 1. */
    brokenThisSeason: number;
    /** Whose scrutineering applies (see SCRUTINEERING in src/part-design.ts); absent means Rebirth. */
    game?: GameRules;
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
    /**
     * Stats of the chief mechanics on each list, which add to the work rate. Missing in snapshots
     * published before 2026-10-02.
     */
    chiefPerformance?: number;
    chiefReliability?: number;
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
  /** Drivers: MM's contract status (ContractPerson.Status). Missing before 2026-10-09. */
  status?: "Equal" | "One" | "Two" | "Reserve";
  /** Mechanics: the car they work on (0 or 1). Missing before 2026-10-09. */
  mechanicCar?: number | null;
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
  /** The career team's real MM crew; null for AI teams. Missing in snapshots published before 2026-10-02. */
  gameCrew?: GameCrew | null;
  /**
   * This season's engine supplier on the team's cars. Public, as in MM's team screens. Missing in
   * snapshots published before 2026-10-02.
   */
  engine?: { name: string; stats: Record<number, number> } | null;
  /** Sponsors on the car, by slot. Public, as rival cars show them in game. Missing before 2026-10-03. */
  sponsors?: SponsorOnCar[];
  /** Colours and livery pattern. Public, as in game. Missing before 2026-10-05. */
  look?: TeamLookInfo;
  /** Deals with their money terms, and MM's offers. Private. Missing before 2026-10-03. */
  sponsorship?: TeamSponsorship | null;
  /** Expiring contracts with MM's renewal terms. Private. Missing before 2026-10-03. */
  contracts?: TeamContracts | null;
  staff: StaffSlot[];
}

/** Staff whose contracts end within 12 months, and the renewal deadline. */
export interface TeamContracts {
  /** MM's pre-season start (Championship.currentPreSeasonStartDate): MM's AI renews or replaces from then on. */
  deadline: string;
  renewals: ContractRenewal[];
}

/** One expiring contract with MM's renewal terms (src/ops/contracts.ts). */
export interface ContractRenewal {
  guid: string;
  name: string;
  kind: string;
  slotID: number;
  /** Current yearly wage and end date. */
  wage: number;
  end: string;
  monthsLeft: number;
  /** What MM's AI would offer to renew, per year. */
  askingWage: number;
  /** MM's sign-on fee; 0 when they don't want one. */
  signOnFee: number;
  /** The length they'd like, in seasons (MM's Short / Medium / Long). */
  preferredYears: number;
  /** Why they won't talk (MM's reaction), or null when they will. */
  refusal: string | null;
}

/** MM's SponsorSlot.SlotType, in slot order. */
export const SPONSOR_SLOTS = ["Rear Wing", "Front Wing", "Nose", "Side Pods", "End Plate", "Air Intake"] as const;

export interface SponsorOnCar {
  /** 0..5, see SPONSOR_SLOTS. */
  slot: number;
  sponsor: string;
  category: string;
  /** 1..5 stars. */
  prestige: number;
}

/** Terms shared by a running deal and an offer (ContractSponsor). */
export interface SponsorTerms extends SponsorOnCar {
  /** Sponsor entity GUID: identifies the sponsor across snapshots. */
  sponsorId: string;
  upfront: number;
  /** Paid after every race (MM shows either this or a race bonus). */
  perRace: number;
  /** Paid when a car finishes at or above `bonusTarget`. */
  bonus: number;
  bonusTarget: number;
  /** Home race bonus multiplier (> 1 means the bonus is bigger at the sponsor's home race). */
  homeBonus: number;
  /** MM calls them races, but counts one off on the 1st of every month. */
  length: number;
  /** When MM made the offer ("0001-..." for deals from the career start). */
  offerDate: string;
}

export interface SponsorDeal extends SponsorTerms {
  /** Months left (MM's contractRacesLeft). */
  left: number;
  /** MM's end date for the deal (from the race calendar; the real end follows `left`). */
  end: string;
  /** Upfront plus per-race money and bonuses received so far. */
  earned: number;
}

export interface SponsorOffer extends SponsorTerms {
  /** Days until MM withdraws the offer (MM's offerRacesLeft counts down daily). */
  daysLeft: number;
  /** Game date the offer lapses: the snapshot date plus `daysLeft`. */
  expires: string;
}

export interface TeamSponsorship {
  deals: SponsorDeal[];
  offers: SponsorOffer[];
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
export type TeamPublic = Omit<TeamState, "budget" | "hq" | "parts" | "design" | "gameCrew" | "sponsorship" | "contracts">;
export type TeamPrivate = Pick<TeamState, "budget" | "hq" | "parts" | "design" | "gameCrew" | "sponsorship" | "contracts">;

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

/** One car in FIRE Fantasy 20's exported race classification (src/race-data.ts). */
export interface RaceResultRow {
  position: number;
  driver: string;
  team: string;
  grid: number | null;
  /** Race time in seconds; for lapped cars MM's numbers are only meaningful with lapsToLeader. */
  time: number | null;
  gapToLeader: number | null;
  lapsToLeader: number;
  laps: number;
  bestLap: number | null;
  fastestLap: boolean;
  stops: number;
  points: number;
  tyre: string;
  /** CarState at the end: "None" while running, else e.g. "Retired", "Crashed". */
  state: string;
  penalties: string;
}

/** A driver's laps, one entry per lap and sector (3 per lap). sectorTime counts up within the lap. */
export interface RaceDriverLaps {
  driver: string;
  team: string;
  lap: number[];
  sector: number[];
  compound: string[];
  flag: string[];
  /** gapToLeader, gapToCarAhead, topSpeed, sectorTime, standingPos, overtakesDelta, runWides, cutCorners, lockUps, trackWater, trackRubber. */
  values: Record<string, (number | null)[]>;
}

/** The public race data of one round (league.race_data). */
export interface RaceData {
  /** Export folder name: <location>_<yyyyMMdd>_<timestamp>. */
  folder: string;
  results: RaceResultRow[];
  laps: RaceDriverLaps[];
  driverStats: { driver: string; stats: Record<string, number | null> }[];
}

/** A team's own lap data (league.race_data_private): tyreWear, tyreTemp, fuel, setupQuality, form, stamina. */
export interface RaceDataPrivate {
  drivers: { driver: string; values: Record<string, (number | null)[]> }[];
}
