import { basename, dirname, join } from "node:path";
import { applyChanges, type ChangeSet } from "../apply.ts";
import { crewUpdates, fetchCrewContext, saveCrewUpdates } from "../crew-orders.ts";
import { extractLeague } from "../extract.ts";
import type { LeagueConfig, LeagueState } from "../league-types.ts";
import { Save } from "../model.ts";
import { crewNamePool } from "../ops/pit-crew.ts";
import { memberRows, publish, splitSnapshot } from "../publish.ts";
import { seriesEnvFor, type Log } from "./common.ts";

/**
 * Upload a save's league state to the website (or, with `dryRun`, only report what would go up),
 * then run member pit crews through every race since the last publish.
 */
export async function publishSave(input: string, cfg: LeagueConfig, opts: { dryRun?: boolean; leagueFile?: string }, log: Log): Promise<{ state: LeagueState; snapshotId: number | null }> {
  const save = Save.load(input);
  const state = extractLeague(save, cfg);
  const split = splitSnapshot(state);
  const members = memberRows(cfg, state);
  const ch = state.championship;
  log(`${ch.name}, after round ${ch.lastRace?.round ?? 0}: ${split.teams.length} teams, ${split.freeAgents.length} free agents`);
  for (const m of members) log(`  ${m.discord_username} -> ${m.team}${m.role === "organizer" ? " (organizer)" : ""}`);
  if (!members.length) log("  WARNING: no member has a \"discord\" username in the league file, so nobody can log in");
  if (opts.dryRun) return { state, snapshotId: null };
  const env = seriesEnvFor(cfg, opts.leagueFile);
  const snapshotId = await publish(env, members, split, cfg.series?.name);
  log(`published snapshot #${snapshotId} to series "${env.series}"`);
  // Member pit crews: starting crews for new member teams, then every race since the last publish.
  const crew = crewUpdates(state, await fetchCrewContext(env), env.series!, crewNamePool(save));
  await saveCrewUpdates(env, crew);
  for (const u of crew) {
    const costs = u.spend.reduce((s, x) => s + x.amount, 0);
    log(`  Pit crew ${u.team}: ${u.log.map((l) => l.message).join("; ") || "races processed"}${costs ? `, costs $${costs.toLocaleString()}` : ""}`);
  }
  return { state, snapshotId };
}

/** Where `apply` writes by default: next to the input, " (league)" added. */
export function defaultApplyOut(input: string): string {
  return join(dirname(input), basename(input, ".sav") + " (league).sav");
}

/**
 * Apply a change set to a save and write the result to a new file (never the input). `name` is
 * what MM's load menu shows.
 */
export function applyToSave(input: string, set: ChangeSet, opts: { out?: string; name?: string }, log: Log): string {
  const save = Save.load(input);
  for (const line of applyChanges(save, set)) log(`  ${line}`);
  if (opts.name) {
    // The name shown in MM's load menu comes from the header, not the file name.
    save.file.header.saveInfo.name = opts.name;
    save.file.header.saveInfo.isAutoSave = false;
  }
  const out = opts.out ?? defaultApplyOut(input);
  if (out === input) throw new Error("refusing to overwrite the input save; pass a different -o");
  save.write(out);
  log(`wrote ${out}`);
  return out;
}
