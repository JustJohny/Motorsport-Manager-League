import { ChevronRight, Flame, Siren, Timer } from "lucide-react"
import { useSearchParams } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { fmtDate, fmtMoney, fmtTime } from "@/lib/format"
import { useLeague } from "@/lib/league"
import type { PitStopRound, SessionResult } from "@/lib/types"
import { cn } from "@/lib/utils"

export function ResultsPage() {
  const { me, league } = useLeague()
  const ch = league.snapshot.championship
  const next = ch.calendar.find((e) => !e.ended)
  // Snapshots published before every round's results were added only have the latest race.
  const races = ch.races ?? (ch.lastRace ? [ch.lastRace] : [])
  const [params, setParams] = useSearchParams()
  const race = races.find((r) => r.round === Number(params.get("round"))) ?? races.at(-1) ?? null
  const show = (round: number) => setParams(round === races.at(-1)?.round ? {} : { round: String(round) }, { replace: true })
  // The extract's qualifying rows carry no position or time yet, so order them by grid slot.
  const qualifying = [...(race?.qualifying ?? [])].sort((a, b) => a.grid - b.grid)
  const breaches = ch.rulesBreaches ?? []

  return (
    <>
      <PageHeader title="Calendar & results" description={ch.name} />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card size="sm" className="self-start">
          <CardHeader>
            <CardTitle>Calendar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col">
            {ch.calendar.map((e) => {
              const hasResults = races.some((r) => r.round === e.round)
              const selected = race?.round === e.round
              return (
                <button
                  key={e.round}
                  type="button"
                  disabled={!hasResults}
                  onClick={() => show(e.round)}
                  aria-current={selected ? "true" : undefined}
                  title={hasResults ? `Results of round ${e.round}` : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm",
                    hasResults && "cursor-pointer transition-colors hover:bg-muted",
                    e === next && "bg-primary/10",
                    e.ended && !selected && "text-muted-foreground",
                    selected && "bg-muted font-medium text-foreground ring-1 ring-border",
                  )}
                >
                  <span className="w-5 text-right tabular-nums">{e.round}</span>
                  <span className="flex-1 font-medium">{e.circuit}</span>
                  <span className="text-xs">{fmtDate(e.date)}</span>
                  {breaches.some((b) => b.round === e.round) && <Siren className="size-3.5 text-destructive" aria-label="A part was caught" />}
                  {e === next && <Badge>Next</Badge>}
                  {hasResults && <ChevronRight className={cn("size-3.5", selected ? "text-foreground" : "text-muted-foreground/50")} />}
                </button>
              )
            })}
          </CardContent>
        </Card>

        {race ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle>Round {race.round} · {race.circuit}</CardTitle>
              <CardDescription>
                {fmtDate(race.date)}{race.round === races.at(-1)?.round ? " · latest race" : ""}
                {races.length < ch.calendar.filter((e) => e.ended).length && " · earlier rounds appear after the organizer's next publish"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="race">
                <TabsList>
                  <TabsTrigger value="race">Race</TabsTrigger>
                  <TabsTrigger value="qualifying">Grid</TabsTrigger>
                  <TabsTrigger value="pits">Pit stops</TabsTrigger>
                </TabsList>
                <TabsContent value="race">
                  <ResultTable rows={race.race} myTeam={me.team} kind="race" />
                </TabsContent>
                <TabsContent value="qualifying">
                  <ResultTable rows={qualifying} myTeam={me.team} kind="grid" />
                </TabsContent>
                <TabsContent value="pits">
                  <PitStopTable round={race.round} rounds={ch.pitStops} myTeam={me.team} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        ) : (
          <Card size="sm"><CardContent className="text-sm text-muted-foreground">No race has been run yet.</CardContent></Card>
        )}
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Siren className="size-4" /> Stewards' decisions</CardTitle>
          <CardDescription>
            Parts caught by MM's scrutineers after the race this season. A caught car drops 2 places per offence that season
            in the race result, and the team is fined $100K per offence.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {breaches.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Round</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead className="text-right">Places lost</TableHead>
                  <TableHead className="text-right">Fine</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {breaches.map((b, i) => (
                  <TableRow key={i} className={cn(b.team === me.team && "bg-destructive/10")}>
                    <TableCell>{b.round} · {b.circuit}</TableCell>
                    <TableCell className="font-medium">{b.team}</TableCell>
                    <TableCell>{b.driver}</TableCell>
                    <TableCell className="text-right tabular-nums">−{b.placesLost}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoney(b.fine)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : <p className="text-sm text-muted-foreground">No parts caught this season.</p>}
        </CardContent>
      </Card>
    </>
  )
}

function ResultTable({ rows, myTeam, kind }: { rows: SessionResult[]; myTeam: string; kind: "race" | "grid" }) {
  const winner = rows[0]?.time ?? 0
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">{kind === "race" ? "Pos" : "Grid"}</TableHead>
          <TableHead>Driver</TableHead>
          <TableHead>Team</TableHead>
          {kind === "race" && (
            <>
              <TableHead className="text-right">Grid</TableHead>
              <TableHead className="text-right">Stops</TableHead>
              <TableHead className="text-right">Time</TableHead>
              <TableHead className="text-right">Best lap</TableHead>
              <TableHead className="text-right">Pts</TableHead>
            </>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={r.driverGuid} className={cn(r.team === myTeam && "bg-primary/10 hover:bg-primary/15")}>
            <TableCell className="tabular-nums text-muted-foreground">{kind === "race" ? r.position : r.grid}</TableCell>
            <TableCell className="font-medium">{r.driver}</TableCell>
            <TableCell>{r.team ?? "—"}</TableCell>
            {kind === "race" && (
              <>
                <TableCell className="text-right tabular-nums">{r.grid}</TableCell>
                <TableCell className="text-right tabular-nums">{r.stops}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.carState !== 0 ? <Badge variant="destructive">DNF</Badge> : i === 0 ? fmtTime(r.time) : r.laps < rows[0].laps ? `+${rows[0].laps - r.laps} lap${rows[0].laps - r.laps > 1 ? "s" : ""}` : `+${((r.time ?? 0) - winner).toFixed(3)}`}
                </TableCell>
                <TableCell className="text-right tabular-nums">{fmtTime(r.bestLap)}</TableCell>
                <TableCell className="text-right font-semibold tabular-nums">{r.points || ""}</TableCell>
              </>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** MM's pit stop log for a round: every team's fastest and average stop, and its mistakes. */
function PitStopTable({ round, rounds, myTeam }: { round: number; rounds?: PitStopRound[]; myTeam: string }) {
  if (!rounds) return <p className="py-2 text-sm text-muted-foreground">Pit stop times appear after the organizer's next publish.</p>
  const rows = rounds.find((r) => r.round === round)?.teams ?? []
  const best = rounds.flatMap((r) => r.teams.map((t) => ({ ...t, round: r.round }))).sort((a, b) => a.fastest - b.fastest)[0]
  if (!rows.length) return <p className="py-2 text-sm text-muted-foreground">No pit stops were made in this race.</p>
  return (
    <div className="flex flex-col gap-2">
      {best && (
        <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
          <Timer className="size-3.5" /> Season's fastest stop: <strong className="font-medium text-foreground">{best.fastest.toFixed(2)} s</strong> by {best.team} (round {best.round})
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Team</TableHead>
            <TableHead className="text-right">Fastest</TableHead>
            <TableHead className="text-right">Average</TableHead>
            <TableHead className="text-right">Stops</TableHead>
            <TableHead className="text-right">Mistakes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={r.team} className={cn(r.team === myTeam && "bg-primary/10")}>
              <TableCell className="tabular-nums">{i + 1}</TableCell>
              <TableCell className="font-medium">{r.team}</TableCell>
              <TableCell className="text-right tabular-nums">{r.fastest.toFixed(2)} s</TableCell>
              <TableCell className="text-right tabular-nums">{r.average.toFixed(2)} s</TableCell>
              <TableCell className="text-right tabular-nums">{r.stops}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.mistakes || "—"}
                {r.fire && <Flame className="ml-1 inline size-3.5 text-destructive" aria-label="Fire in the pit box" />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
