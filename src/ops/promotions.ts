import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";

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
