import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Log } from "./commands/common.ts";
import { EXTRA_FUEL_SUPPLIERS, scaledForTier, tierMedians } from "./extra-suppliers.ts";
import { runPython, unityPython } from "./team-look-orders.ts";

/**
 * Put the league's fuel suppliers (src/extra-suppliers.ts) into the game's staging mod: rows in
 * Modding/Databases/Part Suppliers.txt (for new careers; saves get them from `pull`'s
 * addFuelSuppliers) and their logos in Modding/Images/supplierlogos. Both files are kept as .orig
 * and rebuilt from it, so running this again is safe.
 */
export function installFuelSuppliers(dataDir: string, opts: { python?: string }, log: Log) {
  const modding = join(dataDir, "Modding");
  const db = join(modding, "Databases", "Part Suppliers.txt");
  const logos = join(modding, "Images", "supplierlogos");
  for (const f of [db, logos]) {
    if (!existsSync(f)) throw new Error(`${f} not found: is FIRE Fantasy 20 installed in the staging mod?`);
    if (!existsSync(`${f}.orig`)) copyFileSync(f, `${f}.orig`);
  }

  // Database rows: one per tier with fuel suppliers, scaled by the tier's medians (price in $M).
  const text = readFileSync(`${db}.orig`, "utf8");
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const header = lines[0].replace(/^﻿/, "").split(",");
  const col = (name: string) => header.indexOf(name);
  const rows = lines.slice(1).filter(Boolean).map((l) => l.split(","));
  const fuel = rows.filter((r) => r[col("Part Type")] === "Fuel");
  const nums = (r: string[]) => ({ price: Number(r[col("Price")]) * 1e6, fuel: Number(r[col("Fuel Efficiency")]), improvability: Number(r[col("Improveability")]) });
  const tiers = [...new Set(fuel.map((r) => Number(r[col("Tier")])))].filter((t) => t > 0).sort((a, b) => a - b);
  const f1 = tierMedians(fuel.filter((r) => Number(r[col("Tier")]) === tiers[0]).map(nums));
  let id = Math.max(...rows.map((r) => Number(r[col("ID")])).filter((n) => !Number.isNaN(n))) + 1;
  const added: string[] = [];
  for (const tier of tiers) {
    const med = tierMedians(fuel.filter((r) => Number(r[col("Tier")]) === tier).map(nums));
    for (const s of EXTRA_FUEL_SUPPLIERS) {
      const v = scaledForTier(s, f1, med);
      const row = header.map(() => "");
      row[col("Part Type")] = "Fuel"; row[col("Company Name")] = s.name; row[col("ID")] = String(id++);
      row[col("Logo ID")] = String(s.logoId); row[col("Price")] = String(v.price / 1e6);
      row[col("Fuel Efficiency")] = String(v.fuel); row[col("Improveability")] = String(v.improvability);
      row[col("Tyre Wear")] = "NA"; row[col("Tyre Heating")] = "NA"; row[col("Tier")] = String(tier);
      added.push(row.join(","));
    }
  }
  writeFileSync(db, [...lines.filter(Boolean), ...added].join(nl) + nl);
  log(`added ${added.length} fuel supplier rows to ${db}`);

  // Logos: Supplier_Fuel_<logo ID - 1>.
  const pairs = EXTRA_FUEL_SUPPLIERS.map((s) => `Supplier_Fuel_${s.logoId - 1}=${resolve(s.logo)}`);
  runPython(unityPython(opts.python), "supplier-logos.py", [`${logos}.orig`, logos, ...pairs], log);
}
