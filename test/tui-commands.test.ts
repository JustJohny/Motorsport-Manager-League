import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSavesDir } from "../src/paths.ts";
import { argv, COMMANDS, commandLine, missing } from "../src/tui/commands.ts";

const spec = (name: string) => COMMANDS.find((c) => c.name === name)!;
const save = (n: string) => join(defaultSavesDir(), `Save${n}.sav`);

describe("TUI command forms", () => {
  it("covers every CLI command", () => {
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(
      ["apply", "archive", "decode", "diff", "encode", "extract", "publish", "pull", "restore", "suppliers", "teams", "validate"]);
  });

  it("puts positional fields first, then options; flags only when on, empty options left out", () => {
    const v = { save: save("F1 R1 Post"), changes: "changes-f1.json", out: "F1 R1 Post (league)", name: "" };
    expect(argv(spec("apply"), v)).toEqual(["apply", save("F1 R1 Post"), "changes-f1.json", "-o", save("F1 R1 Post (league)")]);
    expect(argv(spec("pull"), { league: "league-f1.json", out: "changes-f1.json", "mark-applied": true, force: false }))
      .toEqual(["pull", "--league", "league-f1.json", "-o", "changes-f1.json", "--mark-applied"]);
    expect(argv(spec("publish"), { save: save("X"), league: "league-f1.json", "dry-run": true })).toEqual(["publish", save("X"), "--league", "league-f1.json", "--dry-run"]);
  });

  it("shows saves by name on the command line, quoted when needed", () => {
    expect(commandLine(spec("validate"), { save: save("F1 R1 Post") })).toBe('mmsave validate "SaveF1 R1 Post"');
  });

  it("asks before uploading, deleting or writing", () => {
    expect(spec("publish").confirm!({ "dry-run": false })).toMatch(/uploads/);
    expect(spec("publish").confirm!({ "dry-run": true })).toBeNull();
    expect(spec("archive").confirm!({ end: true })).toMatch(/DELETES/);
    expect(spec("archive").confirm!({ end: false })).toBeNull();
    expect(missing(spec("diff"), { a: save("X"), b: "" })).toMatch(/Save B/);
  });
});
