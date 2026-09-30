import { readFileSync } from "node:fs";
import type { Json } from "./codec/sav.ts";
import type { Obj } from "./graph.ts";

// Declared C# types of every serialized field, generated from the game's assembly by
// tools/gen-schema.ts. FullSerializer only writes "$type" when an object's runtime type
// differs from the declared type where it is written, so moving an object definition to a
// different field can silently change the type the game constructs. This module lets the
// toolkit work out declared types and add "$type" where needed.

export type TypeRef =
  | { p: string }                    // primitive
  | { n: string; a?: TypeRef[] }     // named class/struct, optional generic args
  | { arr: TypeRef }                 // array
  | { g: number };                   // generic parameter of the enclosing class

export interface ClassDef { base?: TypeRef; fields: Record<string, TypeRef> }
export interface Schema { root: string; classes: Record<string, ClassDef> }

export function loadSchema(path = new URL("../schema/mm-1.53.json", import.meta.url)): Schema {
  return JSON.parse(readFileSync(path, "utf8"));
}

const LISTS = /^System\.Collections\.Generic\.(List|HashSet|Queue|Stack|LinkedList|SortedSet)`1$|^System\.Collections\.ObjectModel\.ReadOnlyCollection`1$/;
const DICTS = /^System\.Collections\.Generic\.(Dictionary|SortedDictionary|SortedList)`2$/;

/** Name FullSerializer writes in "$type" for a class type, or null if we can't express it. */
export function typeName(t: TypeRef | null): string | null {
  return t && "n" in t && !t.a ? t.n : null;
}

export class Types {
  /** Runtime type of each object definition, as the game would construct it. */
  readonly runtime = new WeakMap<Obj, TypeRef>();

  constructor(readonly schema: Schema) {}

  private subst(t: TypeRef, args: TypeRef[] | undefined): TypeRef {
    if ("g" in t) return args?.[t.g] ?? t;
    if ("arr" in t) return { arr: this.subst(t.arr, args) };
    if ("n" in t && t.a) return { n: t.n, a: t.a.map((x) => this.subst(x, args)) };
    return t;
  }

  /** Declared type of `field` on class type `t`, searching base classes. */
  fieldType(t: TypeRef, field: string): TypeRef | null {
    let cur: TypeRef | undefined = t;
    for (let guard = 0; cur && "n" in cur && guard < 20; guard++) {
      const def: ClassDef | undefined = this.schema.classes[cur.n];
      if (!def) return null;
      if (field in def.fields) return this.subst(def.fields[field], cur.a);
      cur = def.base ? this.subst(def.base, cur.a) : undefined;
    }
    return null;
  }

  /** Element type if `t` is serialized as a JSON array, plus how dictionaries are laid out. */
  collection(t: TypeRef | null): { elem: TypeRef | null; kv?: [TypeRef, TypeRef]; stringKeys?: boolean } | null {
    if (!t) return null;
    if ("arr" in t) return { elem: t.arr };
    if ("n" in t && t.a) {
      if (LISTS.test(t.n)) return { elem: t.a[0] };
      if (DICTS.test(t.n)) {
        const stringKeys = "p" in t.a[0] && t.a[0].p === "string";
        return { elem: null, kv: [t.a[0], t.a[1]], stringKeys };
      }
    }
    return null;
  }

  /**
   * Walk the tree in document order with declared types. `visit` sees every object
   * definition/value with the declared type of the slot it sits in (null if unknown).
   */
  walk(root: Json, visit: (o: Obj, declared: TypeRef | null) => void): void {
    const stack: [Json, TypeRef | null][] = [[root, { n: this.schema.root }]];
    const isObj = (v: Json) => v !== null && typeof v === "object" && !Array.isArray(v) && !(JSON as any).isRawJSON(v);
    while (stack.length) {
      const [v, declared] = stack.pop()!;
      if (Array.isArray(v)) {
        const c = this.collection(declared);
        const elem = c?.kv ? { n: "System.Collections.Generic.KeyValuePair`2", a: c.kv } as TypeRef : c?.elem ?? null;
        for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], elem]);
        continue;
      }
      if (!isObj(v) || typeof v.$ref === "string") continue;
      visit(v, declared);
      if (Array.isArray(v.$content)) { stack.push([v.$content, declared]); continue; }
      const c = this.collection(declared);
      if (c?.kv && c.stringKeys) {
        const keys = Object.keys(v).filter((k) => !k.startsWith("$"));
        for (let i = keys.length - 1; i >= 0; i--) stack.push([v[keys[i]], c.kv[1]]);
        continue;
      }
      const rt: TypeRef | null = typeof v.$type === "string" ? { n: v.$type } : declared;
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        if (k.startsWith("$")) continue;
        let ft: TypeRef | null = null;
        if (rt && "n" in rt && rt.n === "System.Collections.Generic.KeyValuePair`2" && rt.a) ft = k === "Key" ? rt.a[0] : k === "Value" ? rt.a[1] : null;
        else if (rt) ft = this.fieldType(rt, k);
        stack.push([v[k], ft]);
      }
    }
  }

  /**
   * Record the runtime type of every object in a freshly loaded save, including ones without
   * an "$id" (they get one if an edit starts referencing them).
   */
  record(root: Json): void {
    this.walk(root, (o, declared) => {
      const rt = typeof o.$type === "string" ? { n: o.$type } : declared;
      if (rt) this.runtime.set(o, rt);
    });
  }

  /**
   * After definitions have moved, add "$type" wherever an object's runtime type no longer
   * matches the declared type of the slot it is written in. Returns what was added.
   */
  annotate(root: Json): { added: string[]; unknown: number } {
    const added: string[] = [];
    let unknown = 0;
    this.walk(root, (o, declared) => {
      if (typeof o.$id !== "string" || typeof o.$type === "string") return;
      const rt = this.runtime.get(o);
      if (!rt) { unknown++; return; }
      if (sameType(rt, declared)) return;
      const name = typeName(rt);
      if (!name) { unknown++; return; }
      // Keep FullSerializer's key order: ..., "$version", "$type", "$id".
      const id = o.$id;
      delete o.$id;
      o.$type = name;
      o.$id = id;
      added.push(`${name}#${id}`);
    });
    return { added, unknown };
  }
}

/** Objects the game would construct as a different type than they really are. */
export function typeMismatches(types: Types, root: Json): string[] {
  const out: string[] = [];
  types.walk(root, (o, declared) => {
    if (typeof o.$id !== "string") return;
    const constructed: TypeRef | null = typeof o.$type === "string" ? { n: o.$type } : declared;
    const actual = types.runtime.get(o);
    if (!actual) out.push(`#${o.$id}: unknown runtime type`);
    else if (typeof o.$type === "string" ? typeName(actual) !== o.$type : !sameType(actual, constructed)) {
      out.push(`#${o.$id}: is ${JSON.stringify(actual)}, would load as ${JSON.stringify(constructed)}`);
    }
  });
  return out;
}

export function sameType(a: TypeRef | null, b: TypeRef | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
