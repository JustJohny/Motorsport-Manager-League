import type { Change } from "./apply.ts";
import type { Person } from "./league-types.ts";
import { SIGNING_TRAITS, type SigningTraitId } from "./ops/traits.ts";
import { roll } from "./politics.ts";

const age = (born: string, now: string) => {
  const b = new Date(Date.parse(born.slice(0, 19) + "Z")), n = new Date(Date.parse(now.slice(0, 19) + "Z"));
  return n.getUTCFullYear() - b.getUTCFullYear() - (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate()) ? 1 : 0);
};

/**
 * FF20's contract-signing traits for drivers signed through the site (the league's rule; FF20's
 * game never gives them): under 21 "Young Driver Signed" (+12 potential, 99 %), anyone else "New
 * Contract Signed" (+1, 80 %). Rolled with a seed (driver, team, game date), so the same pull gives
 * the same result and anyone can check it.
 */
export function signingTraitChanges(signings: { person: Person; team: string }[], gameDate: string) {
  const changes: Change[] = [];
  const lines: string[] = [];
  for (const { person, team } of signings) {
    if (person.kind !== "Driver") continue;
    const id: SigningTraitId = age(person.dateOfBirth, gameDate) < 21 ? 724 : 723;
    const t = SIGNING_TRAITS[id];
    const r = roll(person.guid, team, gameDate, "signing");
    if (r >= t.chance) { lines.push(`${person.name}: no ${t.name} (rolled ${(r * 100).toFixed(1)} % against ${t.chance * 100} %)`); continue; }
    const [lo, hi = lo] = t.weeks;
    const weeks = lo + Math.floor(roll(person.guid, team, gameDate, "weeks") * (hi - lo + 1));
    changes.push({ op: "grantTrait", person: person.guid, trait: id, weeks });
    lines.push(`${person.name}: ${t.name}, +${t.potential} potential for ${weeks} week${weeks === 1 ? "" : "s"}`);
  }
  return { changes, lines };
}
