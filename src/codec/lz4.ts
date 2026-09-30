// Raw LZ4 block format (no frame header), as used by MM's save files.

export function lz4Decompress(src: Uint8Array, rawLength: number): Uint8Array {
  const out = new Uint8Array(rawLength);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >>> 4;
    if (lit === 15) {
      let b: number;
      do { b = src[i++]; lit += b; } while (b === 255);
    }
    out.set(src.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do { b = src[i++]; len += b; } while (b === 255);
    }
    len += 4;
    let s = o - offset;
    if (offset >= len) {
      out.copyWithin(o, s, s + len);
      o += len;
    } else {
      for (let k = 0; k < len; k++) out[o++] = out[s++];
    }
  }
  if (o !== rawLength) throw new Error(`LZ4: expected ${rawLength} bytes, got ${o}`);
  return out;
}

const MIN_MATCH = 4;
const LAST_LITERALS = 5;
const MF_LIMIT = 12;
const HASH_LOG = 16;

function writeLength(dst: number[], n: number) {
  while (n >= 255) { dst.push(255); n -= 255; }
  dst.push(n);
}

/** Greedy single-pass LZ4 block compressor. Output is a valid LZ4 block readable by any LZ4 decoder. */
export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const dst: number[] = [];
  const table = new Int32Array(1 << HASH_LOG).fill(-1);
  const read32 = (p: number) => (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
  const hash = (v: number) => Math.imul(v, 2654435761) >>> (32 - HASH_LOG);

  let anchor = 0;
  let p = 0;
  const matchLimit = n - LAST_LITERALS;
  while (p < n - MF_LIMIT) {
    const v = read32(p);
    const h = hash(v);
    const ref = table[h];
    table[h] = p;
    if (ref < 0 || p - ref > 0xffff || read32(ref) !== v) { p++; continue; }

    let len = MIN_MATCH;
    while (p + len < matchLimit && src[ref + len] === src[p + len]) len++;

    const lit = p - anchor;
    const tokenPos = dst.length;
    dst.push(0);
    let token = (lit >= 15 ? 15 : lit) << 4;
    if (lit >= 15) writeLength(dst, lit - 15);
    for (let k = anchor; k < p; k++) dst.push(src[k]);
    const off = p - ref;
    dst.push(off & 0xff, off >>> 8);
    const ml = len - MIN_MATCH;
    token |= ml >= 15 ? 15 : ml;
    if (ml >= 15) writeLength(dst, ml - 15);
    dst[tokenPos] = token;

    p += len;
    anchor = p;
  }
  const lit = n - anchor;
  dst.push((lit >= 15 ? 15 : lit) << 4);
  if (lit >= 15) writeLength(dst, lit - 15);
  const out = new Uint8Array(dst.length + lit);
  out.set(dst);
  out.set(src.subarray(anchor), dst.length);
  return out;
}
