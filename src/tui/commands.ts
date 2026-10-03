// Every CLI command as a form: its fields, defaults from the selected series and save, how the
// values become `src/cli.ts` arguments, and what to confirm before running it.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultSavesDir } from "../paths.ts";
import { seriesFiles } from "../race-cycle.ts";
import type { SaveEntry, SeriesEntry } from "./data.ts";

export type FieldKind =
  | "save"      // a save from the saves folder (its path)
  | "newSave"   // a name for a new save in the saves folder (must not exist)
  | "file"      // a file in the toolkit folder matching `pattern`
  | "text"
  | "number"
  | "flag";

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  /** Command-line option ("--league"); without it the field is positional, in field order. */
  option?: string;
  required?: boolean;
  pattern?: RegExp;
  help?: string;
}

export interface Context { series?: SeriesEntry; save?: SaveEntry }
export type Values = Record<string, string | boolean>;

export interface CommandSpec {
  name: string;
  summary: string;
  fields: Field[];
  defaults: (ctx: Context) => Values;
  /** Extra checks before running (e.g. a file that would be overwritten). */
  check?: (v: Values) => string | null;
  /** Set when the command uploads, deletes or writes something: shown in the confirmation. */
  confirm?: (v: Values) => string | null;
  /** The command writes a save: rescan the saves folder afterwards. */
  writesSave?: boolean;
}

const leagueField: Field = { key: "league", label: "League file", kind: "file", option: "--league", pattern: /^league(-[\w-]+)?\.json$/, required: true };
const saveField = (key = "save", label = "Save"): Field => ({ key, label, kind: "save", required: true });
const leagueOf = (c: Context) => c.series?.file ?? "";
const changesOf = (c: Context) => (c.series ? seriesFiles({ id: c.series.id, name: c.series.name }).changes : "changes.json");
const savePath = (name: string) => join(defaultSavesDir(), `Save${name}.sav`);

export const COMMANDS: CommandSpec[] = [
  {
    name: "validate", summary: "Check a save's object graph (duplicate ids, dangling or forward references).",
    fields: [saveField()], defaults: (c) => ({ save: c.save?.path ?? "" }),
  },
  {
    name: "teams", summary: "List every team by championship, with team ids.",
    fields: [saveField()], defaults: (c) => ({ save: c.save?.path ?? "" }),
  },
  {
    name: "extract", summary: "What publish would upload, as a JSON file (every team of the league championship, free agents, calendar, results).",
    fields: [saveField(), leagueField, { key: "out", label: "Output file", kind: "text", option: "-o", required: true }],
    defaults: (c) => ({ save: c.save?.path ?? "", league: leagueOf(c), out: `state-${c.series?.id ?? "league"}.json` }),
  },
  {
    name: "suppliers", summary: "Next season's supplier offers per member team, as publish would show them.",
    fields: [saveField(), leagueField], defaults: (c) => ({ save: c.save?.path ?? "", league: leagueOf(c) }),
  },
  {
    name: "publish", summary: "Upload the save to the league website, then run member pit crews through the races since the last publish.",
    fields: [saveField(), leagueField, { key: "dry-run", label: "Dry run (upload nothing)", kind: "flag", option: "--dry-run" }],
    defaults: (c) => ({ save: c.save?.path ?? "", league: leagueOf(c), "dry-run": false }),
    confirm: (v) => (v["dry-run"] ? null : "This uploads the save to the website: members see it straight away."),
  },
  {
    name: "pull", summary: "Members' decisions since the last apply, as a changes file.",
    fields: [
      leagueField,
      { key: "out", label: "Changes file", kind: "text", option: "-o", required: true },
      { key: "mark-applied", label: "Mark applied on the site", kind: "flag", option: "--mark-applied", help: "Only when you'll apply this file: the next pull won't include these decisions again." },
      { key: "force", label: "Include an open transfer window", kind: "flag", option: "--force" },
    ],
    defaults: (c) => ({ league: leagueOf(c), out: changesOf(c), "mark-applied": false, force: false }),
    confirm: (v) => {
      const bits = [existsSync(String(v.out)) ? `${v.out} is replaced.` : null, v["mark-applied"] ? "The pulled decisions are marked applied on the site." : null].filter(Boolean);
      return bits.length ? bits.join(" ") : null;
    },
  },
  {
    name: "apply", summary: "Apply a changes file to a save and write a new save (never the save itself).",
    fields: [
      saveField(),
      { key: "changes", label: "Changes file", kind: "file", pattern: /\.json$/, required: true },
      { key: "out", label: "New save name", kind: "newSave", option: "-o", required: true, help: "Written as Save<name>.sav in the saves folder." },
      { key: "name", label: "Name in MM's load menu", kind: "text", option: "--name" },
    ],
    defaults: (c) => ({ save: c.save?.path ?? "", changes: changesOf(c), out: c.save ? `${c.save.name} (league)` : "", name: c.save ? `${c.save.name} (league)` : "" }),
    check: (v) => (existsSync(savePath(String(v.out))) ? `Save${v.out}.sav already exists; pick another name` : null),
    confirm: (v) => `Writes Save${v.out}.sav in the saves folder.`,
    writesSave: true,
  },
  {
    name: "diff", summary: "Field-level differences between two saves (the Compare screen shows them as a tree).",
    fields: [
      saveField("a", "Save A"), saveField("b", "Save B"),
      { key: "team", label: "Only this team", kind: "text", option: "--team" },
      { key: "path", label: "Only this path", kind: "text", option: "--path", help: "e.g. teamManager or carManager.partInventory" },
      { key: "depth", label: "Depth", kind: "number", option: "--depth" },
      { key: "limit", label: "Max lines", kind: "number", option: "--limit" },
    ],
    defaults: (c) => ({ a: c.save?.path ?? "", b: "", team: "", path: "", depth: "6", limit: "500" }),
  },
  {
    name: "decode", summary: "Unpack a save to header.json + data.json (for hand edits).",
    fields: [saveField(), { key: "out", label: "Folder", kind: "text", option: "-o", required: true }],
    defaults: (c) => ({ save: c.save?.path ?? "", out: c.save ? `decoded-${c.save.name.replace(/[^\w.-]+/g, "_")}` : "" }),
    confirm: (v) => (existsSync(String(v.out)) ? `${v.out}/ exists: its header.json and data.json are replaced.` : null),
  },
  {
    name: "encode", summary: "Pack a decoded folder back into a save.",
    fields: [
      { key: "dir", label: "Folder", kind: "text", required: true },
      { key: "out", label: "New save name", kind: "newSave", option: "-o", required: true },
    ],
    defaults: () => ({ dir: "", out: "" }),
    check: (v) => (!existsSync(join(String(v.dir), "data.json")) ? `${v.dir}/data.json not found` : existsSync(savePath(String(v.out))) ? `Save${v.out}.sav already exists` : null),
    confirm: (v) => `Writes Save${v.out}.sav in the saves folder. Hand-edited saves skip the toolkit's checks: run validate on it before loading it in MM.`,
    writesSave: true,
  },
  {
    name: "archive", summary: "Back up the series from the website to a JSON file; with “end”, then delete it from the site.",
    fields: [
      leagueField,
      { key: "out", label: "Backup file", kind: "text", option: "-o", help: "Empty: backup-<series>-<time>.json" },
      { key: "end", label: "End the series (delete it from the site)", kind: "flag", option: "--end" },
    ],
    defaults: (c) => ({ league: leagueOf(c), out: "", end: false }),
    confirm: (v) => (v.end ? "This DELETES the series from the website after writing the backup. Members lose access until you restore it." : null),
  },
  {
    name: "restore", summary: "Put an archived series back on the website.",
    fields: [
      { key: "backup", label: "Backup file", kind: "file", pattern: /^backup-.*\.json$/, required: true },
      { key: "as", label: "As series id", kind: "text", option: "--as", help: "Empty: the id in the backup" },
    ],
    defaults: () => ({ backup: "", as: "" }),
    confirm: (v) => `This restores ${v.backup} to the website${v.as ? ` as series "${v.as}"` : ""}.`,
  },
];

/** The command-line arguments for `src/cli.ts`. */
export function argv(spec: CommandSpec, v: Values): string[] {
  const out: string[] = [spec.name];
  for (const f of spec.fields) {
    const val = v[f.key];
    if (f.option) continue;
    out.push(String(val ?? ""));
  }
  for (const f of spec.fields) {
    const val = v[f.key];
    if (!f.option) continue;
    if (f.kind === "flag") { if (val) out.push(f.option); continue; }
    if (val === "" || val == null) continue;
    out.push(f.option, f.kind === "newSave" ? savePath(String(val)) : String(val));
  }
  return out;
}

/** How the command reads on a shell prompt (saves by name, as the CLI accepts them). */
export function commandLine(spec: CommandSpec, v: Values): string {
  const dir = defaultSavesDir() + "/";
  const q = (s: string) => {
    const short = s.startsWith(dir) ? s.slice(dir.length).replace(/\.sav$/, "") : s;
    return /^[\w./-]+$/.test(short) ? short : `"${short}"`;
  };
  return ["mmsave", ...argv(spec, v).map(q)].join(" ");
}

export function missing(spec: CommandSpec, v: Values): string | null {
  const f = spec.fields.find((x) => x.required && !v[x.key]);
  return f ? `${f.label} is required` : null;
}

/** Files in the toolkit folder for a file field, newest first. */
export function filesFor(pattern: RegExp | undefined, dir = "."): { name: string; modified: Date }[] {
  return readdirSync(dir).filter((f) => (!pattern || pattern.test(f)) && statSync(join(dir, f)).isFile())
    .map((f) => ({ name: f, modified: statSync(join(dir, f)).mtime }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}
