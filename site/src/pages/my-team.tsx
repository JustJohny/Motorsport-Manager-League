import { Lock } from "lucide-react"
import { Link, useParams } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { PersonCard } from "@/components/person-card"
import { fmtMoney, fmtMoneyShort, fmtNum, fmtPct, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import type { Building, Part, TeamPrivate } from "@/lib/types"
import { useNavigate } from "react-router"

export function MyTeamPage() {
  const { me, league } = useLeague()
  const navigate = useNavigate()
  const name = useParams().name ?? me.team
  const team = league.snapshot.teams.find((t) => t.name === name)
  const priv = league.privateTeams[name]
  if (!team) return <PageHeader title="Team not found" description={<Link to="/" className="underline">Back to my team</Link>} />

  const ch = league.snapshot.championship
  const standing = ch.standings.teams.find((t) => t.teamID === team.teamID)
  const people = team.staff.filter((s) => s.person)
  const built = priv?.hq.filter((b) => b.level > 0 && b.state !== "BuildingInProgress").length

  return (
    <>
      <PageHeader
        title={team.name}
        description={team.member ? <>Managed by <b>{team.member}</b>{team.isPlayerTeam && " · organizer's career team in game"}</> : "AI team"}
        actions={
          me.role === "organizer" && (
            <Select value={name} onValueChange={(v) => navigate(v === me.team ? "/" : `/team/${encodeURIComponent(v)}`)}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                {league.snapshot.teams.map((t) => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Budget" value={priv ? fmtMoneyShort(priv.budget) : "Private"} hint={priv ? fmtMoney(priv.budget) : undefined} />
        <Stat label="Championship" value={standing ? `P${standing.position}` : "—"} hint={standing ? `${standing.points} pts` : undefined} />
        <Stat label="Wins · podiums" value={standing ? `${standing.wins} · ${standing.podiums}` : "—"} hint={standing ? `${standing.dnfs} DNFs` : undefined} />
        <Stat label="HQ buildings" value={priv ? String(built) : "Private"} hint={priv ? `of ${priv.hq.length}` : undefined} />
      </div>

      <Tabs defaultValue="staff">
        <TabsList>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="hq">HQ</TabsTrigger>
          <TabsTrigger value="parts">Parts</TabsTrigger>
        </TabsList>
        <TabsContent value="staff" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {people.map((s) => <PersonCard key={s.slotID} person={s.person!} role={s.job} gameDate={league.snapshot.gameDate} />)}
        </TabsContent>
        <TabsContent value="hq">{priv ? <HqTable hq={priv.hq} /> : <PrivateNote />}</TabsContent>
        <TabsContent value="parts">{priv ? <Parts parts={priv.parts} /> : <PrivateNote />}</TabsContent>
      </Tabs>
    </>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        {hint && <CardDescription className="text-xs tabular-nums">{hint}</CardDescription>}
      </CardHeader>
    </Card>
  )
}

function PrivateNote() {
  return (
    <Alert>
      <Lock />
      <AlertTitle>Private</AlertTitle>
      <AlertDescription>Like in the game, only the team's manager sees its HQ, parts and budget.</AlertDescription>
    </Alert>
  )
}

const STATE_LABEL: Record<Building["state"], string> = {
  NotBuilt: "Not built", BuildingInProgress: "Under construction", Constructed: "Built", Upgrading: "Upgrading",
}

/** Level as the member owns it: a building under construction isn't usable yet. */
const ownedLevel = (b: Building) => (b.state === "BuildingInProgress" ? 0 : b.level)

function HqTable({ hq }: { hq: TeamPrivate["hq"] }) {
  const byType = new Map(hq.map((b) => [b.type, b]))
  return (
    <Card size="sm">
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Building</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Level</TableHead>
              <TableHead className="text-right">Next step</TableHead>
              <TableHead>Requires</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hq.map((b) => {
              const level = ownedLevel(b)
              const next = level === 0 ? b.initialCost : level < b.maxLevel ? b.upgradeCosts[level - 1] : null
              return (
                <TableRow key={b.type}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell>
                    <Badge variant={b.state === "Constructed" ? "secondary" : b.state === "NotBuilt" ? "outline" : "default"}>
                      {STATE_LABEL[b.state]}
                      {(b.state === "BuildingInProgress" || b.state === "Upgrading") && b.progress != null && ` ${fmtPct(b.progress)}`}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{level} / {b.maxLevel}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {level >= b.maxLevel ? <span className="text-muted-foreground">Max</span> : <>{level === 0 ? "Build " : "Upgrade "}{fmtMoneyShort(next)}</>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {b.dependencies.map((d) => {
                      const req = byType.get(d.buildingType)
                      const met = req ? ownedLevel(req) >= d.requiredLevel : false
                      return (
                        <span key={d.buildingType} className={met ? "text-muted-foreground" : "text-destructive"}>
                          {req?.name ?? `#${d.buildingType}`} {d.requiredLevel}
                          <br />
                        </span>
                      )
                    })}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Parts({ parts }: { parts: TeamPrivate["parts"] }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {Object.entries(parts).map(([type, list]) => <PartCard key={type} type={type} parts={list} />)}
    </div>
  )
}

function PartCard({ type, parts }: { type: string; parts: Part[] }) {
  const sorted = [...parts].sort((a, b) => (a.fittedToCar ?? 9) - (b.fittedToCar ?? 9) || (b.stat ?? 0) - (a.stat ?? 0))
  const best = Math.max(...parts.map((p) => p.stat ?? 0))
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{humanize(type)}</CardTitle>
        <CardDescription>{parts.length} in inventory · best {fmtNum(best)}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead className="text-right">Level</TableHead>
              <TableHead className="text-right">Stat</TableHead>
              <TableHead className="text-right">Reliability</TableHead>
              <TableHead className="text-right">Condition</TableHead>
              <TableHead className="text-right">Car</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((p) => (
              <TableRow key={p.guid}>
                <TableCell className="font-mono text-xs">{p.name}</TableCell>
                <TableCell className="text-right tabular-nums">{p.level}</TableCell>
                <TableCell className={`text-right tabular-nums ${p.stat === best ? "font-semibold text-primary" : ""}`}>{fmtNum(p.stat)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtPct(p.reliability)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtPct(p.condition)}</TableCell>
                <TableCell className="text-right">
                  {p.fittedToCar != null ? <Badge>Car {p.fittedToCar + 1}</Badge> : <span className="text-xs text-muted-foreground">Storage</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
