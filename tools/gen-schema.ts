// Builds schema/mm-<version>.json from the game's Assembly-CSharp.dll, so the toolkit knows the
// declared type of every serialized field. Needs `monodis` (from Mono).
//   npx tsx tools/gen-schema.ts "<game>/MM_Data/Managed/Assembly-CSharp.dll" schema/mm-1.53.json
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { ClassDef, Schema, TypeRef } from "../src/schema.ts";

const [dll, out] = process.argv.slice(2);
if (!dll || !out) throw new Error("usage: gen-schema <Assembly-CSharp.dll> <out.json>");
const il = execFileSync("monodis", [dll], { maxBuffer: 1 << 30, encoding: "utf8" });

const PRIMS = new Set(["bool", "char", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64",
  "float32", "float64", "string", "object", "native int", "unsigned int8", "unsigned int16", "unsigned int32", "unsigned int64"]);

const MULTIWORD = ["unsigned int8", "unsigned int16", "unsigned int32", "unsigned int64", "native int", "native unsigned int"];

/** Parse an IL type such as `class [mscorlib]System.Collections.Generic.List`1<class Driver>[]`. */
export function parseType(src: string): TypeRef {
  let i = 0;
  const ws = () => { while (src[i] === " ") i++; };
  const type = (): TypeRef => {
    ws();
    for (const kw of ["class ", "valuetype "]) if (src.startsWith(kw, i)) i += kw.length;
    ws();
    let t: TypeRef;
    if (src[i] === "!") {
      i++;
      const m = /^\d+/.exec(src.slice(i))!;
      i += m[0].length;
      t = { g: Number(m[0]) };
    } else if (MULTIWORD.some((w) => src.startsWith(w, i))) {
      const w = MULTIWORD.find((w) => src.startsWith(w, i))!;
      i += w.length;
      t = { p: w };
    } else {
      if (src[i] === "[") i = src.indexOf("]", i) + 1; // assembly qualifier
      if (src[i] === "'") { const e = src.indexOf("'", i + 1); i = e + 1; }
      const m = /^[A-Za-z0-9_.`/<>$@-]*?(?=<|\[|,|>|$| )/.exec(src.slice(i));
      let name = m ? m[0] : "";
      i += name.length;
      name = name.replace(/\//g, "+").replace(/'/g, "");
      if (PRIMS.has(name)) t = { p: name };
      else {
        t = { n: name };
        if (src[i] === "<") {
          i++;
          const args: TypeRef[] = [];
          for (;;) {
            args.push(type());
            ws();
            if (src[i] === ",") { i++; continue; }
            if (src[i] === ">") { i++; break; }
            throw new Error(`bad generic args in ${src}`);
          }
          t.a = args;
        }
      }
    }
    while (src.startsWith("[]", i)) { i += 2; t = { arr: t }; }
    return t;
  };
  return type();
}

const classes: Record<string, ClassDef> = {};
const stack: ({ kind: "ns" | "class" | "other"; name: string })[] = [];
const lines = il.split("\n");
let pending: { kind: "ns" | "class"; name: string } | null = null;
let current: ClassDef | null = null;

const fullName = (name: string) => {
  const outer = [...stack].reverse().find((s) => s.kind === "class");
  if (outer) return `${outer.name}+${name}`;
  const ns = stack.filter((s) => s.kind === "ns").map((s) => s.name).join(".");
  return ns ? `${ns}.${name}` : name;
};

for (let ln = 0; ln < lines.length; ln++) {
  const line = lines[ln].trim();
  if (line.startsWith(".namespace ")) {
    pending = { kind: "ns", name: line.slice(11).trim() };
  } else if (line.startsWith(".class ")) {
    // e.g. ".class public auto ansi abstract beforefieldinit PersonManager`1<(class Person) T>"
    let decl = line.replace(/<\(.*?\)\s*/g, "<").replace(/<([^<>]*)>$/, "");
    const name = decl.split(/\s+/).pop()!.replace(/'/g, "");
    const full = fullName(name);
    const def: ClassDef = { fields: {} };
    const next = lines[ln + 1]?.trim() ?? "";
    if (next.startsWith("extends ")) {
      const base = parseType(next.slice(8));
      if (!("n" in base) || base.n !== "System.Object") def.base = base;
    }
    classes[full] = def;
    current = def;
    pending = { kind: "class", name: full };
  }
  // The opening brace is usually on its own line, but follows "implements …" on the same line.
  if (line === "{" || (/^(implements|extends|\.class|\.namespace)\b/.test(line) && line.endsWith("{"))) {
    stack.push(pending ?? { kind: "other", name: "" });
    pending = null;
  } else if (line === "}" || line.startsWith("} //")) {
    const popped = stack.pop();
    if (popped?.kind === "class") {
      const outer = [...stack].reverse().find((s) => s.kind === "class");
      current = outer ? classes[outer.name] : null;
    }
  } else if (line.startsWith(".field ") && current && stack.at(-1)?.kind === "class") {
    if (/\b(static|notserialized|literal)\b/.test(line)) continue;
    const body = line.replace(/^\.field\s+/, "").replace(/\b(public|private|family|assembly|famorassem|famandassem|initonly|specialname|rtspecialname)\b/g, "").trim();
    const name = body.split(/\s+/).pop()!.replace(/'/g, "");
    const typeStr = body.slice(0, body.length - name.length).trim().replace(/'$/, "").trim();
    current.fields[name] = parseType(typeStr);
  }
}

const schema: Schema = { root: "Game", classes };
writeFileSync(out, JSON.stringify(schema));
console.log(`${Object.keys(classes).length} classes -> ${out}`);
