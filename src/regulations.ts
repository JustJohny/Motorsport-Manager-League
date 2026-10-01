import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Obj } from "./graph.ts";
import type { Regulations, Rule, RuleVote } from "./league-types.ts";
import type { Save } from "./model.ts";
import { num } from "./codec/sav.ts";
import { predictAiVote, teamCharacteristics } from "./politics.ts";

/** The game's MM_Data folder: MM_GAME_DIR, or the install this project was built against. */
export function gameDataDir(): string {
  const base = process.env.MM_GAME_DIR ?? join(homedir(), "Downloads", "Motorsport.Manager.v1.53.ALL.DLCs", "Motorsport Manager v1.53");
  return base.endsWith("MM_Data") ? base : join(base, "MM_Data");
}

let gameText: { names: Map<string, string>; templates: Map<string, string> } | null = null;

/**
 * English texts from the game's localisation and rules CSVs, which sit as plain text inside
 * resources.assets: `…,"Short Practice Sessions","PSG_10004395",…` (localisation) and
 * `PSG_10004395,Practice sessions last {RuleSessionLength}.,PSG_10006425,Source = …` (rules).
 * Empty when the game isn't installed where expected; the site then shows MM's group names.
 */
function loadGameText() {
  if (gameText) return gameText;
  gameText = { names: new Map(), templates: new Map() };
  const file = join(gameDataDir(), "resources.assets");
  if (!existsSync(file)) return gameText;
  const text = readFileSync(file).toString("latin1");
  for (const m of text.matchAll(/"HUDText","((?:[^"\r\n]|"")*)","(PSG_\d+)"/g)) {
    if (m[1] && !gameText.names.has(m[2])) gameText.names.set(m[2], Buffer.from(m[1].replace(/""/g, '"'), "latin1").toString("utf8"));
  }
  for (const m of text.matchAll(/(PSG_\d+),([^,\r\n]*),PSG_\d+,Source = /g)) {
    if (!gameText.templates.has(m[1])) gameText.templates.set(m[1], Buffer.from(m[2], "latin1").toString("utf8"));
  }
  return gameText;
}

const LENGTHS = ["Short", "Medium", "Long"];

/** Fill the placeholders MM fills from a rule's impacts ("Replacing {RuleOldTrack:Name} GP …"). */
function fillText(save: Save, v: Obj, text: string, strict = false): string | null {
  const imps = save.g.list<Obj>(v.impacts ?? []).map((i) => save.g.deref<Obj>(i));
  const track = (key: string) => {
    const imp = imps.find((i) => i?.$type === "PoliticalImpactChangeTrack" && i[key]);
    return imp ? save.g.deref<Obj>(imp[key])?.locationName : undefined;
  };
  const effectNumber = /\((\d+)\)/.exec(String(v.effectType))?.[1];
  const fuel = imps.find((i) => i?.$type === "PoliticalImpactFuelSettings" && num(i.fuelLimit) > 0);
  const length = imps.find((i) => i?.$type === "PoliticalImpactSessionLength");
  const values: Record<string, string | undefined> = {
    "RuleOldTrack:Name": track("trackAffected"),
    "RuleNewTrack:Name": track("newTrack"),
    FuelWeight: fuel ? `${num(fuel.fuelLimit)}kg` : undefined,
    SlowPitSpeedLimit: effectNumber ? `${effectNumber} mph` : undefined,
    RuleRaceAverageLaps: length ? LENGTHS[length.sessionLength] : undefined,
  };
  if (strict && [...text.matchAll(/\{([^}]+)\}/g)].some((m) => values[m[1]] == null)) return null;
  return text.replace(/\{([^}]+)\}/g, (_, key: string) => values[key] ?? effectNumber ?? "…").replace(/\s+/g, " ").trim();
}

function toRule(save: Save, v: Obj): Rule {
  const t = loadGameText();
  const name = t.names.get(v.mName);
  const template = t.templates.get(v.mName);
  return {
    id: v.ID,
    group: v.group,
    effect: v.effectType,
    name: name ? fillText(save, v, name) : null,
    // A description whose placeholders MM fills from the circuit (e.g. session minutes) is left out.
    description: template ? fillText(save, v, template, true) : null,
    beneficial: save.g.list<number>(v.benificialCharacteristics ?? []),
    detrimental: save.g.list<number>(v.detrimentalCharacteristics ?? []),
  };
}

/** 0-based rank of each team by a value, highest first. */
function ranks(teams: Obj[], value: (t: Obj) => number): Map<Obj, number> {
  const sorted = [...teams].sort((a, b) => value(b) - value(a));
  return new Map(sorted.map((t, i) => [t, i]));
}

/**
 * The championship's rules, next season's confirmed rules, this season's votes with MM's results,
 * and for upcoming votes how each AI team will vote (MM's logic; see src/politics.ts).
 */
export function extractRegulations(save: Save, champ: Obj, memberTeams: Set<string>): Regulations {
  const g = save.g;
  const ps = g.deref<Obj>(champ.politicalSystem);
  const rulesOf = (r: Obj) => g.list<Obj>(g.deref<Obj>(r).mRules);

  // Every rule definition anywhere in the save: the organizer's catalogue.
  const rules: Record<number, Rule> = {};
  const addRule = (v: Obj) => { if (v && v.ID != null && !rules[v.ID]) rules[v.ID] = toRule(save, v); };
  for (const c of g.list<Obj>(save.data.championshipManager.mEntities)) {
    if (c.series !== champ.series) continue;
    for (const v of [...rulesOf(c.rules), ...rulesOf(c.nextYearsRules), ...g.list<Obj>(g.deref<Obj>(c.politicalSystem)?.mVotesForSeason ?? [])]) addRule(v);
  }

  const teams = save.teams().filter((t) => g.same(t.championship, champ));
  const standings = g.list<Obj>(g.deref<Obj>(champ.standings).mTeams);
  const position = new Map(standings.map((e) => [g.deref<Obj>(e.mEntity), e.mCurrentPosition as number]));
  const budget = ranks(teams, (t) => num(save.finance(t).currentBudget));
  const driverAvg = (t: Obj) => {
    const ds = save.slots(t).filter((s) => s.jobType === 0 && s.personHired).map((s) => g.deref<Obj>(g.deref<Obj>(s.personHired).mStats ?? g.deref<Obj>(s.personHired).stats));
    const keys = ["braking", "cornering", "smoothness", "overtaking", "consistency", "adaptability", "fitness", "feedback", "focus"];
    return ds.length ? ds.reduce((sum, st) => sum + keys.reduce((a, k) => a + num(st?.[k] ?? 0), 0) / keys.length, 0) / ds.length : 0;
  };
  const drivers = ranks(teams, driverAvg);
  const chassis = (t: Obj) => g.deref<Obj>(save.cars(t)[0]?.chassisStats) ?? {};
  const fuel = ranks(teams, (t) => num(chassis(t).mFuelEfficiency ?? 0));
  const tyre = ranks(teams, (t) => num(chassis(t).mTyreWear ?? 0));
  const teamInfo = teams.map((t) => ({
    team: t.name as string,
    member: memberTeams.has(t.name),
    votingPower: (t.votingPower as number) ?? 0,
    characteristics: teamCharacteristics({
      fixed: g.list<number>(t.votingCharacteristics ?? []),
      position: position.get(t) ?? teams.length,
      budgetRank: budget.get(t)!, driverRank: drivers.get(t)!, fuelRank: fuel.get(t)!, tyreRank: tyre.get(t)!,
    }),
  }));

  // The season's votes: held ones carry MM's result, upcoming ones the AI teams' votes.
  const season = Number(String(save.now).slice(0, 4));
  const results = g.list<Obj>(ps?.mVoteResultsForSeason ?? []);
  const voteEvents = g.list<Obj>(ps?.mCalendarEvents ?? []).map((e) => e.triggerDate as string);
  const votes: RuleVote[] = g.list<Obj>(ps?.mVotesForSeason ?? []).map((v, i) => {
    addRule(v);
    const r = results.find((x) => g.deref<Obj>(x.votedSubject)?.ID === v.ID);
    const date = voteEvents[i] ?? "";
    if (r || i < (ps.mNextVoteIndex ?? 0)) {
      return {
        ruleId: v.ID, date, status: "held",
        result: r ? { yes: r.yesVotesCount, no: r.noVotesCount, abstained: r.abstainedVotesCount, accepted: r.voteResult === 0 } : undefined,
      };
    }
    return {
      ruleId: v.ID, date, status: "upcoming",
      aiVotes: teamInfo.filter((t) => !t.member).map((t) => ({ team: t.team, ...predictAiVote(rules[v.ID], t.characteristics, t.votingPower, [season, v.ID, t.team]) })),
    };
  });

  return {
    season,
    current: rulesOf(champ.rules).map((v) => v.ID),
    next: rulesOf(champ.nextYearsRules).map((v) => v.ID),
    rules,
    votes,
    teams: teamInfo,
  };
}
