import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffSaves, pathSegments } from "../src/diff.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { compareSaves } from "../src/save-compare.ts";

// Two of the user's saves a race apart (ERS round 6 → after the race), played in MM.
const A = join(defaultSavesDir(), "SaveLeague Test 3.sav");
const B = join(defaultSavesDir(), "SaveLeague Test 4.sav");

describe.skipIf(!existsSync(A) || !existsSync(B))("comparing two saves", () => {
  const a = existsSync(A) ? Save.load(A) : null!;
  const b = existsSync(B) ? Save.load(B) : null!;

  it("lists each team's changes in plain words", () => {
    const c = compareSaves(a, b);
    expect(c.a.gameDate < c.b.gameDate).toBe(true);
    const tatra = c.teams.find((t) => t.name === "Tatra Racing")!;
    const budget = tatra.changes.find((x) => x.area === "Budget")!;
    expect(budget.text).toMatch(/now \$[\d,]+/);
    // The WMC raced in between (Tatra's ERS standings stayed the same).
    expect(c.teams.find((t) => t.name === "Steinmann Motorsport")!.changes.some((x) => x.area === "Standings")).toBe(true);
    expect(tatra.changes.some((x) => x.area === "Standings")).toBe(false);
    // Rounding doesn't show as a change.
    for (const t of c.teams) for (const x of t.changes) expect(x.text).not.toMatch(/(\d+%) → \1(?!\d)/);
  }, 120_000);

  it("diffs team by team, each branch stopping at other teams and people", () => {
    const d = diffSaves(a, b, { maxDepth: 20, limit: 200_000 });
    expect(d.roots).toContain("Tatra Racing");
    expect(d.roots.some((r) => r.startsWith("Person "))).toBe(true);
    const tatra = d.entries.filter((e) => pathSegments(e.path, d.roots)[0] === "Tatra Racing");
    expect(tatra.some((e) => e.path === "Tatra Racing.financeController.finance.currentBudget")).toBe(true);
    // A person's or another team's fields never show under a team.
    expect(tatra.some((e) => /\.mFirstName$|\.employeer\.|\.championship\./.test(e.path))).toBe(false);
    // Objects against missing values are described, not printed.
    expect(d.entries.every((e) => (e.a ?? "").length <= 120 && (e.b ?? "").length <= 120)).toBe(true);
  }, 120_000);

  it("splits paths with dotted team names", () => {
    expect(pathSegments("Team F.1.carManager.parts[0].name", ["Team F.1"])).toEqual(["Team F.1", "carManager", "parts[0]", "name"]);
    expect(pathSegments("save.calendar[2]", ["save"])).toEqual(["save", "calendar[2]"]);
  });
});
