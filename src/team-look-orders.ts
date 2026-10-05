import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChangeSet } from "./apply.ts";
import type { Log } from "./commands/common.ts";
import { rest, storageDownload, storageUpload, type SupabaseEnv } from "./supabase.ts";
import { teamColoursMod } from "./team-colours.ts";

/**
 * Members' team identities (migration 019): colours and livery as a standing choice, re-applied at
 * every pull (MM re-rolls AI liveries each season), and the game mod that carries the colours and
 * approved logos (`mmsave team-mod`). See docs/save-schema.md, "Team colours, livery and logos".
 */

export interface TeamLookRow {
  team: string; primary_colour: string; secondary_colour: string; tertiary_colour: string; trim_colour: string;
  livery_id: number; color_id: number; updated_at: string;
}

export interface TeamIdentityRow {
  series: string; team: string; team_id: number | null; color_id: number | null;
  primary_colour: string | null; secondary_colour: string | null; tertiary_colour: string | null; trim_colour: string | null;
  livery_id: number | null; logo_path: string | null; logo_approved_at: string | null;
}

export function teamLookChanges(rows: TeamLookRow[]): ChangeSet["changes"] {
  return rows.map((r) => ({ op: "setTeamLook" as const, team: r.team, colorID: r.color_id, liveryID: r.livery_id }));
}

export async function fetchTeamLooks(env: SupabaseEnv) {
  const rows = await rest<TeamLookRow[]>(env, "GET", "team_looks?select=*&order=team").catch((e: Error) => {
    // Before migration 019 the table doesn't exist (PostgREST PGRST205).
    if (/PGRST205/.test(e.message)) return null;
    throw e;
  });
  return { rows: rows ?? [], missing: rows === null };
}

const TOOLS = fileURLToPath(new URL("../tools/", import.meta.url));

/** The python that has UnityPy: --python, $MM_PYTHON, or python3. */
export function unityPython(explicit?: string): string {
  const py = explicit ?? process.env.MM_PYTHON ?? "python3";
  const r = spawnSync(py, ["-c", "import UnityPy"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${py} can't import UnityPy. Install it (python3 -m venv ~/.mm-venv && ~/.mm-venv/bin/pip install UnityPy) `
      + "and pass --python ~/.mm-venv/bin/python or set MM_PYTHON");
  }
  return py;
}

function runPython(py: string, script: string, args: string[], log: Log) {
  const r = spawnSync(py, [join(TOOLS, script), ...args], { encoding: "utf8" });
  for (const line of `${r.stdout}${r.stderr}`.split("\n").filter(Boolean)) log(`  ${line}`);
  if (r.status !== 0) throw new Error(`${script} failed (exit ${r.status})`);
}

/**
 * Logos by MM teamID. The mod serves the whole game install, so two series using the same teams
 * (two careers in one championship) can't both have a logo for one teamID: the later approval wins.
 */
export function logosByTeamId(rows: TeamIdentityRow[]) {
  const pick = new Map<number, TeamIdentityRow>();
  const clashes: string[] = [];
  for (const r of rows) {
    if (!r.logo_path || r.team_id == null) continue;
    const prev = pick.get(r.team_id);
    if (prev) clashes.push(`team ${r.team_id}: ${prev.series}/${prev.team} and ${r.series}/${r.team}`);
    if (!prev || (r.logo_approved_at ?? "") > (prev.logo_approved_at ?? "")) pick.set(r.team_id, r);
  }
  return { logos: [...pick.entries()].map(([teamId, r]) => ({ teamId, row: r })), clashes };
}

/**
 * Write the team mod into `<out>/Modding`: `Databases/Team Colours.txt` (MM's table + every
 * league colour row) and, if any logo is approved, `Images/teamlogos` (the base bundle + logos).
 * The organizer copies both into MM_Data/Modding and switches the staging mod on in game.
 */
export async function buildTeamMod(env: SupabaseEnv, opts: { out: string; logosBase?: string; python?: string }, log: Log) {
  const rows = await rest<TeamIdentityRow[]>(env, "POST", "rpc/all_team_identities", {});
  const looks = rows.filter((r) => r.color_id != null && r.primary_colour);
  const db = join(opts.out, "Modding", "Databases");
  mkdirSync(db, { recursive: true });
  writeFileSync(join(db, "Team Colours.txt"), teamColoursMod(looks.map((r) => ({
    colorID: r.color_id!,
    look: { primary: r.primary_colour!, secondary: r.secondary_colour!, tertiary: r.tertiary_colour!, trim: r.trim_colour! },
  }))));
  log(`Team Colours.txt: ${looks.length} league row${looks.length === 1 ? "" : "s"}`);
  for (const r of looks) log(`  ${r.series}/${r.team}: row ${r.color_id} ${r.primary_colour} ${r.secondary_colour} ${r.tertiary_colour} ${r.trim_colour}`);

  const { logos, clashes } = logosByTeamId(rows);
  for (const c of clashes) log(`  WARNING: two series have a logo for ${c}; the later approval is used`);
  for (const r of rows) if (r.logo_path && r.team_id == null) log(`  WARNING: ${r.series}/${r.team} isn't in its latest snapshot; logo skipped`);
  if (!logos.length) {
    log("Logos: none approved");
    return { colours: looks.length, logos: 0 };
  }
  if (!opts.logosBase || !existsSync(opts.logosBase)) {
    throw new Error("Logos need --logos-base: a copy of the game's original MM_Data/Modding/Images/teamlogos "
      + "(the bundle before any league logos), so logos the league no longer uses don't linger");
  }
  const py = unityPython(opts.python);
  const src = join(opts.out, "logo-sources");
  mkdirSync(src, { recursive: true });
  const pairs: string[] = [];
  for (const { teamId, row } of logos) {
    const file = join(src, `${teamId}${extname(row.logo_path!) || ".png"}`);
    writeFileSync(file, await storageDownload(env, "team-logos", row.logo_path!));
    pairs.push(`${teamId}=${file}`);
    log(`  logo ${row.series}/${row.team} (team ${teamId})`);
  }
  const images = join(opts.out, "Modding", "Images");
  mkdirSync(images, { recursive: true });
  runPython(py, "team-logos.py", [opts.logosBase, join(images, "teamlogos"), ...pairs], () => {});
  log(`teamlogos: ${logos.length} team logo${logos.length === 1 ? "" : "s"}`);
  return { colours: looks.length, logos: logos.length };
}

/** Export MM's livery masks from the game and upload them to the site's "liveries" bucket. */
export async function uploadLiveryMasks(env: SupabaseEnv, opts: { dataDir: string; out: string; python?: string }, log: Log) {
  const py = unityPython(opts.python);
  runPython(py, "livery-masks.py", [opts.dataDir, opts.out], log);
  const files = readdirSync(opts.out).filter((f) => f.endsWith(".png"));
  for (const f of files) await storageUpload(env, "liveries", f, readFileSync(join(opts.out, f)), "image/png");
  log(`uploaded ${files.length} livery masks`);
}
