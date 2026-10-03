import { Info, Loader2, Lock } from "lucide-react"
import { HQ_INFO, hqName } from "../../../src/hq-info.ts"
import { daysBetween } from "../../../src/part-improvement.ts"
import { SUPPLIER_STATS } from "../../../src/supplier-rules.ts"
import { useState } from "react"
import { Link, useParams } from "react-router"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PageHeader } from "@/components/page-header"
import { PartsTab } from "@/components/parts-tab"
import { PitCrewTab } from "@/components/pit-crew-tab"
import { SponsorsTab } from "@/components/sponsors-tab"
import { PersonCard } from "@/components/person-card"
import { fmtDate, fmtMoney, fmtMoneyShort, fmtPct } from "@/lib/format"
import { useHqOrders } from "@/lib/hq"
import { useParts } from "@/lib/parts"
import { usePitCrew } from "@/lib/pit-crew"
import { useSponsors } from "@/lib/sponsors"
import { nextHqStep, unorderedProject } from "@/lib/rules"
import { useTransfers } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import { useLeague } from "@/lib/league"
import type { Building, TeamPrivate } from "@/lib/types"
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Stat label="Budget" value={priv ? fmtMoneyShort(priv.budget) : "Private"} hint={priv ? fmtMoney(priv.budget) : undefined} />
        <Stat label="Championship" value={standing ? `P${standing.position}` : "—"} hint={standing ? `${standing.points} pts` : undefined} />
        <Stat label="Wins · podiums" value={standing ? `${standing.wins} · ${standing.podiums}` : "—"} hint={standing ? `${standing.dnfs} DNFs` : undefined} />
        <Stat label="HQ buildings" value={priv ? String(built) : "Private"} hint={priv ? `of ${priv.hq.length}` : undefined} />
        <Stat label="Engine" value={team.engine?.name ?? "—"} hint={team.engine ? engineHint(team.engine.stats) : undefined} />
      </div>

      <Tabs defaultValue="staff">
        <TabsList>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="hq">HQ</TabsTrigger>
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="crew">Pit crew</TabsTrigger>
          <TabsTrigger value="sponsors">Sponsors</TabsTrigger>
        </TabsList>
        <TabsContent value="staff" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {people.map((s) => <PersonCard key={s.slotID} person={s.person!} role={s.job} gameDate={league.snapshot.gameDate} />)}
        </TabsContent>
        <TabsContent value="hq">{priv ? <HqTable hq={priv.hq} own={name === me.team} team={name} /> : <PrivateNote />}</TabsContent>
        <TabsContent value="parts">{priv ? <PartsTab priv={priv} team={name} own={name === me.team} /> : <PrivateNote />}</TabsContent>
        <TabsContent value="crew">{priv ? <PitCrewTab priv={priv} team={name} own={name === me.team} /> : <PrivateNote />}</TabsContent>
        <TabsContent value="sponsors"><SponsorsTab team={name} priv={priv} own={name === me.team} /></TabsContent>
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

/** The supplier's stats as MM's car screen lists them (only those it has). */
function engineHint(stats: Record<number, number>) {
  return Object.entries(stats).filter(([, v]) => v)
    .map(([k, v]) => `${SUPPLIER_STATS[Number(k)] ?? `Stat ${k}`} ${v > 0 ? "+" : "−"}${Math.abs(v)}`).join(" · ") || "No stat bonuses"
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

/** Game time left on a construction, in weeks as MM's HQ screen counts build time. */
function weeksLeft(now: string, end: string) {
  const days = Math.max(0, daysBetween(now, end))
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} left`
  const weeks = Math.ceil(days / 7)
  return `${weeks} week${weeks === 1 ? "" : "s"} left`
}

/** An info icon that shows what the building does, in MM's own words. */
function BuildingInfo({ type }: { type: number }) {
  const info = HQ_INFO[type]
  if (!info) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`What the ${info.name} does`}>
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex-col items-start gap-1.5 py-2 font-normal">
        <span className="font-medium">{info.name}</span>
        <span>{info.description}</span>
        <ul className="list-disc pl-4">
          {info.effects.map((e) => <li key={e}>{e}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

/** Level as the member owns it: a building under construction isn't usable yet. */
const ownedLevel = (b: Building) => (b.state === "BuildingInProgress" ? 0 : b.level)

function HqTable({ hq, own, team }: { hq: TeamPrivate["hq"]; own: boolean; team: string }) {
  const { me, league } = useLeague()
  const t = useTransfers()
  const h = useHqOrders()
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const byType = new Map(hq.map((b) => [b.type, b]))
  const queued = new Map(h.orders.filter((o) => o.team === me.team).map((o) => [o.building_type, o]))
  const appliedHere = h.applied.filter((o) => o.team === team)
  const budget = league.privateTeams[me.team]?.budget ?? 0
  const hqCommitted = h.committed(me.team)
  const designCommitted = useParts().committed(me.team)
  const crewCommitted = usePitCrew().committed(me.team)
  const sponsorCommitted = useSponsors().committed(me.team)
  const available = budget - hqCommitted - designCommitted - crewCommitted - sponsorCommitted - t.committed
  const speed = Number(t.settings.hq_speed ?? 1)
  const days = (weeks: number) => weeks * 7 * speed
  // Races are about four weeks apart.
  const races = (weeks: number) => Math.max(1, Math.round(days(weeks) / 28))
  const run = async (key: number, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <div className="flex flex-col gap-3">
      {own && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-sm tabular-nums">
          <span><span className="text-muted-foreground">Budget </span>{fmtMoneyShort(budget)}</span>
          <span><span className="text-muted-foreground">Queued HQ orders </span>−{fmtMoneyShort(hqCommitted)}</span>
          {designCommitted > 0 && <span><span className="text-muted-foreground">Queued design </span>−{fmtMoneyShort(designCommitted)}</span>}
          {crewCommitted > 0 && <span><span className="text-muted-foreground">Crew costs </span>−{fmtMoneyShort(crewCommitted)}</span>}
          {sponsorCommitted > 0 && <span><span className="text-muted-foreground">Sponsor pay-backs </span>−{fmtMoneyShort(sponsorCommitted)}</span>}
          {t.committed > 0 && <span><span className="text-muted-foreground">Leading bids </span>−{fmtMoneyShort(t.committed)}</span>}
          <span className="font-medium"><span className="text-muted-foreground">Available </span>{fmtMoneyShort(available)}</span>
          <span className="text-xs text-muted-foreground">Orders are paid and started in game before the next race; building takes MM's own time.</span>
        </div>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
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
                {own && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {hq.map((b) => {
                const level = ownedLevel(b)
                const aiProject = unorderedProject(b, appliedHere, h.leagueStart)
                const step = nextHqStep(b, aiProject)
                const order = queued.get(b.type)
                const missing = b.dependencies.filter((d) => {
                  const req = byType.get(d.buildingType)
                  return !req || ownedLevel(req) < d.requiredLevel
                })
                const inProgress = b.state === "BuildingInProgress" || b.state === "Upgrading"
                return (
                  <TableRow key={b.type} className={cn(order && "bg-primary/10 hover:bg-primary/15")}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-1.5">{hqName(b.type, b.name)}<BuildingInfo type={b.type} /></span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={b.state === "Constructed" ? "secondary" : b.state === "NotBuilt" ? "outline" : "default"}>
                        {STATE_LABEL[b.state]}
                        {inProgress && b.progress != null && ` ${fmtPct(b.progress)}`}
                      </Badge>
                      {inProgress && !aiProject && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          done {fmtDate(b.progressEnd)}{b.progressEnd && ` · ${weeksLeft(league.snapshot.gameDate, b.progressEnd)}`}
                        </div>
                      )}
                      {aiProject && (
                        <div className="mt-0.5 text-xs text-amber-600 dark:text-amber-400" title="The in-game AI started this with the team's money. It's cancelled and refunded before the next race.">
                          AI project · cancelled at next apply
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{level} / {b.maxLevel}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {!step ? <span className="text-muted-foreground">{level >= b.maxLevel ? "Max" : "—"}</span> : (
                        <>
                          {level === 0 ? "Build " : "Upgrade "}{fmtMoneyShort(step.cost)}
                          <div className="text-xs text-muted-foreground">{Math.round(step.weeks * speed)} weeks · ≈{races(step.weeks)} race{races(step.weeks) > 1 ? "s" : ""}</div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {b.dependencies.map((d) => {
                        const req = byType.get(d.buildingType)
                        const met = !missing.includes(d)
                        return (
                          <span key={d.buildingType} className={met ? "text-muted-foreground" : "text-destructive"}>
                            {hqName(d.buildingType, req?.name)} {d.requiredLevel}
                            <br />
                          </span>
                        )
                      })}
                    </TableCell>
                    {own && (
                      <TableCell className="text-right">
                        {order ? (
                          <div className="flex items-center justify-end gap-2">
                            <Badge>Queued</Badge>
                            <Button size="sm" variant="ghost" disabled={busy === b.type} onClick={() => void run(b.type, () => h.cancel(order.id))}>Cancel</Button>
                          </div>
                        ) : step && !missing.length ? (
                          <Button size="sm" variant={step.cost > available ? "outline" : "default"} disabled={busy === b.type || step.cost > available}
                            title={step.cost > available ? "Not enough available budget" : undefined}
                            onClick={() => void run(b.type, () => h.order(b.type))}>
                            {busy === b.type && <Loader2 className="animate-spin" />} Order
                          </Button>
                        ) : null}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
