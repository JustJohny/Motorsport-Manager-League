import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Log } from "./commands/common.ts";
import { personName, type Save } from "./model.ts";
import { runPython, unityPython } from "./team-look-orders.ts";

/**
 * The mod's portraits are per index: "<Type>_<index>" is the index-th person of that type's manager
 * (docs/save-schema.md, "Driver portraits"), which for a mod career is row <index> of the type's
 * database table. A person renamed in the save (e.g. Franz Tost → a league member's principal) keeps
 * the real person's photo; these are the portrait types and the table their indexes follow.
 */
const PORTRAIT_TABLES: { type: string; manager: string; table: string }[] = [
  { type: "Driver", manager: "driverManager", table: "Drivers.txt" },
  { type: "TeamPrincipal", manager: "teamPrincipalManager", table: "Team Principals.txt" },
  { type: "Engineer", manager: "engineerManager", table: "Engineers.txt" },
  { type: "Chairman", manager: "chairmanManager", table: "Chairman.txt" },
  { type: "Assistant", manager: "assistantManager", table: "Assistants.txt" },
];

export interface RenamedPerson { portrait: string; name: string; dbName: string }

/** People whose name differs from their database row, i.e. who wear someone else's mod portrait. */
export function renamedPeople(save: Save, databases: string): RenamedPerson[] {
  const out: RenamedPerson[] = [];
  for (const { type, manager, table } of PORTRAIT_TABLES) {
    const lines = readFileSync(join(databases, table), "utf8").split(/\r?\n/).filter(Boolean);
    const header = lines[0].replace(/^﻿/, "").split(",");
    const first = header.indexOf("First Name"), last = header.indexOf("Last Name");
    const rows = lines.slice(1).map((l) => l.split(","));
    const people = save.g.list(save.data[manager]?.mEntities ?? []);
    people.slice(0, rows.length).forEach((p, i) => {
      const name = personName(p), dbName = `${rows[i][first]} ${rows[i][last]}`;
      // MM capitalises name particles ("Nyck De Vries"), so only a different spelling counts.
      if (name.toLowerCase() !== dbName.toLowerCase()) out.push({ portrait: `${type}_${i}`, name, dbName });
    });
  }
  return out;
}

/**
 * Hide the mod portraits of people renamed in this save, so MM draws their faces. Rebuilt from
 * Modding/Images/portraits.orig each time; the bundle serves every career, so it follows one save.
 */
export function hideRenamedFaces(save: Save, dataDir: string, opts: { python?: string; dryRun?: boolean }, log: Log) {
  const modding = join(dataDir, "Modding");
  const bundle = join(modding, "Images", "portraits");
  if (!existsSync(bundle)) throw new Error(`${bundle} not found: is FIRE Fantasy 20 installed in the staging mod?`);
  const renamed = renamedPeople(save, join(modding, "Databases"));
  for (const r of renamed) log(`${r.portrait}: ${r.name} (photo of ${r.dbName})`);
  if (!renamed.length) log("no renamed people: every portrait matches its person");
  if (opts.dryRun) return renamed;
  if (!existsSync(`${bundle}.orig`)) copyFileSync(bundle, `${bundle}.orig`);
  runPython(unityPython(opts.python), "hide-portraits.py", [`${bundle}.orig`, bundle, ...renamed.map((r) => r.portrait)], log);
  return renamed;
}
