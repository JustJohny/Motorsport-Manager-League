import {
  ArrowDownToLine, ArrowUpFromLine, Bot, CircleDot, Coins, FileSignature, Fuel, Gauge, HeartPulse, History, Loader2, Lock, PiggyBank,
  RefreshCw, Timer, TrendingDown, TrendingUp, UserMinus, UserPlus, Users, Wrench, type LucideIcon,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import {
  CREW_SETTINGS, FUNDING, isRetiring, pastPeak, perRaceCost, RESERVE, ROLE_NAMES, ROLE_STAT, STAT_NAMES, stars, taskStats,
  type Applicant, type CrewMember,
} from "../../../src/pit-crew.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ageAt, fmtMoney, fmtMoneyShort, fmtNum, fmtPct } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { usePitCrew } from "@/lib/pit-crew"
import { cn } from "@/lib/utils"
import type { GameCrewPerson, TeamPrivate } from "@/lib/types"

/** An icon per position and per skill, as MM's crew screen has. */
const ROLE_ICONS: LucideIcon[] = [ArrowUpFromLine, ArrowDownToLine, CircleDot, CircleDot, CircleDot, CircleDot, Wrench, Wrench, Fuel, Fuel]
const STAT_ICONS: LucideIcon[] = [CircleDot, ArrowUpFromLine, ArrowDownToLine, Wrench, Fuel]
/** Where each position sits around the car in the pit box (3 x 4 grid, car in the middle column). */
const BOX: Record<number, string> = {
  0: "col-start-2 row-start-1", 2: "col-start-1 row-start-2", 3: "col-start-3 row-start-2", 6: "col-start-1 row-start-3", 7: "col-start-3 row-start-3",
  4: "col-start-1 row-start-4", 5: "col-start-3 row-start-4", 8: "col-start-1 row-start-5", 9: "col-start-3 row-start-5", 1: "col-start-2 row-start-5",
}

type Person = Pick<CrewMember, "stats" | "confidence" | "maxConfidence" | "role"> & { name: string; id?: number }

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`

export function PitCrewTab({ priv, team, own }: { priv: TeamPrivate; team: string; own: boolean }) {
  const { league } = useLeague()
  const crew = usePitCrew()
  const rules = league.snapshot.championship.pitCrew
  if (!rules) return <Alert><AlertDescription>The latest publish has no pit crew data yet; it appears after the organizer publishes again.</AlertDescription></Alert>
  if (priv.gameCrew) return <GameCrewView crew={priv.gameCrew} roles={rules.roles} aiLevel={rules.aiLevel} />
  const row = crew.teams.find((t) => t.team === team)
  if (!row) {
    const member = league.snapshot.teams.find((t) => t.name === team)?.member
    return (
      <Alert>
        <Bot />
        <AlertDescription>
          {member
            ? "This team's crew is formed at the organizer's next publish."
            : "An AI team: MM runs its crew, with every task at its mechanics' Pit stops skill (re-rolled confidence each race)."}
        </AlertDescription>
      </Alert>
    )
  }
  return <SiteCrew team={team} own={own} funding={row.funding} roles={rules.roles} aiLevel={rules.aiLevel} size={rules.size} budget={priv.budget ?? 0} />
}

function SiteCrew({ team, own, funding, roles, aiLevel, size, budget }: {
  team: string; own: boolean; funding: number; roles: number[]; aiLevel: number; size: string; budget: number
}) {
  const { league } = useLeague()
  const c = usePitCrew()
  const people = c.crewOf(team)
  const applicants = c.applicantsOf(team)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const date = league.snapshot.gameDate
  const queued = c.committed(team)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-sm tabular-nums">
        <span className="flex items-center gap-1.5"><Users className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Crew</span> {people.length}/{CREW_SETTINGS.maxCrew}</span>
        <span className="flex items-center gap-1.5"><Coins className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Per race</span> {fmtMoneyShort(perRaceCost(people, funding))}</span>
        {queued > 0 && <span><span className="text-muted-foreground">Queued crew costs </span>−{fmtMoneyShort(queued)}</span>}
        {own && <span><span className="text-muted-foreground">Budget </span>{fmtMoneyShort(budget)}</span>}
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Tabs defaultValue="positions">
        <TabsList variant="line" className="h-auto! max-w-full flex-wrap justify-start gap-y-2">
          <TabsTrigger value="positions"><CircleDot /> Positions</TabsTrigger>
          <TabsTrigger value="crew"><FileSignature /> Crew &amp; contracts</TabsTrigger>
          <TabsTrigger value="applicants"><UserPlus /> Applicants <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">{applicants.length}</Badge></TabsTrigger>
          <TabsTrigger value="funding"><PiggyBank /> Funding &amp; log</TabsTrigger>
        </TabsList>

        <TabsContent value="positions" className="flex flex-col gap-4 pt-2">
          <p className="text-sm text-muted-foreground">
            {size === "Large" ? "Large" : size === "SemiSequential" ? "Semi-sequential" : "Small"} crews in this series: {roles.length} positions.
            Each position uses one skill; before every race the toolkit writes your crew into MM's pit stop tasks.
            Your line-up stays until you change it.
          </p>
          <PitBox people={people.map((p) => ({ ...p, name: fullName(p) }))} roles={roles} own={own} busy={busy}
            onAssign={(id, role) => void run(`role${role}`, () => c.setRole(id, role))} />
          <TaskCard people={people} roles={roles} aiLevel={aiLevel} />
        </TabsContent>

        <TabsContent value="crew" className="pt-2">
          <CrewTable people={people} roles={roles} date={date} own={own} busy={busy}
            onRelease={(id) => void run(`rel${id}`, () => c.release(id))} onRenew={(id) => void run(`ren${id}`, () => c.renew(id))} />
        </TabsContent>

        <TabsContent value="applicants" className="pt-2">
          <ApplicantList list={applicants} date={date} own={own} busy={busy} full={people.length >= CREW_SETTINGS.maxCrew}
            onSign={(id) => void run(`sign${id}`, () => c.sign(id))} />
        </TabsContent>

        <TabsContent value="funding" className="flex flex-col gap-4 pt-2">
          <FundingCard funding={funding} people={people} own={own} busy={busy} onSet={(l) => void run("fund", () => c.setFunding(l))} />
          <LogCard team={team} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Positions

function SkillBar({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / CREW_SETTINGS.statMax) * 100))
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full", pct >= 70 ? "bg-primary" : pct >= 45 ? "bg-foreground/70" : "bg-foreground/35")} style={{ width: `${pct}%` }} />
    </div>
  )
}

function PitBox({ people, roles, own, busy, onAssign }: {
  people: Person[]; roles: number[]; own: boolean; busy: string | null; onAssign?: (id: number, role: number) => void
}) {
  return (
    <div className="grid max-w-3xl grid-cols-3 grid-rows-[auto_auto_auto_auto_auto] gap-2 sm:gap-3">
      <div className="col-start-2 row-span-3 row-start-2 flex items-center justify-center py-1">
        <CarTopDown className="h-full max-h-80 w-auto max-w-full" />
      </div>
      {ROLE_NAMES.map((_, role) => {
        const holder = people.find((p) => p.role === role)
        const used = roles.includes(role)
        const Icon = ROLE_ICONS[role]
        const skill = holder ? holder.stats[ROLE_STAT[role]] : 0
        const candidates = [...people].sort((a, b) => b.stats[ROLE_STAT[role]] - a.stats[ROLE_STAT[role]])
        return (
          <div key={role} className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border p-2", BOX[role], !used && "border-dashed opacity-45")}>
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <Icon className="size-3 shrink-0" /> <span className="truncate">{ROLE_NAMES[role]}</span>
            </span>
            {!used ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> Not used here</span>
            ) : own && onAssign && holder?.id != null ? (
              <Select value={String(holder.id)} onValueChange={(v) => onAssign(Number(v), role)} disabled={busy === `role${role}`}>
                <SelectTrigger size="sm" className="h-7 w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {candidates.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span className="tabular-nums">{fmtNum(p.stats[ROLE_STAT[role]])}</span> {p.name}
                      {p.role !== RESERVE && p.id !== holder.id && <span className="text-muted-foreground"> · {ROLE_NAMES[p.role]}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="truncate text-xs font-medium">{holder?.name ?? "Empty"}</span>
            )}
            {used && holder && (
              <>
                <div className="flex items-center gap-1.5 text-xs tabular-nums">
                  <Gauge className="size-3 shrink-0 text-muted-foreground" />
                  <SkillBar value={skill} className="flex-1" />
                  <span>{fmtNum(skill)}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                  <HeartPulse className="size-3 shrink-0" /> {fmtPct(holder.confidence)}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** One side of the car (x <= 100), drawn once and mirrored for the other. */
const CAR_SIDE = [
  // Front wing: main plane, three flaps, endplate and footplate
  "M100 30 Q60 26 12 30 L12 44 Q60 40 100 44",
  "M100 47 Q60 44 14 47", "M100 51 Q60 48 16 51", "M97 55 Q60 52 18 55",
  "M8 22 L14 22 L14 58 L8 58 Z", "M14 52 L24 57",
  // Front suspension: wishbones, track rod, pushrod; brake duct
  "M88 92 L46 98 L89 108", "M88 100 L46 104 L90 118", "M88 113 L46 111", "M47 101 L85 87",
  "M44 90 L49 90 L49 112 L44 112 Z",
  // Bargeboards and turning vane
  "M70 148 Q62 170 64 198", "M76 152 Q70 172 72 198", "M66 136 Q74 140 80 150",
  // Mirror
  "M66 186 Q72 182 78 186 Q72 191 66 186 Z", "M78 187 L84 192",
  // Sidepod: inlet, outline, undercut
  "M83 200 L62 207 Q53 211 52 222 L50 290 Q53 330 78 372",
  "M62 207 L62 226 Q68 231 83 229",
  "M57 234 Q58 292 82 362",
  // Floor edge
  "M44 198 L42 330 Q44 346 52 352",
  // Rear suspension: wishbones, driveshaft
  "M92 368 L48 374 L92 386", "M92 378 L48 383 L94 395", "M90 383 L48 381",
  // Diffuser strakes
  "M80 404 L77 431", "M89 404 L88 431",
  // Rear wing endplate
  "M33 416 L40 416 L40 468 L33 468 Z",
]
/** Tyres (x, y, width, height): fronts, then the wider rears. */
const CAR_TYRES = [[14, 70, 30, 60], [6, 346, 40, 72]] as const

/** A 2016 F1 car from above as line art (no halo, long nose), front at the top, in theme grays. */
function CarTopDown({ className }: { className?: string }) {
  const side = (
    <>
      {CAR_SIDE.map((d, i) => <path key={i} d={d} />)}
      {CAR_TYRES.map(([x, y, w, h]) => (
        <g key={y}>
          <rect x={x} y={y} width={w} height={h} rx={7} className="fill-foreground/5" />
          <rect x={x + 4} y={y + 9} width={w - 8} height={h - 18} rx={4} />
          <path d={`M${x + 3} ${y + 5} L${x + w - 3} ${y + 5} M${x + 3} ${y + h - 5} L${x + w - 3} ${y + h - 5} M${x + w / 2} ${y + h / 2 - 4} L${x + w / 2} ${y + h / 2 + 4}`} />
        </g>
      ))}
    </>
  )
  return (
    <svg viewBox="0 0 200 480" className={cn("fill-none stroke-foreground/65", className)} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round"
      role="img" aria-label="Car from above, front at the top">
      {side}
      <g transform="matrix(-1 0 0 1 200 0)">{side}</g>
      {/* Centre line: nose, chassis, cockpit with the driver's helmet, airbox, engine cover, crash structure, rear wing */}
      <path d="M95 34 Q100 28 105 34 L112 128 Q116 160 118 196 M95 34 L88 128 Q84 160 82 196" />
      <path d="M96 44 L96 60 M104 44 L104 60" />
      <path d="M90 196 Q100 186 110 196 L112 236 Q100 244 88 236 Z" />
      <circle cx={100} cy={213} r={7} />
      <path d="M100 206 L100 220" />
      <path d="M88 240 Q86 300 92 400 L108 400 Q114 300 112 240" />
      <ellipse cx={100} cy={250} rx={7} ry={5} />
      <path d="M100 258 L100 396" />
      <path d="M70 398 L130 398 L134 432 L66 432 Z" />
      <path d="M95 400 L95 436 L105 436 L105 400" />
      <circle cx={100} cy={405} r={2.5} />
      <rect x={40} y={428} width={120} height={13} rx={2} />
      <rect x={40} y={444} width={120} height={8} rx={2} />
      <path d="M58 458 L142 458 M100 441 L100 458" />
    </svg>
  )
}

/** What the crew gives MM's pit stop tasks, next to the field's AI level. */
function TaskCard({ people, roles, aiLevel }: { people: CrewMember[]; roles: number[]; aiLevel: number }) {
  const tasks = taskStats(people, roles)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><Timer className="size-4" /> In the race</CardTitle>
        <CardDescription>What MM's pit stop simulation gets per task (both cars), against the field's average AI crew ({fmtNum(aiLevel)}).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-3">
        {tasks.map((t) => {
          const d = t.stat - aiLevel
          return (
            <div key={t.target} className="flex flex-col gap-1 rounded-md bg-muted/60 px-2.5 py-1.5">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.name}</span>
              <span className="flex items-baseline gap-2 text-sm tabular-nums">
                {fmtNum(t.stat)}
                <span className={cn("text-xs", d >= 0 ? "text-emerald-500" : "text-destructive")}>{d >= 0 ? "+" : "−"}{fmtNum(Math.abs(d))}</span>
                <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground"><HeartPulse className="size-3" /> {fmtPct(t.confidence)}</span>
              </span>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------------------------
// Crew, applicants, funding

function Skills({ stats, active, wrap }: { stats: number[]; active?: number; wrap?: boolean }) {
  return (
    <div className={cn("flex gap-x-2.5 gap-y-1 whitespace-nowrap", wrap ? "flex-wrap" : "flex-nowrap")}>
      {stats.map((v, i) => {
        const Icon = STAT_ICONS[i]
        return (
          <span key={i} title={STAT_NAMES[i]} className={cn("flex items-center gap-1 text-xs tabular-nums", i === active ? "font-semibold text-foreground" : "text-muted-foreground")}>
            <Icon className="size-3" /> {fmtNum(v)}
          </span>
        )
      })}
    </div>
  )
}

function AgeCell({ p, date }: { p: Pick<CrewMember, "birth" | "peak">; date: string }) {
  const declining = pastPeak(p as CrewMember, date)
  return (
    <span className="flex items-center gap-1 tabular-nums" title={declining ? "Past their peak: loses a little skill every race" : `Improving until ${p.peak.slice(0, 4)}`}>
      {ageAt(p.birth, date)}
      {declining ? <TrendingDown className="size-3 text-destructive" /> : <TrendingUp className="size-3 text-emerald-500" />}
    </span>
  )
}

function CrewTable({ people, roles, date, own, busy, onRelease, onRenew }: {
  people: (CrewMember & { id: number })[]; roles: number[]; date: string; own: boolean; busy: string | null
  onRelease: (id: number) => void; onRenew: (id: number) => void
}) {
  const sorted = [...people].sort((a, b) => (roles.includes(a.role) ? a.role : 99) - (roles.includes(b.role) ? b.role : 99) || b.wage - a.wage)
  return (
    <Card size="sm">
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead><TableHead>Position</TableHead><TableHead>Age</TableHead><TableHead>Skills</TableHead>
              <TableHead className="text-right">Confidence</TableHead><TableHead className="text-right">Wage/race</TableHead><TableHead className="text-right">Races left</TableHead>
              {own && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((p) => {
              const retiring = isRetiring(p, date)
              const canRenew = p.racesLeft < CREW_SETTINGS.renewBelow && !retiring
              return (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap font-medium">{fullName(p)}</TableCell>
                  <TableCell className="whitespace-nowrap">{roles.includes(p.role) ? ROLE_NAMES[p.role] : <span className="text-muted-foreground">Reserve</span>}</TableCell>
                  <TableCell><AgeCell p={p} date={date} /></TableCell>
                  <TableCell><Skills stats={p.stats} active={roles.includes(p.role) ? ROLE_STAT[p.role] : undefined} /></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(p.confidence)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoneyShort(p.wage)}</TableCell>
                  <TableCell className="text-right">
                    <span className={cn("tabular-nums", p.racesLeft <= 3 && "text-destructive")}>{p.racesLeft}</span>
                    {retiring && <Badge variant="outline" className="ml-1.5 text-[10px]">Retiring</Badge>}
                  </TableCell>
                  {own && (
                    <TableCell className="whitespace-nowrap text-right">
                      <Button size="xs" variant="ghost" disabled={!canRenew || !!busy} onClick={() => onRenew(p.id)}
                        title={retiring ? "Retiring: won't sign again" : canRenew ? "A new contract at today's wage" : `Renewable with fewer than ${CREW_SETTINGS.renewBelow} races left`}>
                        {busy === `ren${p.id}` ? <Loader2 className="animate-spin" /> : <RefreshCw />} Renew
                      </Button>
                      <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => onRelease(p.id)} title="Free: MM charges nothing to release crew">
                        {busy === `rel${p.id}` ? <Loader2 className="animate-spin" /> : <UserMinus />} Release
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        <p className="mt-2 text-xs text-muted-foreground">
          Contracts count down every race; at 0 the person leaves (at {CREW_SETTINGS.retireAge}+ they retire). A released position goes to the reserve best at it.
        </p>
      </CardContent>
    </Card>
  )
}

function ApplicantList({ list, date, own, busy, full, onSign }: {
  list: (Applicant & { id: number })[]; date: string; own: boolean; busy: string | null; full: boolean; onSign: (id: number) => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        People who applied to your team. Signing costs a {fmtMoney(CREW_SETTINGS.signOnFee)} sign-on fee (charged at the next apply);
        they join as reserves. Applications lapse after {CREW_SETTINGS.applicantRaces} races and new ones arrive after every race.
      </p>
      {full && own && <Alert><AlertDescription>Your crew is full ({CREW_SETTINGS.maxCrew} people). Release someone to sign an applicant.</AlertDescription></Alert>}
      <div className="grid gap-3 md:grid-cols-2">
        {list.map((a) => {
          const best = a.stats.indexOf(Math.max(...a.stats))
          return (
            <div key={a.id} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{fullName(a)}</span>
                <span className="text-xs text-muted-foreground">{a.nationality.replace(/([a-z])([A-Z])/g, "$1 $2")} · {ageAt(a.birth, date)}</span>
                <span className="ml-auto text-xs text-muted-foreground">{a.racesLeft === 1 ? "Lapses after this race" : `${a.racesLeft} races left`}</span>
              </div>
              <Skills stats={a.stats} active={best} wrap />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums text-muted-foreground">
                <span title="Best skill">{stars(a.stats[best]).toFixed(1)} stars at {STAT_NAMES[best].toLowerCase()}</span>
                <span className="flex items-center gap-1"><HeartPulse className="size-3" /> {fmtPct(a.confidence)}</span>
                <span className="flex items-center gap-1"><Coins className="size-3" /> {fmtMoneyShort(a.wage)}/race</span>
                {own && (
                  <Button size="xs" className="ml-auto" disabled={full || !!busy} onClick={() => onSign(a.id)}>
                    {busy === `sign${a.id}` ? <Loader2 className="animate-spin" /> : <UserPlus />} Sign
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function FundingCard({ funding, people, own, busy, onSet }: { funding: number; people: CrewMember[]; own: boolean; busy: string | null; onSet: (l: number) => void }) {
  const wages = people.reduce((s, p) => s + p.wage, 0)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><PiggyBank className="size-4" /> Training funding</CardTitle>
        <CardDescription>Charged every race. Crew in positions gain skill at their job each race; more funding trains faster.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {FUNDING.map((f, i) => (
            <button
              key={f.name} type="button" disabled={!own || !!busy || i === funding} onClick={() => onSet(i)}
              className={cn("flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors enabled:hover:bg-muted/60 disabled:cursor-default",
                i === funding && "border-primary bg-primary/10")}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">{f.name}{i === funding && <Badge className="text-[10px]">Current</Badge>}</span>
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><Coins className="size-3" /> {f.cost ? `${fmtMoneyShort(f.cost)}/race` : "Free"}</span>
              <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><TrendingUp className="size-3" /> +{f.training} skill/race</span>
            </button>
          ))}
        </div>
        <Stat label="Per race" icon={Coins}>{fmtMoney(wages)} wages + {fmtMoney(FUNDING[funding]?.cost ?? 0)} funding</Stat>
      </CardContent>
    </Card>
  )
}

function Stat({ label, icon: Icon, children }: { label: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className="size-4 text-muted-foreground" /><span className="text-muted-foreground">{label}</span> <span className="tabular-nums">{children}</span>
    </div>
  )
}

function LogCard({ team }: { team: string }) {
  const log = usePitCrew().logOf(team)
  return (
    <Card size="sm">
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><History className="size-4" /> Crew log</CardTitle></CardHeader>
      <CardContent>
        {log.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {log.slice(0, 30).map((l) => (
              <li key={l.id} className="flex gap-2"><span className="w-16 shrink-0 text-xs text-muted-foreground">{l.round ? `Round ${l.round}` : "Pre-season"}</span>{l.message}</li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">Nothing yet.</p>}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------------------------------------
// The career team: MM's own crew, read-only

function GameCrewView({ crew, roles, aiLevel }: { crew: NonNullable<TeamPrivate["gameCrew"]>; roles: number[]; aiLevel: number }) {
  const people = crew.members.map((m: GameCrewPerson, i) => ({ ...m, id: i }))
  const asMembers = people.map((p) => ({ ...p, firstName: p.name, lastName: "", nationality: p.nationality ?? "", peak: p.birth, decline: 0 })) as CrewMember[]
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <Lock />
        <AlertDescription>
          The career team's crew is MM's own and is managed in game (positions, hiring, contracts and funding: {FUNDING[crew.funding]?.name ?? "?"}).
          Shown here read-only.
        </AlertDescription>
      </Alert>
      <PitBox people={people} roles={roles} own={false} busy={null} />
      <TaskCard people={asMembers} roles={roles} aiLevel={aiLevel} />
      <Card size="sm">
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow><TableHead>Name</TableHead><TableHead>Position</TableHead><TableHead>Skills</TableHead><TableHead className="text-right">Confidence</TableHead><TableHead className="text-right">Wage/race</TableHead><TableHead className="text-right">Races left</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {people.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="whitespace-nowrap font-medium">{p.name}</TableCell>
                  <TableCell className="whitespace-nowrap">{roles.includes(p.role) ? ROLE_NAMES[p.role] : <span className="text-muted-foreground">Reserve</span>}</TableCell>
                  <TableCell><Skills stats={p.stats} active={roles.includes(p.role) ? ROLE_STAT[p.role] : undefined} /></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(p.confidence)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoneyShort(p.wage)}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.racesLeft}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
