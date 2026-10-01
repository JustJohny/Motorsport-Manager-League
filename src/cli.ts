#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
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
import { fetchRegulationContext, recordVoteResults, regulationChanges } from "./rule-votes.ts";
import { rest, supabaseEnv } from "./supabase.ts";
import { fetchWindow, markApplied, windowChanges, winners } from "./transfers.ts";

const USAGE = `mmsave - Motorsport Manager league save toolkit

  mmsave decode   <save.sav> [-o dir]                 unpack to header.json + data.json
  mmsave encode   <dir> -o <out.sav>                  repack header.json + data.json
  mmsave validate <save.sav>                          check the object graph
  mmsave teams    <save.sav>                          list teams by championship
  mmsave extract  <save.sav> --league league.json [-o state.json]
  mmsave publish  <save.sav> --league league.json [--dry-run]   upload to the league website
  mmsave pull     [-o changes.json] [--mark-applied] [--force] HQ orders, part designs, fitting, improvement + transfer results as changes
  mmsave apply    <save.sav> <changes.json> [-o out.sav] [--name "Shown name"]
  mmsave diff     <a.sav> <b.sav> [--team NAME] [--path teamManager] [--depth N]

Saves default to ${defaultSavesDir()}
A save name without a path is looked up there. Output never overwrites the input.`;

const { values: opt, positionals: [cmd, ...args] } = parseArgs({
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
    help: { type: "boolean", short: "h" },
  },
});

function savePath(p: string | undefined): string {
  if (!p) fail("missing save file");
  if (existsSync(p)) return p;
  const inDir = join(defaultSavesDir(), p.endsWith(".sav") ? p : `${p}.sav`);
  if (existsSync(inDir)) return inDir;
  fail(`no such save: ${p}`);
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
  case "publish": {
    const input = savePath(args[0]);
    if (!opt.league) fail("publish needs --league league.json");
    const cfg = JSON.parse(readFileSync(opt.league, "utf8")) as LeagueConfig;
    const state = extractLeague(Save.load(input), cfg);
    const split = splitSnapshot(state);
    const members = memberRows(cfg, state);
    const ch = state.championship;
    console.log(`${ch.name}, after round ${ch.lastRace?.round ?? 0}: ${split.teams.length} teams, ${split.freeAgents.length} free agents`);
    for (const m of members) console.log(`  ${m.discord_username} -> ${m.team}${m.role === "organizer" ? " (organizer)" : ""}`);
    if (!members.length) console.log("  WARNING: no member has a \"discord\" username in the league file, so nobody can log in");
    if (opt["dry-run"]) break;
    console.log(`published snapshot #${await publish(supabaseEnv(), members, split)}`);
    break;
  }
  case "pull": {
    // Everything members decided since the last apply: queued HQ orders and, once its deadline
    // has passed, the transfer window's signings.
    const env = supabaseEnv();
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
    const supplierRows = await fetchSupplierContext(env);
    if (supplierRows.length) {
      const privs = await rest<{ team: string; private: { design?: { nextYearCar?: { state: string } } } }[]>(
        env, "GET", "team_snapshots?select=team,private&order=snapshot_id.desc&limit=200");
      const latest = new Map<string, string>();
      for (const p of privs) if (!latest.has(p.team)) latest.set(p.team, p.private.design?.nextYearCar?.state ?? "waiting");
      const sc = supplierChanges(supplierRows, new Set([...latest].filter(([, st]) => st === "designing").map(([t]) => t)));
      changes.push(...sc.changes);
      console.log(`Supplier choices applied: ${sc.changes.length}${sc.waiting.length ? `, waiting for pre-season: ${sc.waiting.join(", ")}` : ""}`);
    }

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
      if (windowDone && w) await markApplied(env, w.window.id);
      console.log(`marked as applied: ${notes.join(" + ") || "nothing"}`);
    }
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
