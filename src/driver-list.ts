import type { Obj } from "./graph.ts";
import { personName, type Save } from "./model.ts";

/** A driver whose portrait the league may replace (tools/driver-photos.py). */
export interface PortraitDriver {
  /** Position in driverManager: MM's portrait mod texture is "Driver_<index>". */
  index: number;
  name: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  nationality: string | null;
  team: string | null;
  championship: string | null;
}

/**
 * Drivers contracted in the given championships (all single-seater ones by default) plus every
 * free agent who hasn't retired. Index = position in driverManager, which MM never reorders
 * (people are only appended), so it keeps naming the same person.
 */
export function portraitDrivers(save: Save, championshipIds?: number[]): PortraitDriver[] {
  const drivers = save.g.list<Obj>(save.data.driverManager.mEntities);
  const champs = save.g.list<Obj>(save.data.championshipManager.mEntities ?? [])
    .filter((c) => (championshipIds ? championshipIds.includes(c.championshipID) : c.series === 0));
  const contracted = new Map<Obj, { team: string; championship: string }>();
  for (const t of save.teams()) {
    const ch = champs.find((c) => save.g.same(t.championship, c));
    if (!ch) continue;
    for (const s of save.slots(t)) {
      const p = s.personHired ? save.g.deref<Obj>(s.personHired) : null;
      if (p && drivers.includes(p)) contracted.set(p, { team: t.name, championship: save.championshipName(ch) });
    }
  }
  return drivers.flatMap((p, index) => {
    const where = contracted.get(p);
    if (!where && !(save.isFreeAgent(p) && !p.retirementAge)) return [];
    const nat = p.nationality ? save.g.deref<Obj>(p.nationality) : null;
    return [{
      index, name: personName(p), firstName: p.mFirstName, lastName: p.mLastName,
      dateOfBirth: String(p.dateOfBirth).slice(0, 10), nationality: nat?.mCountryKey ?? null,
      team: where?.team ?? null, championship: where?.championship ?? null,
    }];
  });
}
