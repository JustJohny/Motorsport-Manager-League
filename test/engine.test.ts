import { describe, expect, it } from "vitest";
import { buildEngine, carryOver, customerEngine, developEngine, ENGINE_SETTINGS, illegalDetection, pointsCost, PROJECTS } from "../src/engine-rules.ts";

const plan = (concept: "power" | "efficient" | "balanced", power: number, fuel = 0, projects: string[] = []) =>
  ({ concept, points: { power, fuel, improvability: 0, tyres: 0 }, projects });

describe("works engine rules", () => {
  it("prices points rising within a season", () => {
    expect(pointsCost(0, 3)).toBe(6_000_000); // 1 + 2 + 3
    expect(pointsCost(3, 2)).toBe(9_000_000); // 4 + 5
  });

  it("makes the concept and the trade-offs matter", () => {
    const start = ENGINE_SETTINGS.newEngine;
    const power = developEngine(start, plan("power", 6));
    const efficient = developEngine(start, plan("efficient", 6));
    expect(power.level).toBe(10 + 36);
    expect(efficient.level).toBe(10 + 18);
    expect(power.fuel).toBe(-2); // 6 power points cost 2 fuel
    expect(power.tyreWear).toBe(-1);
    // The concept caps what money can buy.
    expect(developEngine(start, plan("power", 0, 30)).fuel).toBe(5);
    expect(developEngine(start, plan("efficient", 0, 30)).fuel).toBe(20);
  });

  it("rolls projects reproducibly and keeps illegal gains off the legal engine", () => {
    const a = buildEngine(ENGINE_SETTINGS.newEngine, plan("power", 5, 0, ["fuelflow", "combustion"]), 15, 2, ["Tatra", 2016]);
    const b = buildEngine(ENGINE_SETTINGS.newEngine, plan("power", 5, 0, ["fuelflow", "combustion"]), 15, 2, ["Tatra", 2016]);
    expect(a).toEqual(b);
    const illegal = a.outcomes.find((o) => o.project === "fuelflow")!;
    if (illegal.success) expect(a.works.level).toBeGreaterThan(a.legal.level);
    expect(customerEngine(a.legal, true).level).toBeLessThan(a.legal.level);
    expect(carryOver(a.legal).level).toBeLessThan(a.legal.level);
    const p = PROJECTS.find((x) => x.id === "fuelflow")!;
    expect(illegalDetection(p, 1)).toBeCloseTo(0.04);
    expect(illegalDetection(p, 3)).toBeCloseTo(0.1);
  });
});
