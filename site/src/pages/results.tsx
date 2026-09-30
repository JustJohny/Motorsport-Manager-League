import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { fmtDate, fmtTime } from "@/lib/format"
import { useLeague } from "@/lib/league"
import type { SessionResult } from "@/lib/types"
import { cn } from "@/lib/utils"

export function ResultsPage() {
  const { me, league } = useLeague()
  const ch = league.snapshot.championship
  const next = ch.calendar.find((e) => !e.ended)
  const race = ch.lastRace
  // The extract's qualifying rows carry no position or time yet, so order them by grid slot.
  const qualifying = [...(race?.qualifying ?? [])].sort((a, b) => a.grid - b.grid)

  return (
    <>
      <PageHeader title="Calendar & results" description={ch.name} />
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card size="sm" className="self-start">
          <CardHeader>
            <CardTitle>Calendar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col">
            {ch.calendar.map((e) => (
              <div
                key={e.round}
                className={cn(
                  "flex items-center gap-3 rounded-md px-2 py-1.5 text-sm",
                  e === next && "bg-primary/10",
                  e.ended && "text-muted-foreground",
                )}
              >
                <span className="w-5 text-right tabular-nums">{e.round}</span>
                <span className="flex-1 font-medium">{e.circuit}</span>
                <span className="text-xs">{fmtDate(e.date)}</span>
                {e === next && <Badge>Next</Badge>}
              </div>
            ))}
          </CardContent>
        </Card>

        {race ? (
          <Card size="sm">
            <CardHeader>
              <CardTitle>Round {race.round} · {race.circuit}</CardTitle>
              <CardDescription>{fmtDate(race.date)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="race">
                <TabsList>
                  <TabsTrigger value="race">Race</TabsTrigger>
                  <TabsTrigger value="qualifying">Grid</TabsTrigger>
                </TabsList>
                <TabsContent value="race">
                  <ResultTable rows={race.race} myTeam={me.team} kind="race" />
                </TabsContent>
                <TabsContent value="qualifying">
                  <ResultTable rows={qualifying} myTeam={me.team} kind="grid" />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        ) : (
          <Card size="sm"><CardContent className="text-sm text-muted-foreground">No race has been run yet.</CardContent></Card>
        )}
      </div>
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
