import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Log } from "./commands/common.ts";

/**
 * The game code patch (tools/league-patch): when qualifying and the race go green, the player
 * team's cars retire as for a failed part, which sends them to the garage without a yellow flag,
 * safety car or VSC. Switched by MM_Data/league-patch.ini, so a series where the organizer races
 * the career team can turn it off without unpatching.
 */

const ROOT = fileURLToPath(new URL("../tools/league-patch/", import.meta.url));
export const PATCH_INI = "league-patch.ini";

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}. The patch needs the .NET SDK (dotnet).`);
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** Build the hook library against the game's DLLs and the patcher; returns their paths. */
export function buildPatch(managed: string, outDir: string) {
  // dotnet resolves relative paths from the project folder.
  const out = resolve(outDir);
  // The hook must be built against the original game code, not an already patched copy.
  const original = existsSync(join(managed, "Assembly-CSharp.dll.orig")) ? join(out, "game-refs") : managed;
  if (original !== managed) {
    mkdirSync(original, { recursive: true });
    copyFileSync(join(managed, "UnityEngine.dll"), join(original, "UnityEngine.dll"));
    copyFileSync(join(managed, "Assembly-CSharp.dll.orig"), join(original, "Assembly-CSharp.dll"));
  }
  run("dotnet", ["build", join(ROOT, "LeaguePatch"), "-c", "Release", `-p:GameManaged=${original}`, "-o", join(out, "hook"), "--nologo", "-v", "q"]);
  run("dotnet", ["build", join(ROOT, "Patcher"), "-c", "Release", "-o", join(out, "patcher"), "--nologo", "-v", "q"]);
  return { hook: join(out, "hook", "LeaguePatch.dll"), patcher: join(out, "patcher", "league-patch") };
}

/** Write retirePlayerTeam into MM_Data/league-patch.ini, keeping other lines. */
export function setRetirePlayerTeam(dataDir: string, on: boolean) {
  const path = join(dataDir, PATCH_INI);
  const header = "# League toolkit game patch (tools/league-patch). Read at every session start.\n";
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((l) => !/^\s*retirePlayerTeam\s*=/.test(l)) : [header.trim()];
  while (lines.length && lines.at(-1) === "") lines.pop();
  lines.push(`retirePlayerTeam=${on}`);
  writeFileSync(path, lines.join("\n") + "\n");
}

export function gamePatch(dataDir: string, opts: { mode: "patch" | "restore" | "status"; retire?: boolean; out: string }, log: Log) {
  const managed = join(dataDir, "Managed");
  if (!existsSync(join(managed, "Assembly-CSharp.dll"))) throw new Error(`${dataDir} isn't MM's MM_Data folder (no Managed/Assembly-CSharp.dll)`);
  const { hook, patcher } = buildPatch(managed, opts.out);
  if (opts.mode === "status") {
    log(run(patcher, [managed, "--status"]).trim());
    const ini = join(dataDir, PATCH_INI);
    log(existsSync(ini) ? readFileSync(ini, "utf8").trim() : `${PATCH_INI}: none (patch does nothing)`);
    return;
  }
  if (opts.mode === "restore") {
    log(run(patcher, [managed, "--restore"]).trim());
    return;
  }
  log(run(patcher, [managed, hook]).trim());
  if (opts.retire !== undefined || !existsSync(join(dataDir, PATCH_INI))) setRetirePlayerTeam(dataDir, opts.retire ?? true);
  log(readFileSync(join(dataDir, PATCH_INI), "utf8").trim());
}
