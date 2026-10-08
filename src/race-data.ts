import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RaceData, RaceDataPrivate, RaceDriverLaps, RaceResultRow } from "./league-types.ts";

/**
 * FIRE Fantasy 20's race data export (FF20_DataManagement.FF20_DataManager.SaveAllData): when the
 * race results screen shows, the game writes pipe-separated CSVs ("SEP=|", then a header row) to
 * MM_Data/StreamingAssets/FireFantasy20/<baseFolderName>/<location>_<yyyyMMdd>_<timestamp>/ (with
 * oneFolderPerRace = true in its config.txt):
 *   RaceResults/RaceData_<ts>.csv      one row per car (RaceEventResults.ResultData's fields)
 *   LapSectorData/LapData_<ts>_<driver>.csv   one row per lap and sector
 *   DriverStats/DriverData_<ts>.csv    every driver's stats after the race
 * Only the race is exported (no practice or qualifying). See docs/save-schema.md, "Race data export".
 *
 * The league shows lap, gap, tyre and incident data to everyone; tyre wear and temperature, fuel,
 * setup quality, form and stamina only to the driver's own team (and the organizer).
 */

const EXPORT_ROOT = ["StreamingAssets", "FireFantasy20"];

function readTable(path: string): Record<string, string>[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.length && !/^SEP=/i.test(l));
  const [header, ...rows] = lines.map((l) => l.split("|"));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

/** FF20's config.txt: key = value per line. */
function exportConfig(root: string): Record<string, string> {
  const path = join(root, "config.txt");
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/)
    .map((l) => l.split("=")).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
}

/**
 * The export folder for a race: <location>_<yyyyMMdd>_<timestamp> under the configured base folder.
 * A race restarted and finished again leaves several; the newest wins.
 */
export function findRaceExport(dataDir: string, location: string, date: string): string | null {
  const root = join(dataDir, ...EXPORT_ROOT);
  const base = join(root, exportConfig(root).baseFolderName || "Data");
  if (!existsSync(base)) return null;
  const prefix = `${location}_${date.slice(0, 10).replace(/-/g, "")}_`;
  const hits = readdirSync(base).filter((d) => d.startsWith(prefix) && statSync(join(base, d)).isDirectory()).sort();
  return hits.length ? join(base, hits.at(-1)!) : null;
}

const num = (v: string | undefined) => (v === undefined || v === "" || v === "NA" ? null : Number(v));
const r3 = (v: number | null) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const bool = (v: string | undefined) => v === "True";

function files(dir: string, sub: string, pattern: RegExp): string[] {
  const d = join(dir, sub);
  return existsSync(d) ? readdirSync(d).filter((f) => pattern.test(f)).sort().map((f) => join(d, f)) : [];
}

/** Public lap fields, per sector row. */
const PUBLIC_LAP = ["gapToLeader", "gapToCarAhead", "topSpeed", "sectorTime", "standingPos", "overtakesDelta", "runWides", "cutCorners", "lockUps", "trackWater", "trackRubber"] as const;
/** Team-only lap fields. */
const PRIVATE_LAP = ["tyreWear", "tyreTemp", "fuel", "setupQuality", "form", "stamina"] as const;

/** Read one race's export into the site's public data and each team's private part. */
export function readRaceExport(dir: string): { data: RaceData; privateByTeam: Record<string, RaceDataPrivate> } {
  const [resultsFile] = files(dir, "RaceResults", /^RaceData_.*\.csv$/);
  if (!resultsFile) throw new Error(`No RaceResults in ${dir}`);
  const results: RaceResultRow[] = readTable(resultsFile).map((r) => ({
    position: num(r.position)!,
    driver: r.driver,
    team: r.team,
    grid: num(r.gridPosition),
    time: r3(num(r.time)),
    gapToLeader: r3(num(r.gapToLeader)),
    lapsToLeader: num(r.lapsToLeader) ?? 0,
    laps: num(r.laps) ?? 0,
    bestLap: r3(num(r.bestLapTime)),
    fastestLap: bool(r.sessionFastestLap),
    stops: num(r.stops) ?? 0,
    points: num(r.points) ?? 0,
    tyre: r.tyreCompound,
    state: r.carState || "None",
    penalties: r.penalties || "",
  })).sort((a, b) => a.position - b.position);
  const teamOf = new Map(results.map((r) => [r.driver, r.team]));

  const laps: RaceDriverLaps[] = [];
  const privateByTeam: Record<string, RaceDataPrivate> = {};
  for (const f of files(dir, "LapSectorData", /^LapData_.*\.csv$/)) {
    const rows = readTable(f);
    // LapData_<timestamp>_<driver name>.csv
    const driver = f.replace(/^.*LapData_\d+_/, "").replace(/\.csv$/, "");
    const team = teamOf.get(driver) ?? "";
    const pub: RaceDriverLaps = {
      driver, team,
      lap: rows.map((r) => num(r.lapNum)!), sector: rows.map((r) => num(r.sectorNum)!),
      compound: rows.map((r) => r.compounds), flag: rows.map((r) => r.flag),
      values: Object.fromEntries(PUBLIC_LAP.map((k) => [k, rows.map((r) => r3(num(r[k])))])),
    };
    laps.push(pub);
    (privateByTeam[team] ??= { drivers: [] }).drivers.push({
      driver, values: Object.fromEntries(PRIVATE_LAP.map((k) => [k, rows.map((r) => r3(num(r[k])))])),
    });
  }

  const [statsFile] = files(dir, "DriverStats", /^DriverData_.*\.csv$/);
  const driverStats = statsFile ? readTable(statsFile).map((r) => ({
    driver: r.name,
    stats: Object.fromEntries(Object.entries(r).filter(([k]) => k !== "name").map(([k, v]) => [k, num(v)])),
  })) : [];

  return { data: { folder: dir.split(/[\\/]/).pop()!, results, laps, driverStats }, privateByTeam };
}
