import { REAL_COUNTRIES } from "../circuit-names.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";

export interface RealCircuitCountriesOp {
  op: "realCircuitCountries";
}

/**
 * Put MM's circuits in their real circuit's country (src/circuit-names.ts): Circuit.countryNameID
 * (the name MM shows) and nationalityKey (flag, dialogue, home-race form), on every layout. MM only
 * reads these from its database when a career starts, so the save keeps them. Does nothing once done.
 */
export function realCircuitCountries(save: Save, _op: RealCircuitCountriesOp): string[] {
  const out: string[] = [];
  const circuits = [...save.g.byId.values()].filter((o: Obj) => typeof o.locationName === "string" && "countryNameID" in o && "mNationalityKey" in o);
  for (const c of circuits) {
    const real = REAL_COUNTRIES[c.locationName];
    if (!real || (c.mNationalityKey === real.key && c.countryNameID === real.countryID)) continue;
    c.mNationalityKey = real.key;
    c.countryNameID = real.countryID;
    out.push(`${c.locationName} (layout ${c.trackLayout}): ${real.name}`);
  }
  return out.length ? out : ["circuit countries already real"];
}
