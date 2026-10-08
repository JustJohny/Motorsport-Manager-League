import { readAiLooks } from "../ai-looks.ts";
import { readSavHeader } from "../codec/sav.ts";
import { listLeagues, listSaves, seriesEnvFor, type SaveFileInfo } from "../commands/common.ts";
import { pullDecisions, type PullSection } from "../commands/pull.ts";
import { extractLeague } from "../extract.ts";
import type { LeagueConfig, LeagueState } from "../league-types.ts";
import { Save } from "../model.ts";
import { seriesFiles } from "../race-cycle.ts";
import { rest } from "../supabase.ts";

export interface SaveEntry extends SaveFileInfo {
  /** Name MM's load menu shows. */
  shown: string;
  gameTime: string | null;
  team: string | null;
}

export interface SeriesEntry {
  file: string;
  cfg: LeagueConfig;
  id: string;
  name: string;
  /** Save name prefix the race guide uses for this series. */
  prefix: string;
}

export function readSeries(): SeriesEntry[] {
  return listLeagues().map(({ file, cfg }) => {
    const id = cfg.series?.id ?? file.replace(/^league-?|\.json$/g, "");
    const name = cfg.series?.name ?? id;
    return { file, cfg, id, name, prefix: seriesFiles({ id, name }).prefix };
  });
}

export function readSaves(): SaveEntry[] {
  return listSaves().map((s) => {
    try {
      const h = readSavHeader(s.path);
      return { ...s, shown: h?.saveInfo?.name ?? s.name, gameTime: h?.gameInfo?.gameTime ?? null, team: h?.gameInfo?.teamName ?? null };
    } catch {
      return { ...s, shown: s.name, gameTime: null, team: null };
    }
  });
}

/** Saves that belong to a series: their file name starts with its prefix. */
export const seriesSaves = (saves: SaveEntry[], series: SeriesEntry | undefined) =>
  series ? saves.filter((s) => s.name.startsWith(series.prefix + " ") || s.name === series.prefix) : [];

/** This series' saves, or every save when none follows the race guide's names yet. */
export const savesOf = (saves: SaveEntry[], series: SeriesEntry | undefined) => {
  const own = seriesSaves(saves, series);
  return own.length ? own : saves;
};

/** The series whose newest save is the newest overall, so the TUI opens where you left off. */
export function defaultSeries(series: SeriesEntry[], saves: SaveEntry[]): number {
  if (!series.length) return -1;
  for (const s of saves) {
    const i = series.findIndex((x) => s.name.startsWith(x.prefix + " "));
    if (i >= 0) return i;
  }
  return 0;
}

// Loaded saves, read-only, shared by the screens: a save takes about 340 MB in memory, so at most
// two are kept (the selected one and the one it's compared with). Never hand these to apply, which
// changes the save it gets; applyToSave loads its own copy.
const cache: { key: string; save: Save }[] = [];

export function loadSave(path: string, modified: Date): Save {
  const key = `${path}@${modified.getTime()}`;
  const hit = cache.find((c) => c.key === key);
  if (hit) {
    cache.splice(cache.indexOf(hit), 1);
    cache.push(hit);
    return hit.save;
  }
  const save = Save.load(path);
  cache.push({ key, save });
  while (cache.length > 2) cache.shift();
  return save;
}

/** Load a save and extract the league view of it (blocks for a second or two). */
export function loadState(path: string, modified: Date, cfg: LeagueConfig): LeagueState {
  return extractLeague(loadSave(path, modified), cfg);
}

export interface SiteStatus {
  snapshot: { id: number; game_date: string | null; created_at: string } | null;
  /** Members' queued decisions, from a read-only pull. */
  sections: PullSection[];
  changes: number;
}

/** What the website has: the latest snapshot and what members have queued (no writes). */
export async function fetchSite(cfg: LeagueConfig, file: string): Promise<SiteStatus> {
  const env = seriesEnvFor(cfg, file);
  const [snaps, pull] = await Promise.all([
    rest<SiteStatus["snapshot"][]>(env, "GET", "snapshots?select=id,game_date,created_at&order=id.desc&limit=1"),
    pullDecisions(env, { aiLooks: readAiLooks(cfg, file) }, () => {}),
  ]);
  return { snapshot: snaps[0] ?? null, sections: pull.sections, changes: pull.set.changes.length };
}
