import { CalendarClock, ChevronDown, ChevronRight, CircleAlert, Dices, History, Minus, Sprout, TrendingDown, TrendingUp } from "lucide-react"
import { useEffect, useState } from "react"
import { raceForRoll, raceRewards, traitDisplayName, traitLength, TRAINED_TOTAL_MAX, type SeriesKind } from "../../../src/development.ts"
import { FF20_POTENTIAL_TRAITS } from "../../../src/ff20-potential-traits.ts"
import { Badge } from "@/components/ui/badge"
import { ageAt, fmtDate, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { demoMode, supabase } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { Person } from "@/lib/types"

const SERIES: Record<number, SeriesKind> = { 0: "single", 1: "gt", 2: "endurance", 4: "endurance" }
const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(Math.round(v * 10) / 10)}`

/** FF20's room to grow: "+5.5 to grow" or "Not growing". */
export function GrowthBadge({ person, className }: { person: Person; className?: string }) {
  const g = person.growth
  if (!g) return null
  return g.room > 0
    ? <Badge variant="outline" className={cn("gap-1 text-emerald-600 dark:text-emerald-400", className)}><Sprout className="size-3" /> +{Math.round(g.room * 10) / 10} to grow</Badge>
    : <Badge variant="outline" className={cn("gap-1 text-muted-foreground", className)}><Minus className="size-3" /> Not growing</Badge>
}

/** Outside the series' age window: MM's AI won't hire (or renew) them there. */
export function AgeWindowBadge({ person }: { person: Person }) {
  const { league } = useLeague()
  const w = league.snapshot.championship.ageWindow
  if (!w || person.kind !== "Driver") return null
  const age = ageAt(person.dateOfBirth, league.snapshot.gameDate)
  if (age >= w.min && age <= w.max) return null
  return (
    <Badge variant="outline" className="gap-1 text-amber-600 dark:text-amber-400" title={`MM's AI only hires and renews drivers aged ${w.min}–${w.max} in this series.`}>
      <CircleAlert className="size-3" /> {age < w.min ? `Under ${w.min}` : `Over ${w.max}: AI won't renew`}
    </Badge>
  )
}

/**
 * FF20 driver development for one driver: what their room to grow came from, what MM's next trait
 * roll could bring for the next race result, and how their stats moved between publishes.
 */
export function DriverDevelopment({ person }: { person: Person }) {
  const { league } = useLeague()
  const [open, setOpen] = useState(false)
  const g = person.growth
  if (!g) return null
  const ch = league.snapshot.championship
  const age = ageAt(person.dateOfBirth, league.snapshot.gameDate)
  const bands = raceRewards(FF20_POTENTIAL_TRAITS, {
    // FF20 only rewards drivers on a team: for a free agent, what they'd earn once signed.
    age, room: g.room, employed: true, series: SERIES[ch.series ?? 0] ?? "single", order: ch.order ?? 0,
  })
  const rollRace = g.nextRoll ? raceForRoll(ch.calendar, g.nextRoll) : null
  const Toggle = open ? ChevronDown : ChevronRight

  return (
    <div className="mt-2 flex flex-col gap-2 border-t pt-2">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-left text-xs font-medium">
        <Toggle className="size-3.5" /> Development
        <span className="font-normal text-muted-foreground">· stats {Math.round(g.total)} of {TRAINED_TOTAL_MAX}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 text-xs">
          <p className="text-muted-foreground">
            In FIRE Fantasy 20 a driver only improves while they have room to grow, and every point gained uses it up. Room comes from
            traits: mostly race results, by age, plus academies, titles and contracts.
          </p>

          <section className="flex flex-col gap-1">
            <h5 className="flex items-center gap-1.5 font-medium"><Sprout className="size-3.5 text-muted-foreground" /> Room to grow: {g.room > 0 ? `+${Math.round(g.room * 10) / 10}` : "none"}</h5>
            {g.traits.length ? g.traits.map((t, i) => (
              <div key={i} className="flex items-center justify-between gap-2">
                <span>{t.name} <span className="text-muted-foreground">· {t.permanent ? "permanent" : t.until ? `until ${fmtDate(t.until)}` : "temporary"}</span></span>
                <span className={cn("tabular-nums", t.value < 0 ? "text-red-500" : "text-emerald-500")}>{signed(t.value)}</span>
              </div>
            )) : <span className="text-muted-foreground">No trait is adding potential right now.</span>}
          </section>

          <section className="flex flex-col gap-1">
            <h5 className="flex items-center gap-1.5 font-medium"><Dices className="size-3.5 text-muted-foreground" /> What a race result can bring (age {age}{person.contract.team ? "" : ", once signed"})</h5>
            <p className="text-muted-foreground">
              MM tries to give each driver a new trait every few months, one at a time. If that roll falls in the week after a race, the result
              decides the reward, with these odds.
              {g.nextRoll && <> Next roll: <b className="text-foreground">{fmtDate(g.nextRoll)}</b>{rollRace ? <>, the week after <b className="text-foreground">{rollRace.circuit}</b>: that race counts.</> : ", not right after a race."}</>}
            </p>
            <table className="w-full">
              <tbody>
                {bands.map((b) => (
                  <tr key={b.trait} className="border-b last:border-0">
                    <td className="py-1 pr-2 align-top whitespace-nowrap text-muted-foreground">{b.label}</td>
                    <td className="py-1 text-right">
                      {b.rewards.length
                        ? b.rewards.map((r) => (
                          <div key={r.id}>
                            <span className={cn("tabular-nums", r.potential < 0 ? "text-red-500" : "text-emerald-500")}>{signed(r.potential)}</span>{" "}
                            {traitDisplayName(r.name)} <span className="text-muted-foreground">· {Math.round(r.chance * 100)} % · {traitLength(r)}</span>
                          </div>
                        ))
                        : <span className="text-muted-foreground">nothing</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <Trend person={person} />
        </div>
      )}
    </div>
  )
}

interface HistoryRow { snapshot_id: number; game_date: string; round: number | null; team: string | null; stats: Record<string, number | null> }

/** Stats at every publish (public.person_history), as total over time and the change per skill. */
function Trend({ person }: { person: Person }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  useEffect(() => {
    if (demoMode) return
    let live = true
    // Before migration 023 the function doesn't exist: no trend.
    void supabase!.rpc("person_history", { guid: person.guid }).then(({ data }) => { if (live) setRows((data ?? []) as HistoryRow[]) })
    return () => { live = false }
  }, [person.guid])
  const total = (s: Record<string, number | null>) => Object.values(s).reduce<number>((a, v) => a + (v ?? 0), 0)
  const points = (rows ?? []).filter((r) => r.stats)
  return (
    <section className="flex flex-col gap-1">
      <h5 className="flex items-center gap-1.5 font-medium"><History className="size-3.5 text-muted-foreground" /> Since the first publish</h5>
      {points.length < 2 ? (
        <span className="text-muted-foreground">{demoMode ? "Shown on the live site." : rows === null ? "Loading…" : "Shows once they've been in two publishes."}</span>
      ) : (
        <TrendBody points={points} total={total} />
      )}
    </section>
  )
}

function TrendBody({ points, total }: { points: HistoryRow[]; total: (s: Record<string, number | null>) => number }) {
  const first = points[0], last = points.at(-1)!
  const totals = points.map((p) => total(p.stats))
  const lo = Math.min(...totals), hi = Math.max(...totals)
  const w = 160, h = 32
  const path = totals.map((v, i) => `${i ? "L" : "M"}${(i / (totals.length - 1)) * w},${hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h}`).join(" ")
  const change = totals.at(-1)! - totals[0]
  const Icon = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus
  const deltas = Object.keys(last.stats).map((k) => ({ k, d: (last.stats[k] ?? 0) - (first.stats[k] ?? 0) })).filter((x) => Math.abs(x.d) >= 0.05)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <svg width={w} height={h} className="overflow-visible text-primary" aria-hidden><path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>
        <span className={cn("flex items-center gap-1 tabular-nums", change > 0 ? "text-emerald-500" : change < 0 ? "text-red-500" : "text-muted-foreground")}>
          <Icon className="size-3.5" /> {signed(change)} total
        </span>
      </div>
      <span className="flex items-center gap-1 text-muted-foreground"><CalendarClock className="size-3" /> {fmtDate(first.game_date)} → {fmtDate(last.game_date)} · {points.length} publishes</span>
      {deltas.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
          {deltas.map(({ k, d }) => <span key={k}>{humanize(k)} <span className={d > 0 ? "text-emerald-500" : "text-red-500"}>{signed(d)}</span></span>)}
        </div>
      )}
    </div>
  )
}
