import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { lz4Compress, lz4Decompress } from "./lz4.ts";

// File layout: "mm2s" | int32 version | int32 headerCompressed | int32 headerRaw
//              | int32 dataCompressed | int32 dataRaw | LZ4(header JSON) | LZ4(data JSON)
const MAGIC = "mm2s";
const PREAMBLE = 24;

export type Json = any;

export interface SaveFile {
  version: number;
  header: Json;
  data: Json;
}

export interface RawSave {
  version: number;
  headerText: string;
  dataText: string;
}

export function unpack(buf: Uint8Array): RawSave {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = new TextDecoder().decode(buf.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`Not an MM save (magic ${JSON.stringify(magic)})`);
  const version = dv.getInt32(4, true);
  const hc = dv.getInt32(8, true), hr = dv.getInt32(12, true);
  const dc = dv.getInt32(16, true), dr = dv.getInt32(20, true);
  if (PREAMBLE + hc + dc !== buf.length) throw new Error("Save length does not match its header");
  const td = new TextDecoder();
  const headerText = td.decode(lz4Decompress(buf.subarray(PREAMBLE, PREAMBLE + hc), hr));
  const dataText = td.decode(lz4Decompress(buf.subarray(PREAMBLE + hc, PREAMBLE + hc + dc), dr));
  return { version, headerText, dataText };
}

export function pack(raw: RawSave): Uint8Array {
  const te = new TextEncoder();
  const h = te.encode(raw.headerText), d = te.encode(raw.dataText);
  const hc = lz4Compress(h), dc = lz4Compress(d);
  const out = new Uint8Array(PREAMBLE + hc.length + dc.length);
  out.set(te.encode(MAGIC), 0);
  const dv = new DataView(out.buffer);
  dv.setInt32(4, raw.version, true);
  dv.setInt32(8, hc.length, true);
  dv.setInt32(12, h.length, true);
  dv.setInt32(16, dc.length, true);
  dv.setInt32(20, d.length, true);
  out.set(hc, PREAMBLE);
  out.set(dc, PREAMBLE + hc.length);
  return out;
}

// --- Lossless JSON -----------------------------------------------------------
// FullSerializer writes floats as e.g. "1.0" or "1E-05". Plain JSON.parse/stringify would turn
// those into "1" / "1e-5". Numbers whose text would change are kept as JSON.rawJSON wrappers.

type RawJson = { rawJSON: string };
const isRaw = (v: unknown): v is RawJson =>
  typeof v === "object" && v !== null && (JSON as any).isRawJSON(v);

// FullSerializer also emits bare NaN / Infinity / -Infinity, which JSON.parse rejects. Outside of
// strings those tokens are swapped for sentinel strings, and swapped back on stringify.
const SENTINEL = "\uE000";
const NON_FINITE = ["-Infinity", "Infinity", "NaN"] as const;

function hideNonFinite(text: string): string {
  let out = "";
  let last = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++; // backslash escape
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) { inString = true; continue; }
    if (c !== 78 && c !== 73 && c !== 45) continue; // 'N' 'I' '-'
    const tok = NON_FINITE.find(t => text.startsWith(t, i));
    if (!tok) continue;
    out += text.slice(last, i) + `"${SENTINEL}${tok}"`;
    i += tok.length - 1;
    last = i + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

export function parseLossless(text: string): Json {
  return (JSON.parse as any)(hideNonFinite(text), (_k: string, v: unknown, ctx: { source?: string }) => {
    if (typeof v === "number" && ctx?.source !== undefined && String(v) !== ctx.source) {
      return (JSON as any).rawJSON(ctx.source);
    }
    return v;
  });
}

// Mirrors FullSerializer's fsJsonPrinter (compressed mode): string values escape every UTF-16
// unit outside printable ASCII as \uXXXX, while object keys are written verbatim.
function escapeString(str: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    let esc: string;
    if (c === 34) esc = '\\"';
    else if (c === 92) esc = "\\\\";
    else if (c >= 32 && c <= 126) continue;
    else if (c === 10) esc = "\\n";
    else if (c === 13) esc = "\\r";
    else if (c === 9) esc = "\\t";
    else if (c === 8) esc = "\\b";
    else if (c === 12) esc = "\\f";
    else esc = "\\u" + c.toString(16).padStart(4, "0");
    out += str.slice(last, i) + esc;
    last = i + 1;
  }
  return last === 0 ? str : out + str.slice(last);
}

export function stringifyLossless(value: Json): string {
  const parts: string[] = [];
  const write = (v: Json): void => {
    if (v === null) { parts.push("null"); return; }
    switch (typeof v) {
      case "number": parts.push(String(v)); return;
      case "boolean": parts.push(v ? "true" : "false"); return;
      case "string":
        if (v.charCodeAt(0) === 0xe000) parts.push(v.slice(1));
        else parts.push('"' + escapeString(v) + '"');
        return;
    }
    if (isRaw(v)) { parts.push(v.rawJSON); return; }
    if (Array.isArray(v)) {
      parts.push("[");
      for (let i = 0; i < v.length; i++) { if (i) parts.push(","); write(v[i]); }
      parts.push("]");
      return;
    }
    parts.push("{");
    let first = true;
    for (const k in v) {
      if (!first) parts.push(",");
      first = false;
      parts.push('"' + k + '":');
      write(v[k]);
    }
    parts.push("}");
  };
  write(value);
  return parts.join("");
}

/** Read a numeric field that may be a raw-JSON wrapper. */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (isRaw(v)) return Number(v.rawJSON);
  if (typeof v === "string" && v.startsWith(SENTINEL)) return Number(v.slice(1));
  throw new Error(`Not a number: ${JSON.stringify(v)}`);
}

/** Produce a float value that serializes C#-style (always with a decimal point). */
export function float(n: number): Json {
  if (!Number.isFinite(n)) throw new Error(`Non-finite float ${n}`);
  const s = String(n);
  return /[.eE]/.test(s) ? n : (JSON as any).rawJSON(s + ".0");
}

export function readSav(path: string): SaveFile {
  const raw = unpack(readFileSync(path));
  return { version: raw.version, header: parseLossless(raw.headerText), data: parseLossless(raw.dataText) };
}

/** Only the header (save name, game date, team), read without touching the much larger data block. */
export function readSavHeader(path: string): Json {
  const fd = openSync(path, "r");
  try {
    const pre = new Uint8Array(PREAMBLE);
    readSync(fd, pre, 0, PREAMBLE, 0);
    if (new TextDecoder().decode(pre.subarray(0, 4)) !== MAGIC) throw new Error("Not an MM save");
    const dv = new DataView(pre.buffer);
    const hc = dv.getInt32(8, true), hr = dv.getInt32(12, true);
    const buf = new Uint8Array(hc);
    readSync(fd, buf, 0, hc, PREAMBLE);
    return parseLossless(new TextDecoder().decode(lz4Decompress(buf, hr)));
  } finally {
    closeSync(fd);
  }
}

export function writeSav(path: string, save: SaveFile): void {
  writeFileSync(path, pack({
    version: save.version,
    headerText: stringifyLossless(save.header),
    dataText: stringifyLossless(save.data),
  }));
}
