import { stringifyLossless, type Json } from "./codec/sav.ts";
import type { Graph, Obj } from "./graph.ts";

export interface DiffOptions {
  maxDepth?: number;
  limit?: number;
  /** Keys never descended into (large, noisy or purely historical data). */
  skipKeys?: Set<string>;
}

const DEFAULT_SKIP = new Set(["transactionHistory", "mMoraleStatModificationHistory", "careerHistory", "mCalendarEvent", "records", "OnEventTrigger", "OnButtonClick", "mPastEvents"]);

/**
 * Structural diff of the same object in two saves. References are followed (each object once),
 * so ids that differ between saves do not show up as changes.
 */
export function diffObjects(ga: Graph, a: Json, gb: Graph, b: Json, path: string, opts: DiffOptions = {}): string[] {
  const out: string[] = [];
  const maxDepth = opts.maxDepth ?? 6;
  const limit = opts.limit ?? 500;
  const skip = opts.skipKeys ?? DEFAULT_SKIP;
  const seen = new Set<Obj>();
  const leaf = (v: Json) => (v === undefined ? "<missing>" : stringifyLossless(v).slice(0, 120));

  const visit = (x: Json, y: Json, p: string, depth: number) => {
    if (out.length >= limit) return;
    x = ga.deref(x);
    y = gb.deref(y);
    const xo = x !== null && typeof x === "object" && !(JSON as any).isRawJSON(x);
    const yo = y !== null && typeof y === "object" && !(JSON as any).isRawJSON(y);
    if (!xo || !yo) {
      if (leaf(x) !== leaf(y)) out.push(`${p}: ${leaf(x)} -> ${leaf(y)}`);
      return;
    }
    if (seen.has(x)) return;
    seen.add(x);
    if (depth >= maxDepth) return;
    const xa = Array.isArray(x) ? x : x.$content, ya = Array.isArray(y) ? y : y.$content;
    if (Array.isArray(xa) || Array.isArray(ya)) {
      if (!Array.isArray(xa) || !Array.isArray(ya)) { out.push(`${p}: list shape changed`); return; }
      if (xa.length !== ya.length) out.push(`${p}: length ${xa.length} -> ${ya.length}`);
      for (let i = 0; i < Math.min(xa.length, ya.length); i++) visit(xa[i], ya[i], `${p}[${i}]`, depth + 1);
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === "$id" || k === "$ref" || skip.has(k)) continue;
      visit(x[k], y[k], `${p}.${k}`, depth + 1);
    }
  };
  visit(a, b, path, 0);
  return out;
}
