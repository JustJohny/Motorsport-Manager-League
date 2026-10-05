import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * League team colours as an MM database mod. MM keeps only `Team.colorID` in the save and reads
 * the colours from its Team Colours table; a mod's table replaces the whole base table, so the
 * mod file is MM's own rows (schema/team-colours-1.53.csv, extracted from resources.assets)
 * plus one row per member team. See docs/save-schema.md, "Team colours, livery and logos".
 */

/** Colours a member picks, as "#rrggbb". */
export interface TeamLook {
  /** Main colour: car body, UI, staff shirts, helmet. */
  primary: string;
  /** Second livery colour and staff trousers. */
  secondary: string;
  /** Third livery colour and helmet detail. */
  tertiary: string;
  /** Livery pinstripes and edges. */
  trim: string;
  /** Car finish, 0..1. */
  metallic?: number;
  smoothness?: number;
}

export const BASE_TEAM_COLOURS = fileURLToPath(new URL("../schema/team-colours-1.53.csv", import.meta.url));

/**
 * First ID for league rows: MM's own table is 0..128. IDs stay contiguous because
 * `TeamColorManager.OnLoad` uses the player's `colorID` as an array index.
 */
export const LEAGUE_COLOR_ID_START = 129;

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] {
  if (!HEX.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function hex([r, g, b]: number[]): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

/** Blend towards white (amount > 0) or black (amount < 0). */
function shade(c: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  return hex(rgb(c).map((v) => v + (target - v) * Math.abs(amount)));
}

/** Relative luminance, 0 (black) .. 1 (white). */
function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * MM's UI draws team colours on a dark grey background, so a very dark pick is lifted for the
 * UI only; the car keeps the exact colour.
 */
function uiColour(c: string): string {
  return luminance(c) < 0.06 ? shade(c, 0.45) : c;
}

export interface ColourTable {
  header: string[];
  rows: string[][];
}

export function parseColourTable(text: string): ColourTable {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const [header, ...rows] = lines.map((l) => l.split(","));
  return { header, rows };
}

export function loadBaseColourTable(path = BASE_TEAM_COLOURS): ColourTable {
  return parseColourTable(readFileSync(path, "utf8"));
}

/** One table row in MM's column order, following the patterns of MM's own rows. */
export function teamColourRow(table: ColourTable, id: number, look: TeamLook): string[] {
  const { primary, secondary, tertiary, trim } = look;
  for (const c of [primary, secondary, tertiary, trim]) rgb(c);
  const ui = uiColour(primary);
  const ui2 = uiColour(secondary);
  const darkSponsor = luminance(primary) > 0.5 ? shade(primary, -0.85) : "#0d0d0d";
  const lightSponsor = "#ffffff";
  const values: Record<string, string> = {
    "ID": String(id),
    "Staff Primary": primary,
    "Staff Secondary": secondary,
    "Helmet Primary": primary,
    "Helmet Secondary": secondary,
    "Helmet Tertiary": tertiary,
    "Normal UI": ui,
    "Highlighted UI": shade(ui, 0.3),
    "Pressed UI": shade(ui, -0.3),
    "Disabled UI": "#323232",
    "Secondary Normal UI": ui2,
    "Secondary Highlighted UI": shade(ui2, 0.3),
    "Secondary Pressed UI": shade(ui2, -0.3),
    "Secondary Disabled UI": "#323232",
    "Car": primary,
    "Primary": primary,
    "Secondary": secondary,
    "Tertiary": tertiary,
    "Trim": trim,
    "Light Sponsor 1": lightSponsor,
    "Light Sponsor 2": shade(secondary, 0.6),
    "Light Sponsor 3": shade(tertiary, 0.6),
    "Light Sponsor 4": "#8c8c8c",
    "Dark Sponsor 1": darkSponsor,
    "Dark Sponsor 2": shade(primary, -0.7),
    "Dark Sponsor 3": shade(secondary, -0.7),
    "Dark Sponsor 4": "#232323",
    "Metallic": look.metallic === undefined ? "" : String(look.metallic),
    "Smoothness": String(look.smoothness ?? 0.93),
  };
  // The in-game livery editor's swatches: the team's own colours first, then neutrals.
  const swatches = [primary, secondary, tertiary, trim, "#ffffff", "#e5e5e5", "#8c8c8c", "#232323", "#0a0202", shade(primary, -0.5)];
  swatches.forEach((c, i) => (values[`Livery Color ${i + 1}`] = c));
  return table.header.map((col) => {
    if (!(col in values)) throw new Error(`Team Colours column ${col} has no value`);
    return values[col];
  });
}

/**
 * MM's base table plus a row per league team, as the mod file `Databases/Team Colours.txt`.
 * Keeps MM's CRLF line endings.
 */
export function teamColoursMod(looks: { colorID: number; look: TeamLook }[], base = loadBaseColourTable()): string {
  const taken = new Set(base.rows.map((r) => Number(r[0])));
  const rows = base.rows.map((r) => [...r]);
  for (const { colorID, look } of looks) {
    if (taken.has(colorID)) throw new Error(`Colour ID ${colorID} is already used`);
    taken.add(colorID);
    rows.push(teamColourRow(base, colorID, look));
  }
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  const gap = rows.findIndex((r, i) => Number(r[0]) !== i);
  if (gap >= 0) throw new Error(`Colour IDs must run 0..${rows.length - 1} without gaps; row ${gap} has ID ${rows[gap][0]}`);
  return [base.header, ...rows].map((r) => r.join(",")).join("\r\n") + "\r\n";
}
