import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gamePatch } from "../src/game-patch.ts";

const DATA = join(process.env.HOME ?? "", "Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/MM_Data");
const hasDotnet = spawnSync("dotnet", ["--version"]).status === 0;

describe.skipIf(!hasDotnet || !existsSync(join(DATA, "Managed", "Assembly-CSharp.dll")))("game patch", () => {
  it("patches a copy of the game once, switches by ini, and restores the original byte for byte", () => {
    const data = mkdtempSync(join(tmpdir(), "mm-data-"));
    cpSync(join(DATA, "Managed"), join(data, "Managed"), { recursive: true });
    // Start from the original even if the real game is patched.
    if (existsSync(join(DATA, "Managed", "Assembly-CSharp.dll.orig"))) {
      cpSync(join(DATA, "Managed", "Assembly-CSharp.dll.orig"), join(data, "Managed", "Assembly-CSharp.dll"));
      spawnSync("rm", ["-f", join(data, "Managed", "Assembly-CSharp.dll.orig"), join(data, "Managed", "LeaguePatch.dll")]);
    }
    const original = readFileSync(join(data, "Managed", "Assembly-CSharp.dll"));
    const out = mkdtempSync(join(tmpdir(), "league-patch-"));
    const log: string[] = [];
    gamePatch(data, { mode: "patch", out }, (l) => log.push(l));
    gamePatch(data, { mode: "patch", retire: false, out }, (l) => log.push(l));
    expect(readFileSync(join(data, "league-patch.ini"), "utf8")).toMatch(/^retirePlayerTeam=false$/m);
    expect(existsSync(join(data, "Managed", "LeaguePatch.dll"))).toBe(true);
    expect(readFileSync(join(data, "Managed", "Assembly-CSharp.dll.orig")).equals(original)).toBe(true);
    // One hook call in StartSession, however often it's patched.
    const il = spawnSync("monodis", ["--method", join(data, "Managed", "Assembly-CSharp.dll")], { encoding: "utf8" });
    if (il.status === 0) {
      const dump = spawnSync("sh", ["-c", `monodis "${join(data, "Managed", "Assembly-CSharp.dll")}" | grep -c "LeaguePatch.Hooks::OnSessionStart"`], { encoding: "utf8" });
      expect(Number(dump.stdout.trim())).toBe(1);
    }
    gamePatch(data, { mode: "restore", out }, (l) => log.push(l));
    expect(readFileSync(join(data, "Managed", "Assembly-CSharp.dll")).equals(original)).toBe(true);
    expect(existsSync(join(data, "Managed", "LeaguePatch.dll"))).toBe(false);
  }, 300_000);

  it("refuses to patch or restore over Unity Mod Manager's injection", () => {
    const eg = join(process.env.HOME ?? "", "Downloads/EnhancedGraphics-3-1-2-0a-1683272141/EnhancedGraphics/EnhancedGraphics.dll");
    if (!existsSync(eg)) return;
    const data = mkdtempSync(join(tmpdir(), "mm-data-"));
    cpSync(join(DATA, "Managed"), join(data, "Managed"), { recursive: true });
    const orig = existsSync(join(DATA, "Managed", "Assembly-CSharp.dll.orig")) ? "Assembly-CSharp.dll.orig" : "Assembly-CSharp.dll";
    cpSync(join(DATA, "Managed", orig), join(data, "Managed", "Assembly-CSharp.dll.orig"));
    // Any assembly that references UnityModManager stands in for a UMM-injected game DLL.
    cpSync(eg, join(data, "Managed", "Assembly-CSharp.dll"));
    const out = mkdtempSync(join(tmpdir(), "league-patch-"));
    const log: string[] = [];
    gamePatch(data, { mode: "status", out }, (l) => log.push(l));
    expect(log.join("\n")).toMatch(/Unity Mod Manager: injected/);
    expect(() => gamePatch(data, { mode: "patch", out }, () => {})).toThrow(/DoorstopProxy/);
    expect(() => gamePatch(data, { mode: "restore", out }, () => {})).toThrow(/DoorstopProxy/);
    expect(readFileSync(join(data, "Managed", "Assembly-CSharp.dll")).equals(readFileSync(eg))).toBe(true);
  }, 300_000);
});
