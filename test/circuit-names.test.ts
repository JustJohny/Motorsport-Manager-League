import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { circuitName } from "../src/circuit-names.ts";
import { writeTrackNames } from "../src/track-names.ts";

describe("real circuit names", () => {
  it("maps MM's locations and keeps the rest", () => {
    expect(circuitName("Sydney")).toBe("Melbourne");
    expect(circuitName("Singapore")).toBe("Singapore");
  });

  it("writes the patch's text file, keeping other lines and replacing its own", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-text-"));
    writeFileSync(join(dir, "league-text.txt"), "# mine\nPSG_1=Hello\n~Sydney=Old name\n");
    writeTrackNames(dir, () => {});
    writeTrackNames(dir, () => {});
    const lines = readFileSync(join(dir, "league-text.txt"), "utf8").trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["# mine", "PSG_1=Hello"]);
    expect(lines.filter((l) => l.startsWith("~Sydney="))).toEqual(["~Sydney=Melbourne"]);
    expect(lines).toHaveLength(2 + 15);
  });
});
