import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lz4Compress, lz4Decompress } from "../src/codec/lz4.ts";
import { pack, parseLossless, stringifyLossless, unpack, num, float } from "../src/codec/sav.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { Graph, type Obj } from "../src/graph.ts";
import { Types, detectGameCode, loadSchema } from "../src/schema.ts";

describe("lz4", () => {
  it("round-trips repetitive and random data", () => {
    const rep = new TextEncoder().encode('{"a":1.0,"b":[1,2,3]}'.repeat(5000));
    const rnd = new Uint8Array(70000).map(() => Math.floor(Math.random() * 256));
    for (const src of [rep, rnd, new Uint8Array(0), new Uint8Array([1, 2, 3])]) {
      expect(lz4Decompress(lz4Compress(src), src.length)).toEqual(src);
    }
  });
});

describe("lossless json", () => {
  it("keeps FullSerializer number and string formatting", () => {
    const text = '{"f":1.0,"e":1E-05,"i":3,"n":[NaN,Infinity,-Infinity],"s":"Andr\\u00e9 \\"x\\"","André":0.5}';
    const v = parseLossless(text);
    expect(stringifyLossless(v)).toBe(text);
    expect(num(v.f)).toBe(1);
    expect(Number.isNaN(num(v.n[0]))).toBe(true);
    expect(stringifyLossless({ a: float(2), b: float(2.5) })).toBe('{"a":2.0,"b":2.5}');
  });
});

const dir = process.env.MM_SAVES ?? defaultSavesDir();
const saves = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".sav")) : [];

describe.skipIf(saves.length === 0)("real saves", () => {
  it.each(saves)("%s round-trips byte-identically", (f) => {
    const raw = unpack(readFileSync(join(dir, f)));
    const header = stringifyLossless(parseLossless(raw.headerText));
    const data = stringifyLossless(parseLossless(raw.dataText));
    expect(header === raw.headerText).toBe(true);
    expect(data === raw.dataText).toBe(true);
    const again = unpack(pack({ version: raw.version, headerText: header, dataText: data }));
    expect(again.dataText === raw.dataText).toBe(true);

    // The game schema must type every object, and an untouched save needs no extra "$type".
    const tree = parseLossless(raw.dataText);
    const types = new Types(loadSchema(detectGameCode(new Graph(tree as Obj).list((tree as Obj).teamManager?.mEntities))));
    types.record(tree);
    expect(types.annotate(tree)).toEqual({ added: [], unknown: 0 });
  }, 60_000);
});
