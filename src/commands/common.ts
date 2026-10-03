import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LeagueConfig } from "../league-types.ts";
import { defaultSavesDir } from "../paths.ts";
import { supabaseEnv, type SupabaseEnv } from "../supabase.ts";

/** Where a command reports progress: the CLI prints each line, the TUI shows them in a log pane. */
export type Log = (line: string) => void;

/** A save given by path, or by name in the saves folder (with or without ".sav"). */
export function resolveSave(p: string | undefined): string {
  if (!p) throw new Error("missing save file");
  if (existsSync(p)) return p;
  const inDir = join(defaultSavesDir(), p.endsWith(".sav") ? p : `${p}.sav`);
  if (existsSync(inDir)) return inDir;
  throw new Error(`no such save: ${p}`);
}

export function readLeague(file: string): LeagueConfig {
  return JSON.parse(readFileSync(file, "utf8")) as LeagueConfig;
}

/** Supabase settings for the league file's series. */
export function seriesEnvFor(cfg: LeagueConfig, file = "the league file"): SupabaseEnv {
  const id = cfg.series?.id;
  if (!id) throw new Error(`${file} has no series: add "series": { "id": "main", "name": "…" } (main is the league from before series existed)`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`series id "${id}": use lower case letters, digits and dashes`);
  return { ...supabaseEnv(), series: id };
}

export interface SaveFileInfo {
  path: string;
  /** File name without "Save" and ".sav", e.g. "F1 League R1 Pre", as the race guide names saves. */
  name: string;
  modified: Date;
  size: number;
}

/** The saves folder, newest first. */
export function listSaves(dir = defaultSavesDir()): SaveFileInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sav")).map((f) => {
    const path = join(dir, f);
    const st = statSync(path);
    return { path, name: f.replace(/^Save/, "").replace(/\.sav$/, ""), modified: st.mtime, size: st.size };
  }).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** The league files in a folder (`league-<series>.json`, or a plain `league.json`). */
export function listLeagues(dir = "."): { file: string; cfg: LeagueConfig }[] {
  return readdirSync(dir).filter((f) => /^league(-[\w-]+)?\.json$/.test(f)).flatMap((f) => {
    try { return [{ file: f, cfg: readLeague(join(dir, f)) }]; } catch { return []; }
  });
}
