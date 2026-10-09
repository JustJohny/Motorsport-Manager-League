import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Log } from "./commands/common.ts";
import { stickerSpots } from "./sticker-spots.ts";
import { rest, storageDownload, type SupabaseEnv } from "./supabase.ts";

/** Where the league game patch reads them (tools/league-patch, Hooks.OnFrontendCarSponsors). */
export const STICKERS_FOLDER = "league-stickers";

interface Row {
  series: string; team: string; team_id: number; slot: number | null; sponsor_name: string | null; path: string | null
  /** Share of the spot (migration 027; missing before it). */
  scale?: number | null;
}

/**
 * Write the series' approved car stickers into MM_Data/league-stickers/<teamID>/<slot>.png. Every
 * member team gets a folder, so its car shows only its stickers (no MM sponsor decals). A sticker
 * smaller than its spot gets <slot>.scale beside it (e.g. "0.5"), which the patch shrinks it by. The
 * folder is rebuilt from scratch, since the install holds one series at a time.
 */
export async function writeStickers(env: SupabaseEnv, dataDir: string, log: Log) {
  const rows = (await rest<Row[]>(env, "POST", "rpc/all_team_stickers", {})).filter((r) => r.series === env.series);
  const root = join(dataDir, STICKERS_FOLDER);
  rmSync(root, { recursive: true, force: true });
  const teams = new Map<number, string>();
  let files = 0;
  for (const r of rows) {
    const dir = join(root, String(r.team_id));
    mkdirSync(dir, { recursive: true });
    teams.set(r.team_id, r.team);
    if (r.slot === null || !r.path) continue;
    writeFileSync(join(dir, `${r.slot}.png`), await storageDownload(env, "team-stickers", r.path));
    const scale = r.scale ?? 1;
    if (scale < 1) writeFileSync(join(dir, `${r.slot}.scale`), String(scale));
    log(`  ${r.team}: ${stickerSpots("ff20")[r.slot].name} ${r.sponsor_name}${scale < 1 ? ` at ${Math.round(scale * 100)}%` : ""}`);
    files++;
  }
  log(`wrote ${files} sticker${files === 1 ? "" : "s"} for ${teams.size} member team${teams.size === 1 ? "" : "s"} into ${root}`);
  if (!teams.size) log("no member teams in the latest snapshot: publish first");
}
