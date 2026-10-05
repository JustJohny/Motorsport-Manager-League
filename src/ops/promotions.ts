import { float, num } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import { PART_TYPES, type PartType, type Save } from "../model.ts";

/** ChampionshipPromotions.Status. */
const STATUS = { Waiting: 0, Promoted: 1, Relegated: 2, RefusedPromotion: 3, SavedFromRelegation: 4 } as const;

export interface HoldPromotionsOp {
  op: "holdPromotions";
  /** Any team in the league's championship. */
  team: string | number;
}

/**
 * Keep the league's championship as it is at the season change: no team is promoted out of it or
 * relegated into it, and none is relegated out of it or promoted into it.
 *
 * MM swaps one team per pair of tiers when pre-season starts: the lower championship's champion
 * goes up (85 % chance for AI teams) and the upper one's last place comes down, both done by the
 * lower championship's ProcessChampionshipPromotions. ChampionshipManager.FinishPromotions skips a
 * championship whose `completedPromotions` is already set, which is MM's own "refused promotion"
 * path; nothing else reads or resets the flag before then. So the flag is set on the league's
 * championship (its champion stays) and on the one below it (the league's last place stays), with
 * the statuses MM writes when a promotion is refused. Safe to apply at any time: after a season
 * change MM clears the flag, and the next apply sets it again for the next one.
 * The career team's own promotion is MM's dialog, which ignores the flag: refuse it in game.
 */
export function holdPromotions(save: Save, op: HoldPromotionsOp): string {
  const champ = save.championship(save.team(op.team));
  const all = save.g.list<Obj>(save.data.championshipManager.mEntities);
  const above = all.find((c) => c.championshipID === champ.championshipAboveID) ?? null;
  const below = all.find((c) => c.championshipAboveID === champ.championshipID && c.series === champ.series) ?? null;
  const promotions = (c: Obj) => save.g.deref<Obj>(c.mChampionshipPromotions);
  const name = (c: Obj) => save.championshipName(c);

  const held: string[] = [];
  const hold = (lower: Obj, upper: Obj) => {
    if (lower.completedPromotions) return;
    lower.completedPromotions = true;
    held.push(`${name(lower)} ↔ ${name(upper)}`);
    // Statuses (only news text reads them) as MM writes a refusal, while this season's are pending.
    const p = promotions(lower);
    if (p.champion && p.championStatus === STATUS.Waiting) {
      p.championStatus = STATUS.RefusedPromotion;
      promotions(upper).championStatus = STATUS.SavedFromRelegation;
    }
  };
  if (above) hold(champ, above);
  if (below) hold(below, champ);
  return held.length
    ? `${name(champ)}: no promotion or relegation at the season change (${held.join(", ")})`
    : `${name(champ)}: promotions already held`;
}

export interface ProtectTeamsOp {
  op: "protectTeams";
  /** Member teams: never promoted out of or relegated from their championship. */
  teams: (string | number)[];
}

/** CarStats field per CarStats.StatType, and the part MM ranks it by (CarPart.GetPartForStatType) per series. */
const RANKED_STATS: { field: string; part: (PartType | null)[] }[] = [
  { field: "topSpeed", part: ["Engine", "EngineGT", "EngineGET"] },
  { field: "acceleration", part: ["Gearbox", "GearboxGT", "GearboxGET"] },
  { field: "braking", part: ["Brakes", "BrakesGT", "BrakesGET"] },
  { field: "lowSpeedCorners", part: ["FrontWing", null, "FrontWingGET"] },
  { field: "mediumSpeedCorners", part: ["Suspension", "SuspensionGT", "SuspensionGET"] },
  { field: "highSpeedCorners", part: ["RearWing", "RearWingGT", "RearWingGET"] },
];

/** The team's best part of a type (not banned): stat + performance, as CarPartInventory.GetHighestStatOfType. */
function bestPartStat(save: Save, team: Obj, type: PartType): number {
  let best = 0;
  let found = false;
  for (const p of save.parts(team, type)) {
    if (p.isBanned) continue;
    const s = save.g.deref<Obj>(p.stats ?? p.mStats);
    const v = num(s.mStat ?? 0) + num(s.mPerformance ?? 0);
    if (!found || v > best) { best = v; found = true; }
  }
  return best;
}

/**
 * TeamStatistics.GetPartRankingsForChampionship: per stat, the team's best part against the
 * championship's best, both above the season's minimum part stat, clamped to 0..1. MM stores it
 * for the teams that move and uses it to rebuild their cars for the new tier.
 */
export function partRankings(save: Save, team: Obj): Record<string, number> {
  const champ = save.championship(team);
  const series = champ.series as number;
  const rules = save.g.deref<Obj>(champ.rules);
  const minOf = new Map((rules.partStatSeasonMinValue as { Key: number; Value: unknown }[]).map((e) => [e.Key, num(e.Value)]));
  const teams = save.teams().filter((t) => save.g.same(t.championship, champ));
  const out: Record<string, number> = {};
  for (const { field, part } of RANKED_STATS) {
    const type = part[series] ?? null;
    if (!type) { out[field] = 0; continue; }
    const min = minOf.get(PART_TYPES.indexOf(type)) ?? 0;
    const mine = bestPartStat(save, team, type) - min;
    const top = Math.max(...teams.map((t) => bestPartStat(save, t, type))) - min;
    out[field] = top !== 0 ? Math.min(1, Math.max(0, mine / top)) : 1;
  }
  return out;
}

/** The championship's teams in standings order. */
function standingsOrder(save: Save, champ: Obj): Obj[] {
  const st = save.g.deref<Obj>(champ.standings);
  return save.g.list<Obj>(st.mTeams)
    .slice().sort((a, b) => a.mCurrentPosition - b.mCurrentPosition)
    .map((e) => save.g.deref<Obj>(e.mEntity));
}

/**
 * Member teams (and the career team, so the organizer keeps watching the league's races) are never
 * promoted or relegated; AI teams still are.
 *
 * At season end MM stores, per pair of tiers, the lower championship's champion and the upper one's
 * last place, with their part rankings (Championship.OnSeasonEnd); at pre-season start it swaps
 * exactly those two (ProcessChampionshipPromotions, 85 % chance for an AI champion) without looking
 * at the standings again. So a protected champion is replaced by the best-placed unprotected team of
 * that championship and a protected last place by the lowest-placed one, with their own part
 * rankings. If every team is protected, the swap is held instead (completedPromotions, as
 * holdPromotions). Takes effect when applied between season end and pre-season start; at any other
 * time it's harmless (MM overwrites the stored teams at season end). Replaces holdPromotions, which
 * froze every move into and out of the league's championship, AI teams' too.
 */
export function protectTeams(save: Save, op: ProtectTeamsOp): string[] {
  const g = save.g;
  const player = g.deref<Obj>(save.data.player.mPlayerTeam);
  const shielded = new Set<Obj>([...op.teams.map((t) => save.team(t)), player].filter(Boolean));
  const all = g.list<Obj>(save.data.championshipManager.mEntities);
  const out: string[] = [];
  for (const lower of all) {
    const upper = all.find((c) => c.championshipID === lower.championshipAboveID);
    if (!upper) continue;
    // MM sets and clears completedPromotions within one step at pre-season, so in a save it's only
    // ever a hold from the old holdPromotions op: lift it, AI teams move again.
    if (lower.completedPromotions) {
      lower.completedPromotions = false;
      out.push(`${save.championshipName(lower)} → ${save.championshipName(upper)}: earlier hold lifted`);
    }
    const pl = g.deref<Obj>(lower.mChampionshipPromotions);
    const pu = g.deref<Obj>(upper.mChampionshipPromotions);
    const champion = pl.champion ? g.deref<Obj>(pl.champion) : null;
    const last = pu.lastPlace ? g.deref<Obj>(pu.lastPlace) : null;
    if (!champion || !last) continue;
    const lowerOrder = standingsOrder(save, lower), upperOrder = standingsOrder(save, upper);
    // This season's teams once the season has ended: they match the final standings.
    const current = lowerOrder[0] === champion && upperOrder.at(-1) === last;
    if (!shielded.has(champion) && !shielded.has(last)) continue;
    const pair = `${save.championshipName(lower)} → ${save.championshipName(upper)}`;
    if (!current) {
      out.push(`${pair}: ${[champion, last].filter((t) => shielded.has(t)).map((t) => t.name).join(", ")} stored from last season; `
        + "apply again between season end and pre-season");
      continue;
    }
    const up = shielded.has(champion) ? lowerOrder.find((t) => !shielded.has(t)) : champion;
    const down = shielded.has(last) ? [...upperOrder].reverse().find((t) => !shielded.has(t)) : last;
    if (!up || !down) {
      lower.completedPromotions = true;
      out.push(`${pair}: no unprotected team to move, swap held`);
      continue;
    }
    if (up !== champion) {
      pl.champion = g.ref(up);
      Object.assign(g.deref<Obj>(pl.championPartRankings), floats(partRankings(save, up)));
      out.push(`${pair}: ${up.name} goes up instead of ${champion.name}`);
    }
    if (down !== last) {
      pu.lastPlace = g.ref(down);
      Object.assign(g.deref<Obj>(pu.lastPlacePartRankings), floats(partRankings(save, down)));
      out.push(`${pair}: ${down.name} goes down instead of ${last.name}`);
    }
  }
  return out.length ? out : ["no protected team is due to move"];
}

const floats = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, float(v)]));
