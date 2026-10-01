import type { Obj } from "../src/graph.ts";
import type { Save } from "../src/model.ts";

const LISTS = ["engineSuppliers", "brakesSuppliers", "fuelSuppliers", "materialsSuppliers"];
const COUNT = [4, 6, 5, 4];

/**
 * Fake MM's season-end draw (SupplierManager.championshipSuppliers) for the team's championship:
 * the first 4/6/5/4 deals of its tier per type, plus `extra` supplier ids. `shape` picks how the
 * nested dictionaries are written, since no real save with a draw has been seen yet.
 */
export function fakeDraw(save: Save, team: Obj, shape: "list" | "object" = "list", extra: number[] = []) {
  const champ = save.championship(team);
  const tier = champ.championshipID + 1;
  const sm = save.data.supplierManager;
  const deals = LISTS.map((l, i) => {
    const all = save.g.list<Obj>(sm[l]);
    return [...all.filter((s) => s.mTier === tier).slice(0, COUNT[i]), ...all.filter((s) => extra.includes(s.id))];
  });
  const refs = (l: Obj[]) => l.map((s) => save.g.ref(s));
  sm.championshipSuppliers = shape === "list"
    ? [{ Key: champ.championshipID, Value: deals.map((l, i) => ({ Key: i, Value: refs(l) })) }]
    : { [champ.championshipID]: Object.fromEntries(deals.map((l, i) => [["Engine", "Brakes", "Fuel", "Materials"][i], refs(l)])) };
  return deals;
}
