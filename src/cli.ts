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

const USAGE = `mmsave - Motorsport Manager league save toolkit

  mmsave decode   <save.sav> [-o dir]                 unpack to header.json + data.json
  mmsave encode   <dir> -o <out.sav>                  repack header.json + data.json
  mmsave validate <save.sav>                          check the object graph
  mmsave teams    <save.sav>                          list teams by championship
  mmsave extract  <save.sav> --league league.json [-o state.json]
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
