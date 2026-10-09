import { float, num } from "../codec/sav.ts";
import { EXTRA_FUEL_SUPPLIERS, scaledForTier, tierMedians, type TierMedians } from "../extra-suppliers.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";

export interface AddFuelSuppliersOp {
  op: "addFuelSuppliers";
}

const stat = (s: Obj, key: number) => num((Array.isArray(s.supplierStats) ? s.supplierStats : []).find((e: Obj) => Number(e.Key) === key)?.Value ?? 0);
const numbers = (s: Obj): TierMedians => ({ price: Number(s.mBasePrice), fuel: stat(s, 2), improvability: stat(s, 3) });

/**
 * Add the league's fuel suppliers (src/extra-suppliers.ts) to every tier the save has fuel suppliers
 * in, scaled by that tier's medians. FF20 offers every supplier of a tier, so MM's car screen and the
 * site list them from then on. Does nothing for a supplier a tier already has.
 */
export function addFuelSuppliers(save: Save, _op: AddFuelSuppliersOp): string[] {
  if (save.game !== "ff20") return ["fuel suppliers: FF20 saves only"];
  const g = save.g;
  const list = g.rawList(save.data.supplierManager.fuelSuppliers);
  const all = g.list<Obj>(save.data.supplierManager.fuelSuppliers);
  const tiers = [...new Set(all.map((s) => s.mTier as number))].sort((a, b) => a - b);
  const extra = new Set(EXTRA_FUEL_SUPPLIERS.map((x) => x.name));
  const own = (t: number) => all.filter((s) => s.mTier === t && !extra.has(s.name));
  const f1 = tierMedians(own(tiers[0]).map(numbers));
  let nextId = Math.max(...SUPPLIER_LISTS.flatMap((l) => g.list<Obj>(save.data.supplierManager[l] ?? []).map((s) => Number(s.id)))) + 1;
  const out: string[] = [];
  for (const tier of tiers) {
    const template = own(tier)[0];
    if (!template) continue;
    const med = tierMedians(own(tier).map(numbers));
    for (const x of EXTRA_FUEL_SUPPLIERS) {
      if (all.some((s) => s.mTier === tier && s.name === x.name)) continue;
      const v = scaledForTier(x, f1, med);
      const s = g.clone(template);
      Object.assign(s, {
        name: x.name, id: nextId++, logoIndex: x.logoId, mBasePrice: v.price,
        supplierStats: [{ Key: 2, Value: float(v.fuel) }, { Key: 3, Value: float(v.improvability) }, { Key: 4, Value: float(0) }, { Key: 5, Value: float(0) }],
        carAspectMinBoundary: {}, carAspectMaxBoundary: {}, teamDiscounts: {}, mTeamsThatCannotBuy: [],
      });
      list.push(s);
      out.push(`tier ${tier}: ${x.name} fuel +${v.fuel}, improvability +${v.improvability}, $${(v.price / 1e6).toFixed(1)}M`);
    }
  }
  return out.length ? out : ["fuel suppliers already added"];
}

const SUPPLIER_LISTS = ["engineSuppliers", "brakesSuppliers", "fuelSuppliers", "materialsSuppliers", "batterySuppliers", "ersAdvancedSuppliers"];
