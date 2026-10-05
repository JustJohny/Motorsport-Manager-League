import { describe, expect, it } from "vitest";
import { LEAGUE_COLOR_ID_START, loadBaseColourTable, parseColourTable, teamColoursMod } from "../src/team-colours.ts";

const look = { primary: "#c8102e", secondary: "#ffffff", tertiary: "#1a1a1a", trim: "#f2c200" };

describe("team colours mod", () => {
  it("keeps MM's rows and adds league rows in MM's column order", () => {
    const base = loadBaseColourTable();
    expect(base.rows).toHaveLength(LEAGUE_COLOR_ID_START);
    const text = teamColoursMod([{ colorID: 129, look }, { colorID: 130, look: { ...look, primary: "#000000" } }]);
    expect(text.endsWith("\r\n")).toBe(true);
    const out = parseColourTable(text);
    expect(out.header).toEqual(base.header);
    expect(out.rows.slice(0, base.rows.length)).toEqual(base.rows);
    const row = Object.fromEntries(out.header.map((h, i) => [h, out.rows[129][i]]));
    expect(row).toMatchObject({ ID: "129", Car: "#c8102e", Primary: "#c8102e", Trim: "#f2c200", "Normal UI": "#c8102e" });
    // A black pick stays black on the car but is lifted for MM's dark UI.
    const black = Object.fromEntries(out.header.map((h, i) => [h, out.rows[130][i]]));
    expect(black.Car).toBe("#000000");
    expect(black["Normal UI"]).not.toBe("#000000");
    for (const r of out.rows) expect(r).toHaveLength(out.header.length);
  });

  it("fills gaps with spare rows so IDs stay row positions", () => {
    const out = parseColourTable(teamColoursMod([{ colorID: 131, look }]));
    expect(out.rows.map((r) => Number(r[0]))).toEqual([...Array(132).keys()]);
    expect(out.rows[129].slice(1)).toEqual(out.rows[0].slice(1));
    expect(out.rows[131][out.header.indexOf("Car")]).toBe("#c8102e");
  });

  it("rejects MM's IDs, taken IDs and bad colours", () => {
    expect(() => teamColoursMod([{ colorID: 5, look }])).toThrow(/start at 129/);
    expect(() => teamColoursMod([{ colorID: 129, look }, { colorID: 129, look }])).toThrow(/already used/);
    expect(() => teamColoursMod([{ colorID: 129, look: { ...look, trim: "red" } }])).toThrow(/#rrggbb/);
  });
});
