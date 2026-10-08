import { useMemo, useState } from "react"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Flag, Gauge, Timer, Zap } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fmtTime } from "@/lib/format"
import { lapsOf, stintsOf, type LapRow } from "@/lib/race-data"
import type { RaceData, RaceDataPrivate } from "@/lib/types"
import { cn } from "@/lib/utils"

// FIRE Fantasy 20's race data export as F1-style race pages (src/race-data.ts, migration 020).

/** Tyre compound colours, like the F1 broadcast's. */
const COMPOUND: Record<string, string> = {
  HyperSoft: "#f5a3c7", UltraSoft: "#b44be1", SuperSoft: "#e10600", Soft: "#f2c200", Medium: "#e5e5e5",
  Hard: "#8ab4f8", Intermediate: "#43b02a", Wet: "#0067ad",
}
const compoundColour = (c: string) => COMPOUND[c] ?? "#9ca3af"
/** "Carlos Sainz Jr." -> "Sainz". */
const surname = (name: string) => name.replace(/\s+(Jr\.?|Sr\.?|II|III)$/i, "").split(" ").at(-1)

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A line colour per driver: the team's primary, or its secondary when the primary is too dark; team-mates dashed. */
function driverStyles(data: RaceData, teamColours: Record<string, { primary: string; secondary: string } | undefined>) {
  const seen = new Map<string, number>()
  return Object.fromEntries(data.results.map((r) => {
    const c = teamColours[r.team]
    const colour = !c ? "#9ca3af" : luminance(c.primary) < 0.12 ? c.secondary : c.primary
    const n = seen.get(r.team) ?? 0
    seen.set(r.team, n + 1)
    return [r.driver, { colour, dash: n ? "5 3" : undefined }]
  }))
}

function gapText(r: RaceData["results"][number], leader: RaceData["results"][number]) {
  if (r.state !== "None" && r.state !== "") return r.state === "Retired" || r.state === "Crashed" ? "DNF" : r.state
  if (r.position === leader.position) return fmtTime(r.time)
  // Moved down the order after the race (MM's scrutineers caught a part): MM's gaps no longer apply.
  if (r.lapsToLeader < 0) return "Penalty"
  if (r.lapsToLeader > 0) return `+${r.lapsToLeader} lap${r.lapsToLeader > 1 ? "s" : ""}`
  return r.gapToLeader != null ? `+${r.gapToLeader.toFixed(3)}s` : "—"
}

export function Classification({ data, myTeam }: { data: RaceData; myTeam: string }) {
  const leader = data.results[0]
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">Pos</TableHead><TableHead>Driver</TableHead><TableHead className="hidden sm:table-cell">Team</TableHead>
          <TableHead className="text-right">Grid</TableHead><TableHead className="text-right">Time / gap</TableHead>
          <TableHead className="text-right">Best lap</TableHead><TableHead className="text-right">Stops</TableHead><TableHead className="text-right">Pts</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.results.map((r) => {
          const gained = r.grid != null ? r.grid - r.position : 0
          return (
            <TableRow key={r.driver} className={cn(r.team === myTeam && "bg-muted/50")}>
              <TableCell className="tabular-nums">{r.position}</TableCell>
              <TableCell className="font-medium">{r.driver}</TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">{r.team}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.grid ?? "—"}
                {gained !== 0 && <span className={cn("ml-1 text-xs", gained > 0 ? "text-emerald-500" : "text-destructive")}>{gained > 0 ? `+${gained}` : gained}</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{gapText(r, leader)}</TableCell>
              <TableCell className={cn("text-right tabular-nums", r.fastestLap && "font-semibold text-purple-500")}>
                {r.fastestLap && <Timer className="mr-1 inline size-3.5" aria-label="Fastest lap" />}{fmtTime(r.bestLap)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.stops}</TableCell>
              <TableCell className="text-right tabular-nums">{r.points || ""}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Driver chips to choose which lines a chart draws. */
function DriverPicker({ drivers, chosen, setChosen, styles }: {
  drivers: string[]; chosen: string[]; setChosen: (d: string[]) => void; styles: Record<string, { colour: string }>
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {drivers.map((d) => {
        const on = chosen.includes(d)
        return (
          <button key={d} type="button" onClick={() => setChosen(on ? chosen.filter((x) => x !== d) : [...chosen, d])}
            className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs", on ? "border-foreground/40 text-foreground" : "text-muted-foreground opacity-60")}>
            <span className="size-2 rounded-full" style={{ background: styles[d]?.colour }} />{surname(d)}
          </button>
        )
      })}
    </div>
  )
}

function useLaps(data: RaceData) {
  return useMemo(() => Object.fromEntries(data.laps.map((d) => [d.driver, lapsOf(d)])), [data])
}

/** Rows keyed by lap with one column per driver, for Recharts. */
function byLap(laps: Record<string, LapRow[]>, drivers: string[], value: (l: LapRow) => number | null) {
  const max = Math.max(0, ...drivers.map((d) => laps[d]?.at(-1)?.lap ?? 0))
  return Array.from({ length: max }, (_, i) => {
    const row: Record<string, number | null> = { lap: i + 1 }
    for (const d of drivers) row[d] = value(laps[d]?.find((l) => l.lap === i + 1) ?? ({} as LapRow)) ?? null
    return row
  })
}

const axis = { stroke: "currentColor", className: "text-xs text-muted-foreground", tickLine: false }

function DriverLines({ rows, drivers, styles, reversed, unit, domain }: {
  rows: Record<string, number | null>[]; drivers: string[]; styles: Record<string, { colour: string; dash?: string }>
  reversed?: boolean; unit?: (v: number) => string; domain?: [number | string, number | string]
}) {
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid strokeOpacity={0.12} />
          <XAxis dataKey="lap" {...axis} />
          <YAxis reversed={reversed} domain={domain ?? ["auto", "auto"]} allowDecimals={!reversed} width={68} tickFormatter={unit} {...axis} />
          <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", fontSize: 12 }}
            labelFormatter={(l) => `Lap ${l}`} formatter={(v: number) => (unit ? unit(v) : v)} />
          {drivers.map((d) => (
            <Line key={d} dataKey={d} dot={false} strokeWidth={1.75} stroke={styles[d]?.colour} strokeDasharray={styles[d]?.dash} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function RaceTrace({ data, styles }: { data: RaceData; styles: Record<string, { colour: string; dash?: string }> }) {
  const laps = useLaps(data)
  const drivers = data.results.map((r) => r.driver)
  const [chosen, setChosen] = useState(drivers.slice(0, 10))
  return (
    <div className="space-y-4">
      <DriverPicker drivers={drivers} chosen={chosen} setChosen={setChosen} styles={styles} />
      <section className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-sm font-medium"><Flag className="size-4" /> Position by lap</h3>
        <DriverLines rows={byLap(laps, chosen, (l) => l.position)} drivers={chosen} styles={styles} reversed domain={[1, drivers.length]} />
      </section>
      <section className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-sm font-medium"><Timer className="size-4" /> Gap to the leader</h3>
        <DriverLines rows={byLap(laps, chosen, (l) => l.gap)} drivers={chosen} styles={styles} reversed unit={(v) => `+${v.toFixed(1)}s`} domain={[0, "auto"]} />
      </section>
    </div>
  )
}

export function LapTimes({ data, styles, myTeam }: { data: RaceData; styles: Record<string, { colour: string; dash?: string }>; myTeam: string }) {
  const laps = useLaps(data)
  const drivers = data.results.map((r) => r.driver)
  const mine = data.results.filter((r) => r.team === myTeam).map((r) => r.driver)
  const [chosen, setChosen] = useState([...new Set([...data.results.slice(0, 3).map((r) => r.driver), ...mine])])
  // Lap 1 (standing start) and laps behind the safety car would flatten the chart: clip at 107 % of the fastest lap.
  const best = Math.min(...data.results.map((r) => r.bestLap ?? Infinity))
  const clip = (l: LapRow) => (l.time != null && l.time <= best * 1.07 ? l.time : null)
  const lastLap = Math.max(...Object.values(laps).map((l) => l.at(-1)?.lap ?? 0))
  return (
    <div className="space-y-4">
      <DriverPicker drivers={drivers} chosen={chosen} setChosen={setChosen} styles={styles} />
      <DriverLines rows={byLap(laps, chosen, clip)} drivers={chosen} styles={styles} unit={(v) => fmtTime(v)} />
      <section className="space-y-2">
        <h3 className="text-sm font-medium">Tyre strategy</h3>
        <div className="space-y-1">
          {data.results.map((r) => (
            <div key={r.driver} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 truncate text-right">{surname(r.driver)}</span>
              <div className="relative h-4 flex-1 rounded bg-muted">
                {stintsOf(laps[r.driver] ?? []).map((s) => (
                  <div key={s.from} title={`${s.compound}: laps ${s.from}–${s.to}`}
                    className="absolute top-0 h-4 rounded border border-background"
                    style={{ left: `${((s.from - 1) / lastLap) * 100}%`, width: `${((s.to - s.from + 1) / lastLap) * 100}%`, background: compoundColour(s.compound) }} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
          {Object.keys(COMPOUND).map((c) => <span key={c} className="flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ background: compoundColour(c) }} />{c}</span>)}
        </div>
      </section>
    </div>
  )
}

export function SectorsSpeed({ data }: { data: RaceData }) {
  const laps = useLaps(data)
  const rows = data.results.map((r) => {
    const l = laps[r.driver] ?? []
    const min = (k: "s1" | "s2" | "s3") => Math.min(...l.map((x) => x[k] ?? Infinity))
    const v = data.laps.find((d) => d.driver === r.driver)?.values ?? {}
    const sum = (k: string) => (v[k] ?? []).reduce<number>((s, x) => s + (x ?? 0), 0)
    const s = { s1: min("s1"), s2: min("s2"), s3: min("s3") }
    return { r, ...s, ideal: s.s1 + s.s2 + s.s3, top: Math.max(0, ...l.map((x) => x.topSpeed ?? 0)), lockUps: sum("lockUps"), runWides: sum("runWides"), cuts: sum("cutCorners") }
  })
  const best = (k: "s1" | "s2" | "s3" | "ideal" | "top") => (k === "top" ? Math.max(...rows.map((x) => x[k])) : Math.min(...rows.map((x) => x[k])))
  const cell = (v: number, k: "s1" | "s2" | "s3" | "ideal") => (
    <TableCell className={cn("text-right tabular-nums", v === best(k) && "font-semibold text-purple-500")}>{Number.isFinite(v) ? (k === "ideal" ? fmtTime(v) : v.toFixed(3)) : "—"}</TableCell>
  )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Driver</TableHead><TableHead className="text-right">S1</TableHead><TableHead className="text-right">S2</TableHead><TableHead className="text-right">S3</TableHead>
          <TableHead className="text-right" title="Best sectors added up">Ideal lap</TableHead>
          <TableHead className="text-right"><Gauge className="inline size-3.5" /> Top speed</TableHead>
          <TableHead className="hidden text-right md:table-cell" title="Lock-ups / run wide / cut corners"><Zap className="inline size-3.5" /> Incidents</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((x) => (
          <TableRow key={x.r.driver}>
            <TableCell className="font-medium">{x.r.driver}</TableCell>
            {cell(x.s1, "s1")}{cell(x.s2, "s2")}{cell(x.s3, "s3")}{cell(x.ideal, "ideal")}
            <TableCell className={cn("text-right tabular-nums", x.top === best("top") && "font-semibold text-purple-500")}>{x.top ? x.top.toFixed(1) : "—"}</TableCell>
            <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">{x.lockUps} / {x.runWides} / {x.cuts}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** The team's own lap data: tyre wear and temperature, fuel, form, stamina and setup per lap. */
export function TeamTelemetry({ data, teams, styles, myTeam }: { data: RaceData; teams: Record<string, RaceDataPrivate>; styles: Record<string, { colour: string; dash?: string }>; myTeam: string }) {
  const names = Object.keys(teams).sort()
  const [team, setTeam] = useState(teams[myTeam] ? myTeam : names[0] ?? "")
  const priv = teams[team]
  if (!priv) return <p className="text-sm text-muted-foreground">Only your own team's tyre, fuel and form data is shown here, and there is none for this race.</p>
  const pubLaps = Object.fromEntries(data.laps.map((d) => [d.driver, d]))
  const drivers = priv.drivers.map((d) => d.driver)
  // One value per lap: the end of sector 3.
  const series = (key: string, scale = 1) => {
    const out: Record<string, number | null>[] = []
    for (const d of priv.drivers) {
      const p = pubLaps[d.driver]
      d.values[key]?.forEach((v, i) => {
        if (!p || p.sector[i] !== 3) return
        const lap = p.lap[i]
        const row = out[lap - 1] ??= { lap }
        row[d.driver] = v == null ? null : v * scale
      })
    }
    return out.filter(Boolean)
  }
  const charts: [string, string, number, (v: number) => string][] = [
    ["Tyre wear (tread left)", "tyreWear", 100, (v) => `${v.toFixed(0)}%`],
    ["Tyre temperature", "tyreTemp", 100, (v) => `${v.toFixed(0)}%`],
    ["Fuel", "fuel", 1, (v) => v.toFixed(1)],
    ["Form", "form", 100, (v) => `${v.toFixed(0)}%`],
  ]
  return (
    <div className="space-y-4">
      {names.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {names.map((n) => <Badge key={n} variant={n === team ? "default" : "outline"} className="cursor-pointer" onClick={() => setTeam(n)}>{n}</Badge>)}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {charts.map(([title, key, scale, unit]) => (
          <section key={key} className="space-y-1">
            <h3 className="text-sm font-medium">{title}</h3>
            <DriverLines rows={series(key, scale)} drivers={drivers} styles={styles} unit={unit} />
          </section>
        ))}
      </div>
    </div>
  )
}

export { driverStyles }
