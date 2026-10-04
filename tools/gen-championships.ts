// Builds schema/championships-1.53.json: the championship fields that saves from an older format
// lack (banned locations, race counts, promotions), taken from a healthy 1.53 save. MM sets them
// from its database when it creates a career, so every 1.53 career has the same values.
//   npx tsx tools/gen-championships.ts "<saves>/SaveLeague Test 17.sav" schema/championships-1.53.json
import { writeFileSync } from "node:fs";
import { Save } from "../src/model.ts";
import type { ChampionshipData } from "../src/ops/old-format.ts";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: gen-championships <healthy.sav> <out.json>");
const save = Save.load(input);
const table: Record<number, ChampionshipData> = {};
for (const c of save.g.list<Record<string, any>>(save.data.championshipManager.mEntities)) {
  const bannedLocations = save.g.list<number>(c.bannedLocations ?? []);
  if (!bannedLocations.length) throw new Error(`Championship ${c.championshipID} has no banned locations: not a healthy save`);
  table[c.championshipID] = {
    allowPromotions: c.allowPromotions, minRacesPerSeason: c.minRacesPerSeason, maxRacesPerSeason: c.maxRacesPerSeason, bannedLocations,
  };
}
writeFileSync(out, JSON.stringify(table, null, 1) + "\n");
console.log(`${Object.keys(table).length} championships → ${out}`);
