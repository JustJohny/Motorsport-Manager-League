import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiColourRows, aiLiveryChanges, aiOnly, readAiLooks } from "../src/ai-looks.ts";
import { loadBaseColourTable, parseColourTable, teamColoursMod } from "../src/team-colours.ts";

const EXAMPLE = fileURLToPath(new URL("../examples/league.json", import.meta.url));
const looks = readAiLooks({ members: [], aiLooks: "f1-2016-looks.json" }, EXAMPLE);

describe("AI team looks", () => {
  it("reads the F1 2016 file: every entry has a teamID, colours on MM's own rows", () => {
    expect(looks.length).toBe(8);
    for (const l of looks) {
      expect(Number.isInteger(l.teamID)).toBe(true);
      expect(l.colorID).toBeLessThan(129);
    }
  });

  it("leaves member teams to their members, by name or teamID", () => {
    const ai = aiOnly(looks, ["red bull racing", 63, null]);
    expect(ai.map((l) => l.team)).not.toContain("Red Bull Racing");
    expect(ai.map((l) => l.team)).not.toContain("Manor Racing MRT");
    expect(ai).toHaveLength(6);
  });

  it("pins liveries by teamID and skips an unavailable one", () => {
    const [c] = aiLiveryChanges(looks.filter((l) => l.team === "Scuderia Ferrari"));
    expect(c).toEqual({ op: "setTeamLook", team: 3, liveryID: 15, ifAvailable: true });
  });

  it("writes AI colours over MM's rows and keeps league rows apart", () => {
    // The 2016 file is for the old career, whose save colours come from MM's (Rebirth-era) table.
    const base = loadBaseColourTable("rebirth");
    const mod = parseColourTable(teamColoursMod([{ colorID: 129, look: { primary: "#c8102e", secondary: "#ffffff", tertiary: "#000000", trim: "#f2c200" } }],
      base, aiColourRows(aiOnly(looks, ["Kubica GrandPrix"]))));
    const col = (id: number, name: string) => mod.rows.find((r) => Number(r[0]) === id)![mod.header.indexOf(name)];
    expect(col(2, "Primary")).toBe("#1b2a4e"); // Red Bull navy instead of MM's Panther purple
    expect(col(2, "Secondary")).toBe("#ffc906");
    expect(col(129, "Primary")).toBe("#c8102e"); // the member's row is untouched
    expect(mod.rows.find((r) => r[0] === "6")).toEqual(base.rows.find((r) => r[0] === "6")); // no entry: MM's row
    expect(mod.rows).toHaveLength(130);
  });

  it("refuses colours without one of MM's own rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-looks-"));
    writeFileSync(join(dir, "looks.json"), JSON.stringify({ teams: [{ team: "X", teamID: 1, colorID: 129, colours: {} }] }));
    expect(() => readAiLooks({ members: [], aiLooks: "looks.json" }, join(dir, "league.json"))).toThrow(/MM's own/);
  });
});
