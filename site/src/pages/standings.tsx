import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { useLeague } from "@/lib/league"
import { cn } from "@/lib/utils"

export function StandingsPage() {
  const { me, league } = useLeague()
  const { championship: ch, teams } = league.snapshot
  const memberOf = new Map(teams.filter((t) => t.member).map((t) => [t.name, t.member!]))
  const rowClass = (team: string | null) => cn(team === me.team && "bg-primary/10 hover:bg-primary/15")
  const member = (team: string | null) =>
    team && memberOf.has(team) ? <Badge variant={team === me.team ? "default" : "secondary"}>{memberOf.get(team)}</Badge> : null

  return (
    <>
      <PageHeader title="Standings" description={`${ch.name} · after ${ch.lastRace?.round ?? 0} of ${ch.calendar.length} rounds`} />
      <Tabs defaultValue="drivers">
        <TabsList>
          <TabsTrigger value="drivers">Drivers</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
        </TabsList>
        <TabsContent value="drivers">
          <Card size="sm">
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Driver</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead className="text-right">Wins</TableHead>
                    <TableHead className="text-right">Podiums</TableHead>
                    <TableHead className="text-right">DNFs</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ch.standings.drivers.map((d) => (
                    <TableRow key={d.guid} className={rowClass(d.team)}>
                      <TableCell className="tabular-nums text-muted-foreground">{d.position}</TableCell>
                      <TableCell className="font-medium">{d.name}</TableCell>
                      <TableCell>
                        <span className="mr-2">{d.team ?? "—"}</span>
                        {member(d.team)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{d.wins}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.podiums}</TableCell>
                      <TableCell className="text-right tabular-nums">{d.dnfs}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{d.points}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="teams">
          <Card size="sm">
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead className="text-right">Wins</TableHead>
                    <TableHead className="text-right">Podiums</TableHead>
                    <TableHead className="text-right">DNFs</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ch.standings.teams.map((t) => (
                    <TableRow key={t.teamID} className={rowClass(t.name)}>
                      <TableCell className="tabular-nums text-muted-foreground">{t.position}</TableCell>
                      <TableCell className="font-medium">
                        <span className="mr-2">{t.name}</span>
                        {member(t.name)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{t.wins}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.podiums}</TableCell>
                      <TableCell className="text-right tabular-nums">{t.dnfs}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{t.points}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  )
}
