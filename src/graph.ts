import { randomUUID } from "node:crypto";
import type { Json } from "./codec/sav.ts";

// FullSerializer object graph: the first occurrence of an object carries "$id"; later
// occurrences are {"$ref": id}. Lists that are referenced are wrapped as {"$id", "$content": [...]}.

export type Obj = Record<string, Json>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(JSON as any).isRawJSON(v);

export class Graph {
  readonly byId = new Map<string, Obj>();
  private nextId = 0;
  /** Called for each object definition copied by clone(), with the original it came from. */
  onClone?: (original: Obj, copy: Obj) => void;

  constructor(readonly root: Obj) {
    this.reindex();
  }

  reindex(): void {
    this.byId.clear();
    let max = 0;
    walk(this.root, (o) => {
      const id = o.$id;
      if (typeof id === "string") {
        this.byId.set(id, o);
        const n = Number(id);
        if (n > max) max = n;
      }
    });
    this.nextId = max + 1;
  }

  /** Resolve a {"$ref"} to its target object; other values pass through. */
  deref<T = Obj>(v: Json): T {
    if (isObj(v) && typeof v.$ref === "string") {
      const t = this.byId.get(v.$ref);
      if (!t) throw new Error(`Dangling $ref ${v.$ref}`);
      return t as T;
    }
    return v as T;
  }

  /** Items of a list that may be wrapped as {"$content": [...]}, each dereferenced. */
  list<T = Obj>(v: Json): T[] {
    const l = this.deref(v);
    if (l == null) return [];
    const arr = Array.isArray(l) ? l : (l as Obj).$content;
    if (!Array.isArray(arr)) throw new Error("Not a list");
    return arr.map((x) => this.deref<T>(x));
  }

  /** The raw array behind a (possibly wrapped) list, for in-place edits. */
  rawList(v: Json): Json[] {
    const l = this.deref(v);
    const arr = Array.isArray(l) ? l : (l as Obj)?.$content;
    if (!Array.isArray(arr)) throw new Error("Not a list");
    return arr;
  }

  /**
   * A reference to `o`. FullSerializer only gives objects an "$id" when something else points
   * at them, so an object referenced for the first time gets a fresh id here.
   */
  ref(o: Obj): Obj {
    if (typeof o.$ref === "string") return { $ref: o.$ref };
    if (typeof o.$id !== "string") {
      o.$id = this.allocId(); // appended last, after "$version"/"$type", like FullSerializer
      this.byId.set(o.$id, o);
    }
    return { $ref: o.$id };
  }

  idOf(v: Json): string | undefined {
    if (!isObj(v)) return undefined;
    return (v.$ref ?? v.$id) as string | undefined;
  }

  same(a: Json, b: Json): boolean {
    const x = this.idOf(a);
    return x !== undefined && x === this.idOf(b);
  }

  allocId(): string {
    return String(this.nextId++);
  }

  /**
   * Deep-clone an object subtree. Every "$id" inside the subtree is renumbered, internal
   * "$ref"s are remapped to the new ids, and refs to objects outside the subtree are kept.
   * Objects that were defined inside the subtree but referenced from outside stay with
   * the original. GUID "id" fields on cloned entities are regenerated.
   */
  clone(src: Obj): Obj {
    const remap = new Map<string, string>();
    const copies: [string, Obj][] = [];
    const plainCopies: [Obj, Obj][] = [];
    walk(src, (o) => {
      if (typeof o.$id === "string") remap.set(o.$id, this.allocId());
    });
    const copy = (v: Json): Json => {
      if (Array.isArray(v)) return v.map(copy);
      if (!isObj(v)) return v;
      const out: Obj = {};
      if (typeof v.$id === "string") copies.push([v.$id, out]);
      else plainCopies.push([v, out]);
      for (const k in v) {
        const x = v[k];
        if (k === "$id") out[k] = remap.get(x);
        else if (k === "$ref") out[k] = remap.get(x) ?? x;
        else if (k === "id" && typeof x === "string" && GUID_RE.test(x)) out[k] = randomUUID();
        else out[k] = copy(x);
      }
      return out;
    };
    const result = copy(src) as Obj;
    for (const [oldId, c] of copies) {
      const original = this.byId.get(oldId);
      if (original) this.onClone?.(original, c);
    }
    for (const [original, c] of plainCopies) this.onClone?.(original, c);
    walk(result, (o) => { if (typeof o.$id === "string") this.byId.set(o.$id, o); });
    return result;
  }

  /**
   * FullSerializer can only resolve a $ref to an object it has already read, so every object
   * must be fully written at its first position in document order. After edits have moved
   * references around, this pulls each definition forward to its first occurrence and turns
   * the old location into a $ref (the same layout the game itself would write).
   */
  normalizeRefOrder(): number {
    const defined = new Set<string>();
    let moved = 0;
    const stack: [Json, string | number][] = [[{ r: this.root }, "r"]];
    while (stack.length) {
      const [parent, key] = stack.pop()!;
      let v = parent[key];
      if (isObj(v)) {
        if (typeof v.$ref === "string") {
          if (defined.has(v.$ref)) continue;
          const target = this.byId.get(v.$ref);
          if (!target) throw new Error(`Dangling $ref ${v.$ref}`);
          parent[key] = v = target;
          moved++;
        } else if (typeof v.$id === "string" && defined.has(v.$id)) {
          parent[key] = { $ref: v.$id };
          continue;
        }
        if (typeof v.$id === "string") defined.add(v.$id);
        const keys = Object.keys(v);
        for (let i = keys.length - 1; i >= 0; i--) stack.push([v, keys[i]]);
      } else if (Array.isArray(v)) {
        for (let i = v.length - 1; i >= 0; i--) stack.push([v, i]);
      }
    }
    return moved;
  }

  /** Check ids are unique, every $ref resolves, and no $ref comes before its definition. */
  validate(): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();
    const all = new Set<string>();
    walk(this.root, (o) => { if (typeof o.$id === "string") all.add(o.$id); });
    walk(this.root, (o) => {
      if (typeof o.$id === "string") {
        if (seen.has(o.$id)) problems.push(`duplicate $id ${o.$id}`);
        seen.add(o.$id);
      }
      if (typeof o.$ref === "string" && !seen.has(o.$ref)) {
        problems.push(all.has(o.$ref) ? `forward $ref ${o.$ref}` : `dangling $ref ${o.$ref}`);
      }
    });
    return problems;
  }
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Iterative depth-first walk over every object in the tree (saves nest too deep for recursion). */
export function walk(root: Json, visit: (o: Obj) => void): void {
  const stack: Json[] = [root];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (isObj(v)) {
      visit(v);
      const keys = Object.keys(v);
      for (let i = keys.length - 1; i >= 0; i--) stack.push(v[keys[i]]);
    }
  }
}
