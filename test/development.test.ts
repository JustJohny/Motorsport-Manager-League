import { describe, expect, it } from "vitest";
import { raceForRoll, raceRewards, traitDisplayName, traitLength } from "../src/development.ts";
import { FF20_POTENTIAL_TRAITS } from "../src/ff20-potential-traits.ts";

const f1 = (age: number, room = 0) => ({ age, room, employed: true, series: "single" as const, order: 0 });
const band = (age: number, label: string, room = 0) => raceRewards(FF20_POTENTIAL_TRAITS, f1(age, room)).find((b) => b.label.startsWith(label))!.rewards;

describe("FF20 driver development rules", () => {
  it("rewards young drivers' results from FF20's trait table", () => {
    // Under 21 in F1: a podium is +5 at 57 % (the F1-specific version beats the general 55 %).
    expect(band(20, "Podium")[0]).toMatchObject({ potential: 5, chance: 0.57 });
    expect(band(23, "Podium")[0]).toMatchObject({ potential: 4, chance: 0.45 });
    expect(band(20, "16th")[0].potential).toBeLessThan(0);
    // Over 30, race results give nothing but the rare "Potential discovered" for a win or podium.
    expect(band(32, "6th")).toEqual([]);
    // "Potential < 30": a driver with that much room already gets no more.
    expect(band(20, "Podium", 40).some((r) => r.name === "On the Podium")).toBe(false);
  });

  it("finds the race whose result counts at the next roll, and words names and lengths", () => {
    const cal = [{ date: "2020-03-22T14:00:00.0000000", ended: true }, { date: "2020-04-05T14:00:00.0000000", ended: false }];
    expect(raceForRoll(cal, "2020-04-06T00:00:00.0000000")).toBe(cal[1]);
    expect(raceForRoll(cal, "2020-04-20T00:00:00.0000000")).toBeNull();
    expect(traitDisplayName("Reigning {Tier1} Champion")).toBe("Reigning F1 Champion");
    expect(traitLength({ permanent: false, weeks: [1, 2] })).toBe("1–2 weeks");
  });
});
