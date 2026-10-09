import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Supabase's safeupdate extension refuses UPDATE and DELETE without a WHERE clause in API calls
// ("UPDATE requires a WHERE clause"). PGlite doesn't have it, so check the functions' text: the
// latest definition of each function, as the migrations leave it.
describe("database functions and safeupdate", () => {
  it("every UPDATE and DELETE in a function has a WHERE clause", () => {
    const dir = join(import.meta.dirname, "..", "supabase", "migrations");
    const functions = new Map<string, { file: string; body: string }>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(join(dir, file), "utf8");
      for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi)) {
        functions.set(m[1].toLowerCase(), { file, body: m[3] });
      }
    }
    const bad: string[] = [];
    for (const [name, { file, body }] of functions) {
      const code = body.replace(/--.*$/gm, "");
      for (const s of code.matchAll(/\b(?:update|delete\s+from)\s+[\w.]+[^;]*;/gi)) {
        // "on conflict ... do update set" is part of an insert.
        if (/\bwhere\b/i.test(s[0]) || /do\s*$/i.test(code.slice(0, s.index))) continue;
        bad.push(`${name} (${file}): ${s[0].split(/\s+/).join(" ").slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
