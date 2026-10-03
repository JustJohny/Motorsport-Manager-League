#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { applyChanges, type ChangeSet } from "./apply.ts";
import { pack, parseLossless, stringifyLossless, unpack } from "./codec/sav.ts";
import { diffObjects } from "./diff.ts";
import { extractLeague, type LeagueConfig } from "./extract.ts";
import { Save } from "./model.ts";
import { defaultSavesDir } from "./paths.ts";
import { memberRows, publish, splitSnapshot } from "./publish.ts";
import { cancelUnorderedChange, fetchHqContext, fetchQueuedOrders, hqChanges, markOrdersApplied } from "./hq-orders.ts";
import type { LeagueSettings } from "./league-rules.ts";
import { choiceChanges, designChanges, fetchPartsContext, markDesignsApplied, undoAiParts } from "./part-orders.ts";
import { engineSpendChanges, fetchEngineSpend, fetchSupplierContext, markEngineSpendApplied, supplierChanges } from "./engine-orders.ts";
import { crewChanges, crewSpendChanges, crewUpdates, fetchCrewContext, fetchCrewSpend, markCrewSpendApplied, saveCrewUpdates } from "./crew-orders.ts";
import { fetchSponsorOrders, markSponsorOrders, sponsorChanges } from "./sponsor-orders.ts";
import { crewNamePool } from "./ops/pit-crew.ts";
import { equalizeChanges, fetchEqualize, markEqualizeApplied, resetCrews } from "./equalize-orders.ts";
import { fetchRegulationContext, recordVoteResults, regulationChanges } from "./rule-votes.ts";
import { rest, supabaseEnv, type SupabaseEnv } from "./supabase.ts";
import { fetchWindow, markApplied, windowChanges, winners } from "./transfers.ts";

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
  if (!p) fail("missing save file");
  if (existsSync(p)) return p;
  const inDir = join(defaultSavesDir(), p.endsWith(".sav") ? p : `${p}.sav`);
  if (existsSync(inDir)) return inDir;
  fail(`no such save: ${p}`);
}

/** The league file, which names the series it belongs to on the website. */
function leagueConfig(command: string): LeagueConfig {
  if (!opt.league) fail(`${command} needs --league league.json`);
  return JSON.parse(readFileSync(opt.league, "utf8")) as LeagueConfig;
}

/** Supabase settings for the league file's series. */
function seriesEnv(cfg: LeagueConfig): SupabaseEnv {
  const id = cfg.series?.id;
  if (!id) fail(`${opt.league} has no series: add "series": { "id": "main", "name": "…" } (main is the league from before series existed)`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`series id "${id}": use lower case letters, digits and dashes`);
  return { ...supabaseEnv(), series: id };
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function outPath(input: string, suffix: string): string {
  const out = opt.out ?? join(dirname(input), basename(input, ".sav") + suffix);
  if (out === input) fail("refusing to overwrite the input save; pass a different -o");
  return out;
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
    console.log(`MM's draw for next season: ${drawn === "{}" || drawn === "[]" ? "not made yet (MM draws it when the season ends, after the final race)" : "present"}`);
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
    const cfg = JSON.parse(readFileSync(opt.league, "utf8")) as LeagueConfig;
    const save = Save.load(input);
    const state = extractLeague(save, cfg);
    const split = splitSnapshot(state);
    const members = memberRows(cfg, state);
    const ch = state.championship;
    console.log(`${ch.name}, after round ${ch.lastRace?.round ?? 0}: ${split.teams.length} teams, ${split.freeAgents.length} free agents`);
    for (const m of members) console.log(`  ${m.discord_username} -> ${m.team}${m.role === "organizer" ? " (organizer)" : ""}`);
    if (!members.length) console.log("  WARNING: no member has a \"discord\" username in the league file, so nobody can log in");
    if (opt["dry-run"]) break;
    const env = seriesEnv(cfg);
    console.log(`published snapshot #${await publish(env, members, split, cfg.series?.name)} to series "${env.series}"`);
    // Member pit crews: starting crews for new member teams, then every race since the last publish.
    const crew = crewUpdates(state, await fetchCrewContext(env), env.series!, crewNamePool(save));
    await saveCrewUpdates(env, crew);
    for (const u of crew) {
      const costs = u.spend.reduce((s, x) => s + x.amount, 0);
      console.log(`  Pit crew ${u.team}: ${u.log.map((l) => l.message).join("; ") || "races processed"}${costs ? `, costs $${costs.toLocaleString()}` : ""}`);
    }
    break;
  }
  case "pull": {
    // Everything members decided since the last apply: queued HQ orders and, once its deadline
    // has passed, the transfer window's signings.
    const env = seriesEnv(leagueConfig("pull"));
    console.log(`Series "${env.series}"`);
    const [w, orders, [settings]] = await Promise.all([
      fetchWindow(env), fetchQueuedOrders(env), rest<LeagueSettings[]>(env, "GET", "league_settings?select=*"),
    ]);
    const changes: ChangeSet["changes"] = [];
    const notes: string[] = [];

    // First undo what the in-game AI did to member teams' HQ since the last apply.
    const ctx = await fetchHqContext(env);
    if (ctx.leagueStart && ctx.memberTeams.length) changes.push(cancelUnorderedChange(ctx.memberTeams, ctx.orders, ctx.leagueStart));
    // ...and to their parts: AI designs and AI-built parts go, refunded.
    const parts = await fetchPartsContext(env);
    if (ctx.leagueStart && ctx.memberTeams.length) changes.push(...undoAiParts(ctx.memberTeams, parts.orders, ctx.leagueStart));

    // The organizer's equalization: after undoing the AI, before members' own orders.
    const eq = await fetchEqualize(env);
    if (eq.row && eq.snapshot) {
      const teams = eq.snapshot.teams.map((t) => t.name);
      console.log(`Equalize the field: ${teams.length} teams (${Object.keys(eq.row.settings).join(", ")})`);
      changes.push(...equalizeChanges(eq.row, teams));
      notes.push("equalization");
    }

    console.log(`HQ orders: ${orders.length}`);
    for (const o of orders) {
      console.log(`  ${o.team}: ${o.to_level === 1 ? "build" : "upgrade"} ${o.building_name}${o.to_level > 1 ? ` to level ${o.to_level}` : ""}`
        + ` for $${Number(o.cost).toLocaleString()} (${Math.round(o.weeks * Number(settings.hq_speed))} weeks)`);
    }
    changes.push(...hqChanges(orders, Number(settings.hq_speed)));

    console.log(`Part designs: ${parts.queued.length}`);
    for (const o of parts.queued) console.log(`  ${o.team}: ${o.part_type} with components ${o.components.join(", ")} for $${Number(o.cost).toLocaleString()}`);
    changes.push(...designChanges(parts.queued));
    // Fitting and improvement are standing choices: re-applied every time, after the designs.
    console.log(`Fitting choices: ${parts.fitting.length}, improvement choices: ${parts.improvement.length}`);
    changes.push(...choiceChanges(parts.fitting, parts.improvement));

    // Engine programme spending (founding, development, research, engines bought from members).
    const engineSpend = await fetchEngineSpend(env);
    for (const r of engineSpend) console.log(`  Engine: ${r.team} ${r.description} $${Number(r.amount).toLocaleString()}${r.payee ? ` to ${r.payee}` : ""}`);
    changes.push(...engineSpendChanges(engineSpend));
    if (engineSpend.length) notes.push(`${engineSpend.length} engine payment${engineSpend.length > 1 ? "s" : ""}`);

    // Next season's suppliers: applied once MM's AI has started next year's design (pre-season).
    const suppliers = await fetchSupplierContext(env);
    const sc = supplierChanges(suppliers.rows, suppliers.cars, ctx.memberTeams);
    changes.push(...sc.changes);
    if (sc.changes.length || sc.waiting.length) {
      console.log(`Next season's suppliers: ${sc.changes.length} team${sc.changes.length === 1 ? "" : "s"}${sc.waiting.length ? `, waiting for pre-season: ${sc.waiting.join(", ")}` : ""}`);
      for (const c of sc.changes) if (c.op === "setSuppliers") console.log(`  ${c.team}: ${Object.entries(c.suppliers).map(([t, id]) => `${t} ${id}`).join(", ")}`);
    }
    for (const u of sc.unavailable) console.log(`  WARNING: supplier no longer on offer, keeping current: ${u}`);
    if (sc.changes.length) notes.push(`next season's suppliers for ${sc.changes.length} team${sc.changes.length === 1 ? "" : "s"}`);

    // Rule votes due before the next checkpoint, settled with the league's result instead of MM's;
    // then the organizer's choices for next season.
    const reg = await fetchRegulationContext(env);
    let voteResults: Awaited<ReturnType<typeof regulationChanges>>["results"] = [];
    const regs = reg.snapshot?.championship.regulations;
    if (reg.snapshot && regs) {
      const next = reg.snapshot.championship.calendar.find((e) => !e.ended)?.date ?? null;
      const r = regulationChanges(regs, reg.snapshot.championship.id, reg.snapshot.gameDate, next, reg.rows, reg.overrides, reg.decided);
      voteResults = r.results;
      for (const v of r.results) console.log(`  Rule vote ${v.rule_id}: ${v.accepted ? "accepted" : "rejected"} ${v.yes}-${v.no} (${v.abstained} abstained)`);
      console.log(`Rule votes settled: ${r.results.length}, next-season overrides: ${reg.overrides.filter((o) => o.season === regs.season).length}`);
      changes.push(...r.changes);
      if (r.results.length) notes.push(`${r.results.length} rule vote${r.results.length > 1 ? "s" : ""}`);
    }

    // Member pit crews: their skills into MM's per-task values (a standing choice, re-applied every
    // time), then their wages, funding and sign-on fees.
    let crewCtx = await fetchCrewContext(env);
    // An equalization restarts member crews at its skill (saved below with --mark-applied).
    const crewReset = eq.row?.settings.pitCrew && eq.snapshot ? resetCrews(crewCtx, env.series!, eq.snapshot, eq.row.settings.pitCrew.skill) : [];
    if (crewReset.length) {
      crewCtx = { ...crewCtx, crew: crewReset.flatMap((u) => u.crew.map((c) => ({ ...c, team: u.team }))) };
      console.log(`  Pit crews reset: ${crewReset.map((u) => u.team).join(", ")}`);
    }
    const crewOps = crewChanges(crewCtx, reg.snapshot?.championship.pitCrew?.roles ?? []);
    for (const c of crewOps) if (c.op === "setPitCrew") console.log(`  Pit crew ${c.team}: ${c.tasks.map((x) => `task ${x.target} ${x.stat}/${x.confidence}`).join(", ")}`);
    changes.push(...crewOps);
    const crewSpend = await fetchCrewSpend(env);
    for (const r of crewSpend) console.log(`  Crew: ${r.team} ${r.description} $${Number(r.amount).toLocaleString()}`);
    changes.push(...crewSpendChanges(crewSpend));
    if (crewOps.length) notes.push(`${crewOps.length} pit crew${crewOps.length > 1 ? "s" : ""}`);
    if (crewSpend.length) notes.push(`${crewSpend.length} crew payment${crewSpend.length > 1 ? "s" : ""}`);

    // Sponsors: AI deals members dropped (upfront paid back), then the offers they signed.
    const sponsorCtx = await fetchSponsorOrders(env);
    const sponsors = sponsorChanges(sponsorCtx.orders, sponsorCtx.gameDate);
    for (const o of sponsors.applied) {
      console.log(`  Sponsor: ${o.team} ${o.kind === "sign" ? "signs" : "drops"} ${o.sponsor_name} (slot ${o.slot})${Number(o.amount) ? `, upfront $${Number(o.amount).toLocaleString()}${o.kind === "drop" ? " paid back" : ""}` : ""}`);
    }
    for (const o of sponsors.expired) console.log(`  WARNING: ${o.team}'s offer from ${o.sponsor_name} lapsed on ${o.expires?.slice(0, 10)}; left out`);
    changes.push(...sponsors.changes);
    if (sponsors.applied.length) notes.push(`${sponsors.applied.length} sponsor choice${sponsors.applied.length > 1 ? "s" : ""}`);

    let windowDone = false;
    if (!w) console.log("Transfer window: none waiting");
    else if (new Date(w.window.closes_at) > new Date() && !opt.force) {
      console.log(`Transfer window #${w.window.id}: still open until ${new Date(w.window.closes_at).toLocaleString()}, skipped (--force to include)`);
    } else {
      const won = winners(w.auctions, w.bids, w.settings);
      console.log(`Transfer window #${w.window.id}: ${w.auctions.length} auctions, ${won.length} signings`);
      for (const s of won) {
        console.log(`  ${s.team}: ${s.person.name}${s.fromTeam ? ` from ${s.fromTeam}` : ""} for $${s.wage.toLocaleString()}/yr x${s.years}, replacing ${s.replacingName}`
          + ` (fee $${s.signOnFee.toLocaleString()}${s.buyout ? `, buyout $${s.buyout.toLocaleString()}` : ""})`);
      }
      changes.push(...windowChanges(w.window.id, w.gameDate, w.auctions, w.bids, w.settings).changes);
      notes.push(`transfer window #${w.window.id}`);
      windowDone = true;
    }
    if (orders.length) notes.push(`${orders.length} HQ order${orders.length > 1 ? "s" : ""}`);
    if (parts.queued.length) notes.push(`${parts.queued.length} part design${parts.queued.length > 1 ? "s" : ""}`);

    const json = JSON.stringify({ description: notes.join(" + ") || "nothing to apply", changes }, null, 2);
    if (opt.out) writeFileSync(opt.out, json), console.log(`wrote ${opt.out}`);
    else console.log(json);
    if (opt["mark-applied"]) {
      await markOrdersApplied(env, orders.map((o) => o.id));
      await markDesignsApplied(env, parts.queued.map((o) => o.id));
      await recordVoteResults(env, voteResults);
      await markEngineSpendApplied(env, engineSpend.map((r) => r.id));
      await markCrewSpendApplied(env, crewSpend.map((r) => r.id));
      await markSponsorOrders(env, sponsors.applied.map((o) => o.id), sponsors.expired.map((o) => o.id));
      if (eq.row) {
        await saveCrewUpdates(env, crewReset);
        await markEqualizeApplied(env, eq.row.id);
      }
      if (windowDone && w) await markApplied(env, w.window.id);
      console.log(`marked as applied: ${notes.join(" + ") || "nothing"}`);
    }
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
    const save = Save.load(input);
    for (const line of applyChanges(save, set)) console.log(`  ${line}`);
    if (opt.name) {
      // The name shown in MM's load menu comes from the header, not the file name.
      save.file.header.saveInfo.name = opt.name;
      save.file.header.saveInfo.isAutoSave = false;
    }
    const out = outPath(input, " (league).sav");
    save.write(out);
    console.log(`wrote ${out}`);
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
