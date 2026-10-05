/**
 * Livery colour maths without Node imports, for the site. MM's livery textures are colour keys
 * (black = primary, red = secondary, green = tertiary, blue = trim); its shader blends the team's
 * colours by channel, in that order.
 */
import type { TeamColours } from "./league-types.ts";

export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

/** Tint RGBA pixels of a colour-key mask in place. */
export function tintMask(pixels: Uint8ClampedArray, c: TeamColours) {
  const [p, s, t, tr] = [c.primary, c.secondary, c.tertiary, c.trim].map(hexRgb)
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255
    for (let k = 0; k < 3; k++) {
      let v = p[k] * (1 - r) + s[k] * r
      v = v * (1 - g) + t[k] * g
      v = v * (1 - b) + tr[k] * b
      pixels[i + k] = v
    }
  }
}

/** Perceived distance between two colours ("redmean"), 0..~765. Below ~100 they read as the same colour on track. */
export function colourDistance(a: string, b: string): number {
  const [r1, g1, b1] = hexRgb(a), [r2, g2, b2] = hexRgb(b)
  const rm = (r1 + r2) / 2
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db)
}

export const CLASH_DISTANCE = 100
