#!/usr/bin/env -S npx tsx
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { ChangeSet } from "./apply.ts";
import { pack, parseLossless, stringifyLossless, unpack } from "./codec/sav.ts";
import { readLeague, resolveSave, seriesEnvFor } from "./commands/common.ts";
import { applyToSave, defaultApplyOut, publishSave } from "./commands/publish-apply.ts";
import { pullDecisions } from "./commands/pull.ts";
import { diffObjects } from "./diff.ts";
import { extractLeague, type LeagueConfig } from "./extract.ts";
import { Save } from "./model.ts";
import { defaultSavesDir } from "./paths.ts";
import { rest, supabaseEnv, type SupabaseEnv } from "./supabase.ts";
import { buildTeamMod, uploadLiveryMasks } from "./team-look-orders.ts";
import { gamePatch } from "./game-patch.ts";

const USAGE = `mmsave - Motorsport Manager league save toolkit

  mmsave decode   <save.sav> [-o dir]                 unpack to header.json + data.json
  mmsave encode   <dir> -o <out.sav>                  repack header.json + data.json
  mmsave validate <save.sav>                          check the object graph
  mmsave teams    <save.sav>                          list teams by championship
  mmsave extract  <save.sav> --league league.json [-o state.json]
  mmsave suppliers <save.sav> --league league.json   next season's supplier offers per member team, as publish would show them
  mmsave publish  <save.sav> --league league.json [--dry-run]   upload to the league website
  mmsave pull     --league league.json [-o changes.json] [--mark-applied] [--force]   members' decisions as changes
  mmsave archive  --league league.json [-o backup.json] [--end]   back up the league's series; --end then deletes it from the site
  mmsave restore  <backup.json> [--as <series id>]               put an archived series back on the site
  mmsave team-mod --league league.json [-o out/team-mod] [--logos-base teamlogos] [--python py]   members' colours and logos as MM mod files
  mmsave liveries --game <MM_Data> [--python py]      upload MM's livery masks for the site's livery previews (once)
  mmsave game-patch --game <MM_Data> [--retire on|off] [--status] [--restore]   the player team's cars retire as qualifying and races start (patches the game, original backed up)
  mmsave apply    <save.sav> <changes.json> [-o out.sav] [--name "Shown name"]
  mmsave diff     <a.sav> <b.sav> [--team NAME] [--path teamManager] [--depth N]

Saves default to ${defaultSavesDir()}
A save name without a path is looked up there. Output never overwrites the input.`;

const { values: opt, positionals: [cmd, ...args] } = parseArgsOrExit({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o" },
    league: { type: "string" },
    name: { type: "string" },
    team: { type: "string" },
    path: { type: "string" },
    depth: { type: "string" },
    limit: { type: "string" },
    "dry-run": { type: "boolean" },
    "mark-applied": { type: "boolean" },
    force: { type: "boolean" },
    end: { type: "boolean" },
    as: { type: "string" },
    "logos-base": { type: "string" },
    python: { type: "string" },
    game: { type: "string" },
    retire: { type: "string" },
    status: { type: "boolean" },
    restore: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

/** parseArgs, but a mistyped option prints one line instead of a stack trace. */
function parseArgsOrExit<const T extends ParseArgsConfig>(config: T): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (e) {
    // e.g. "Option '--league <value>' argument missing" when the file name is left out.
    console.error(`error: ${(e as Error).message.replace(/<value>' argument missing/, "<value>' needs a value, e.g. --league league-main.json")}`);
    console.error("Run without arguments for usage.");
    process.exit(1);
  }
}

function savePath(p: string | undefined): string {
  try { return resolveSave(p); } catch (e) { fail((e as Error).message); }
}

/** The league file, which names the series it belongs to on the website. */
function leagueConfig(command: string): LeagueConfig {
  if (!opt.league) fail(`${command} needs --league league.json`);
  return readLeague(opt.league);
}

/** Supabase settings for the league file's series. */
function seriesEnv(cfg: LeagueConfig): SupabaseEnv {
  try { return seriesEnvFor(cfg, opt.league); } catch (e) { fail((e as Error).message); }
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

switch (cmd) {
  case "decode": {
    const input = savePath(args[0]);
    const dir = opt.out ?? basename(input, ".sav");
    const raw = unpack(readFileSync(input));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "header.json"), raw.headerText);
    writeFileSync(join(dir, "data.json"), raw.dataText);
    writeFileSync(join(dir, "version.txt"), String(raw.version));
    console.log(`wrote ${dir}/header.json, data.json`);
    break;
  }
  case "encode": {
    const dir = args[0] ?? fail("missing directory");
    if (!opt.out) fail("encode needs -o <out.sav>");
    const version = Number(readFileSync(join(dir, "version.txt"), "utf8"));
    // Re-print through the lossless printer so hand-edited JSON is back in FullSerializer's style.
    const headerText = stringifyLossless(parseLossless(readFileSync(join(dir, "header.json"), "utf8")));
    const dataText = stringifyLossless(parseLossless(readFileSync(join(dir, "data.json"), "utf8")));
    writeFileSync(opt.out, pack({ version, headerText, dataText }));
    console.log(`wrote ${opt.out}`);
    break;
  }
  case "validate": {
    const save = Save.load(savePath(args[0]));
    const problems = save.g.validate();
    console.log(problems.length ? problems.slice(0, 50).join("\n") : `ok: ${save.g.byId.size} objects, date ${save.now}`);
    process.exit(problems.length ? 1 : 0);
  }
  case "teams": {
    const save = Save.load(savePath(args[0]));
    const byChamp = new Map<string, string[]>();
    for (const t of save.teams()) {
      if (!t.championship) continue;
      const ch = save.championshipName(save.championship(t));
      byChamp.set(ch, [...(byChamp.get(ch) ?? []), `${String(t.teamID).padStart(3)}  ${t.name}`]);
    }
    for (const [ch, ts] of byChamp) console.log(`${ch}\n  ${ts.join("\n  ")}`);
    break;
  }
  case "extract": {
    const input = savePath(args[0]);
    if (!opt.league) fail("extract needs --league league.json");
    const cfg = JSON.parse(readFileSync(opt.league, "utf8")) as LeagueConfig;
    const state = extractLeague(Save.load(input), cfg);
    const json = JSON.stringify(state, null, 2);
    if (opt.out) writeFileSync(opt.out, json), console.log(`wrote ${opt.out}`);
    else console.log(json);
    break;
  }
  case "suppliers": {
    // What members will see on Parts -> Next season's car if this save is published.
    const input = savePath(args[0]);
    if (!opt.league) fail("suppliers needs --league league.json");
    const cfg = JSON.parse(readFileSync(opt.league, "utf8")) as LeagueConfig;
    const save = Save.load(input);
    const state = extractLeague(save, cfg);
    const drawn = JSON.stringify(save.data.supplierManager.championshipSuppliers ?? {});
    const ended = state.championship.calendar.filter((e) => e.ended).length;
    console.log(`${state.championship.name}, game date ${state.gameDate.slice(0, 10)}, ${ended}/${state.championship.calendar.length} races done`);
    console.log(`MM's draw for next season: ${drawn === "{}" || drawn === "[]" ? "not made yet (MM draws it when pre-season starts)" : "present"}`);
    for (const t of state.teams.filter((x) => x.member)) {
      const car = t.design?.nextYearCar;
      if (!car) { console.log(`  ${t.name}: no next-year car data`); continue; }
      const types = Object.entries(car.options);
      const counts = types.map(([k, v]) => `${k} ${v.length}`).join(", ");
      console.log(`  ${t.name} (${car.season} car, MM ${car.state}): ${counts || "no offers"}`);
      for (const [k, v] of types) console.log(`    ${k}: ${v.map((o) => `${o.name} $${(o.price / 1e6).toFixed(1)}M`).join(", ")}`);
    }
    break;
  }
  case "publish": {
    const input = savePath(args[0]);
    if (!opt.league) fail("publish needs --league league.json");
    await publishSave(input, readLeague(opt.league), { dryRun: opt["dry-run"], leagueFile: opt.league }, console.log);
    break;
  }
  case "pull": {
    // Everything members decided since the last apply (src/commands/pull.ts).
    const cfg = leagueConfig("pull");
    const env = seriesEnv(cfg);
    const r = await pullDecisions(env, { force: opt.force }, console.log);
    const json = JSON.stringify(r.set, null, 2);
    if (opt.out) writeFileSync(opt.out, json), console.log(`wrote ${opt.out}`);
    else console.log(json);
    if (opt["mark-applied"]) await r.markApplied(console.log);
    break;
  }
  case "team-mod": {
    // Colours and approved logos for every series, as files for MM_Data/Modding (src/team-look-orders.ts).
    const cfg = leagueConfig("team-mod");
    const env = seriesEnv(cfg);
    const out = opt.out ?? join("out", "team-mod");
    await buildTeamMod(env, { out, logosBase: opt["logos-base"], python: opt.python }, console.log);
    console.log(`wrote ${join(out, "Modding")}. Copy its Databases and Images files into MM_Data/Modding, `
      + "restart MM and switch the staging mod on in the Workshop screen.");
    break;
  }
  case "liveries": {
    if (!opt.game) fail("liveries needs --game <path to MM_Data>");
    await uploadLiveryMasks(supabaseEnv(), { dataDir: opt.game, out: join("out", "liveries"), python: opt.python }, console.log);
    break;
  }
  case "game-patch": {
    // tools/league-patch: Assembly-CSharp.dll is backed up as .orig; --restore puts it back.
    if (!opt.game) fail("game-patch needs --game <path to MM_Data>");
    if (opt.retire && !["on", "off"].includes(opt.retire)) fail("--retire is on or off");
    const mode = opt.restore ? "restore" : opt.status ? "status" : "patch";
    gamePatch(opt.game, { mode, retire: opt.retire ? opt.retire === "on" : undefined, out: join("out", "league-patch") }, console.log);
    break;
  }
  case "archive": {
    // A full JSON backup of the series; with --end, the series is then deleted from the site.
    const cfg = leagueConfig("archive");
    const env = seriesEnv(cfg);
    const backup = await rest<{ series: { name: string }; tables: Record<string, unknown[]> }>(env, "POST", "rpc/export_series", {});
    const out = opt.out ?? `backup-${env.series}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    writeFileSync(out, JSON.stringify(backup));
    const counts = Object.entries(backup.tables).filter(([, rows]) => rows.length).map(([t, rows]) => `${t} ${rows.length}`);
    console.log(`wrote ${out}: series "${env.series}" (${backup.series.name}), ${counts.join(", ")}`);
    if (!opt.end) {
      console.log("Nothing deleted. Add --end to delete the series from the site after the backup.");
      break;
    }
    // Check the file before deleting anything.
    const check = JSON.parse(readFileSync(out, "utf8")) as typeof backup;
    if (JSON.stringify(check.tables) !== JSON.stringify(backup.tables)) fail(`${out} doesn't read back the same; nothing deleted`);
    await rest(env, "POST", "rpc/end_series", { series_id: env.series });
    console.log(`series "${env.series}" deleted from the site. Restore it with: mmsave restore ${out}`);
    break;
  }
  case "restore": {
    const file = args[0] ?? fail("missing backup.json");
    const backup = JSON.parse(readFileSync(file, "utf8")) as { series: { id: string; name: string } };
    const env = supabaseEnv();
    await rest(env, "POST", "rpc/import_series", { backup, as_id: opt.as ?? null });
    console.log(`restored series "${opt.as ?? backup.series.id}" (${backup.series.name}) from ${file}`);
    break;
  }
  case "apply": {
    const input = savePath(args[0]);
    const set = JSON.parse(readFileSync(args[1] ?? fail("missing changes.json"), "utf8")) as ChangeSet;
    // A bare file name goes next to the input save (usually the saves folder), not the current folder.
    const out = opt.out && !/[\\/]/.test(opt.out) ? join(dirname(input), opt.out) : opt.out ?? undefined;
    if ((out ?? defaultApplyOut(input)) === input) fail("refusing to overwrite the input save; pass a different -o");
    applyToSave(input, set, { out, name: opt.name }, console.log);
    break;
  }
  case "diff": {
    const a = Save.load(savePath(args[0]));
    const b = Save.load(savePath(args[1]));
    let ra: any = a.data, rb: any = b.data, label = "";
    if (opt.team) { ra = a.team(opt.team); rb = b.team(opt.team); label = `team(${opt.team})`; }
    for (const seg of (opt.path ?? "").split(".").filter(Boolean)) { ra = a.g.deref(ra)[seg]; rb = b.g.deref(rb)[seg]; label += "." + seg; }
    const lines = diffObjects(a.g, ra, b.g, rb, label || "root", {
      maxDepth: Number(opt.depth ?? 6),
      limit: Number(opt.limit ?? 500),
    });
    console.log(lines.length ? lines.join("\n") : "no differences");
    break;
  }
  default:
    console.log(USAGE);
    process.exit(cmd && !opt.help ? 1 : 0);
}
