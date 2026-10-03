import { stringifyLossless, type Json } from "./codec/sav.ts";
import type { Graph, Obj } from "./graph.ts";
import type { Save } from "./model.ts";

export interface DiffOptions {
  maxDepth?: number;
  limit?: number;
  /** Keys never descended into (large, noisy or purely historical data). */
  skipKeys?: Set<string>;
}

/** One difference: where it is and the two values (or a note about a list). */
export interface DiffEntry {
  path: string;
  a?: string;
  b?: string;
  /** "length 3 -> 4", "list shape changed". */
  note?: string;
}

const DEFAULT_SKIP = new Set(["transactionHistory", "mMoraleStatModificationHistory", "careerHistory", "mCalendarEvent", "records", "OnEventTrigger", "OnButtonClick", "mPastEvents"]);

export const entryText = (e: DiffEntry) => (e.note ? `${e.path}: ${e.note}` : `${e.path}: ${e.a} -> ${e.b}`);

/**
 * Walks pairs of objects from two saves. References are followed (each object once, across every
 * root given to `visit`), so ids that differ between saves do not show up as changes, and an
 * object shows under the first path that reaches it.
 */
function differ(ga: Graph, gb: Graph, opts: DiffOptions, stop?: (x: Obj) => boolean) {
  const out: DiffEntry[] = [];
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 500;
  const skip = opts.skipKeys ?? DEFAULT_SKIP;
  const seen = new Set<Obj>();
  // An object against a missing value or a number: describe it rather than print the whole subtree.
  const leaf = (v: Json) => {
    if (v === undefined) return "<missing>";
    if (v !== null && typeof v === "object" && !(JSON as any).isRawJSON(v)) {
      const arr = Array.isArray(v) ? v : (v as Obj).$content;
      if (Array.isArray(arr)) return `[${arr.length} items]`;
      return typeof (v as Obj).$ref === "string" ? "{ref}" : `{${String((v as Obj).$type ?? "object")}}`;
    }
    return stringifyLossless(v).slice(0, 120);
  };

  const visit = (x: Json, y: Json, p: string, depth: number) => {
    if (out.length >= limit) return;
    x = ga.deref(x);
    y = gb.deref(y);
    const xo = x !== null && typeof x === "object" && !(JSON as any).isRawJSON(x);
    const yo = y !== null && typeof y === "object" && !(JSON as any).isRawJSON(y);
    if (!xo || !yo) {
      if (leaf(x) !== leaf(y)) out.push({ path: p, a: leaf(x), b: leaf(y) });
      return;
    }
    if (seen.has(x)) return;
    // A boundary (another team, a person…) is left for its own pass, so it isn't marked seen here.
    if (depth > 0 && stop?.(x)) return;
    seen.add(x);
    if (depth >= maxDepth) return;
    const xa = Array.isArray(x) ? x : x.$content, ya = Array.isArray(y) ? y : y.$content;
    if (Array.isArray(xa) || Array.isArray(ya)) {
      if (!Array.isArray(xa) || !Array.isArray(ya)) { out.push({ path: p, note: "list shape changed" }); return; }
      if (xa.length !== ya.length) out.push({ path: p, note: `length ${xa.length} -> ${ya.length}` });
      for (let i = 0; i < Math.min(xa.length, ya.length); i++) visit(xa[i], ya[i], `${p}[${i}]`, depth + 1);
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === "$id" || k === "$ref" || skip.has(k)) continue;
      visit(x[k], y[k], `${p}.${k}`, depth + 1);
    }
  };
  return { out, visit, full: () => out.length >= limit, setStop: (f: typeof stop) => { stop = f; } };
}

/** Structural diff of the same object in two saves. */
export function diffEntries(ga: Graph, a: Json, gb: Graph, b: Json, path: string, opts: DiffOptions = {}): DiffEntry[] {
  const d = differ(ga, gb, opts);
  d.visit(a, b, path, 0);
  return d.out;
}

/** As `diffEntries`, as text lines (the CLI's `diff`). */
export function diffObjects(ga: Graph, a: Json, gb: Graph, b: Json, path: string, opts: DiffOptions = {}): string[] {
  return diffEntries(ga, a, gb, b, path, opts).map(entryText);
}

const isTeam = (o: Obj) => "teamID" in o && "carManager" in o;
const isPerson = (o: Obj) => "mFirstName" in o && "contract" in o;
const isChampionship = (o: Obj) => "championshipID" in o && "standings" in o;

/**
 * Two whole saves: each team (matched by teamID, under its name), each person (by GUID, under
 * "Person <name>"), each championship ("Championship <name>"), then the rest of the save. A
 * team's branch stops at other teams, people and championships, so it holds only that team's own
 * data, and every change shows where you'd look for it.
 */
export function diffSaves(a: Save, b: Save, opts: DiffOptions = {}): { entries: DiffEntry[]; truncated: boolean; roots: string[] } {
  const d = differ(a.g, b.g, opts);
  const roots: string[] = [];
  const pass = <T extends Obj>(xs: T[], ys: T[], key: (o: T) => unknown, label: (o: T) => string, stop: (root: T) => (o: Obj) => boolean) => {
    const byKey = new Map(ys.map((y) => [key(y), y]));
    for (const x of xs) {
      const y = byKey.get(key(x));
      if (!y) continue;
      d.setStop(stop(x));
      const l = label(x);
      roots.push(l);
      d.visit(x, y, l, 0);
    }
  };
  pass(a.teams(), b.teams(), (t) => t.teamID, (t) => String(t.name), (t) => (o) => (isTeam(o) && o !== t) || isPerson(o) || isChampionship(o));
  pass(a.people(), b.people(), (p) => p.id, (p) => `Person ${String(p.name ?? p.id)}`, (p) => (o) => isTeam(o) || (isPerson(o) && o !== p) || isChampionship(o));
  const champs = (s: Save) => s.g.list<Obj>(s.data.championshipManager?.mEntities ?? []).filter(Boolean);
  pass(champs(a), champs(b), (c) => c.championshipID, (c) => `Championship ${a.championshipName(c)}`, (c) => (o) => isTeam(o) || isPerson(o) || (isChampionship(o) && o !== c));
  d.setStop(undefined);
  roots.push("save");
  d.visit(a.data, b.data, "save", 0);
  return { entries: d.out, truncated: d.full(), roots };
}

/**
 * Split a diff path into tree levels: "Garuda.carManager.partInventory[0].name" →
 * ["Garuda", "carManager", "partInventory[0]", "name"]. A team name can contain dots
 * ("Scuderia Toro Rosso F.1"), so the first level is given separately when known.
 */
export function pathSegments(path: string, firstLevels: string[] = []): string[] {
  const head = firstLevels.find((f) => path === f || path.startsWith(f + ".") || path.startsWith(f + "["));
  const rest = head ? path.slice(head.length) : path;
  const parts = rest.split(".").filter(Boolean);
  if (!head) return parts;
  if (rest.startsWith("[")) return [head + parts[0], ...parts.slice(1)];
  return [head, ...parts];
}
