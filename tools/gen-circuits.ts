// Builds schema/circuits-1.53.json: the circuit fields that saves from an older format lack
// (session start times, overtake corners), taken from a healthy 1.53 save. MM sets them from its
// database and code when it creates a career, so every 1.53 career has the same values.
//   npx tsx tools/gen-circuits.ts "<saves>/SaveLeague Test 17.sav" schema/circuits-1.53.json
import { writeFileSync } from "node:fs";
import { Save } from "../src/model.ts";
import { CIRCUIT_FIELDS, type CircuitData } from "../src/ops/circuits.ts";

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error("usage: gen-circuits <healthy.sav> <out.json>");
const save = Save.load(input);
const table: Record<number, CircuitData> = {};
for (const ref of save.data.circuitManager.mCircuits) {
  const c = save.g.deref<Record<string, unknown>>(ref);
  if (!c.wmcPracticeStart) throw new Error(`${c.locationName} (${c.circuitID}) has no start times: not a healthy save`);
  table[c.circuitID as number] = Object.fromEntries(CIRCUIT_FIELDS.map((k) => [k, c[k]])) as CircuitData;
}
writeFileSync(out, JSON.stringify(table, null, 1) + "\n");
console.log(`${Object.keys(table).length} circuits → ${out}`);
