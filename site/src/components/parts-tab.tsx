import { Bot, Loader2, Wrench } from "lucide-react"
import { Fragment, useMemo, useState, type ReactNode } from "react"
import { planDesign, type DesignPlan } from "../../../src/part-design.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fmtDate, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, humanize } from "@/lib/format"
import { useHqOrders } from "@/lib/hq"
import { useLeague } from "@/lib/league"
import { effectiveFitting, isAiDesign, isAiPart, useParts } from "@/lib/parts"
import { useTransfers } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import type { DesignComponent, Part, PartDesignOptions, TeamPrivate } from "@/lib/types"

const LEVEL_NAMES = ["Basic", "Good", "Great", "Epic", "Legendary"]

/** MM's component summaries: "<b>Performance:</b> +10\r\n<b>Reliability:</b> -15%". */
function Summary({ text, className }: { text: string; className?: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return (
    <div className={cn("flex flex-col gap-0.5 text-xs leading-snug", className)}>
      {lines.map((line, i) => (
        <span key={i}>
          {line.split(/(<b>.*?<\/b>)/g).map((chunk, j) =>
            chunk.startsWith("<b>") ? <strong key={j} className="font-medium">{chunk.slice(3, -4)}</strong> : <Fragment key={j}>{chunk}</Fragment>)}
        </span>
      ))}
    </div>
  )
}

const componentPrice = (c: DesignComponent, o: PartDesignOptions) =>
  c.cost !== 0 ? c.cost : c.engineer ? 0 : o.ctx.settings.costPerLevel[c.level - 1] ?? 0

const fmtDays = (d: number) => {
  const whole = Math.floor(d), hours = Math.round((d - whole) * 24)
  return `${whole} day${whole === 1 ? "" : "s"}${hours ? ` ${hours} h` : ""}`
}

export function PartsTab({ priv, team, own }: { priv: TeamPrivate; team: string; own: boolean }) {
  const design = priv.design ?? null
  return (
    <div className="flex flex-col gap-4">
      {own && <BudgetStrip budget={priv.budget ?? 0} />}
      {design ? <DesignCard priv={priv} team={team} own={own} /> : (
        <Alert><AlertDescription>The latest publish has no design data yet; it appears after the organizer publishes again.</AlertDescription></Alert>
      )}
      {design && <ImprovementCard priv={priv} team={team} own={own} />}
      {own && <Note>Car buttons choose what each car runs and P / R what the mechanics improve; both are re-applied at every apply. Parts finished in game show up after the organizer's next publish.</Note>}
      <div className="grid gap-3 lg:grid-cols-2">
        {Object.entries(priv.parts).map(([type, list]) => <PartCard key={type} type={type} parts={list} priv={priv} team={team} own={own} />)}
      </div>
    </div>
  )
}

function BudgetStrip({ budget }: { budget: number }) {
  const { me } = useLeague()
  const hq = useHqOrders().committed(me.team)
  const parts = useParts().committed(me.team)
  const bids = useTransfers().committed
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-sm tabular-nums">
      <span><span className="text-muted-foreground">Budget </span>{fmtMoneyShort(budget)}</span>
      {parts > 0 && <span><span className="text-muted-foreground">Queued design </span>−{fmtMoneyShort(parts)}</span>}
      {hq > 0 && <span><span className="text-muted-foreground">HQ orders </span>−{fmtMoneyShort(hq)}</span>}
      {bids > 0 && <span><span className="text-muted-foreground">Leading bids </span>−{fmtMoneyShort(bids)}</span>}
      <span className="font-medium"><span className="text-muted-foreground">Available </span>{fmtMoneyShort(budget - hq - parts - bids)}</span>
      <span className="text-xs text-muted-foreground">Designs are paid at MM's player price and started in game at the next apply.</span>
    </div>
  )
}

function DesignCard({ priv, team, own }: { priv: TeamPrivate; team: string; own: boolean }) {
  const p = useParts()
  const design = priv.design!
  const queued = p.orders.find((o) => o.team === team && o.status === "queued")
  const current = design.current
  const aiCurrent = isAiDesign(current, team, p.orders, p.leagueStart)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const summaries = (type: string, ids: number[]) => ids.map((id) => design.types[type]?.components.find((c) => c.id === id)).filter(Boolean) as DesignComponent[]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wrench className="size-4" /> Part design</CardTitle>
        <CardDescription>MM designs one part at a time. Pick components from your team's list; MM builds the part with its own stats.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {current && (
          <div className={cn("rounded-lg border p-3", aiCurrent && "border-amber-500/50")}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {aiCurrent ? <Badge variant="outline" className="gap-1"><Bot className="size-3" /> AI design</Badge> : <Badge>Designing</Badge>}
              <span className="font-medium">{humanize(current.type)}</span>
              <span className="text-muted-foreground">done {fmtDate(current.end)}</span>
            </div>
            {aiCurrent && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">The in-game AI started this with your money. It's cancelled and refunded at the next apply, so you can order your own.</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              {summaries(current.type, current.components).map((c) => <div key={c.id} className="rounded-md bg-muted/60 px-2 py-1"><Summary text={c.summary} /></div>)}
            </div>
          </div>
        )}
        {queued ? (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>Queued</Badge>
              <span className="font-medium">{humanize(queued.part_type)}</span>
              <span className="tabular-nums text-muted-foreground">{fmtMoney(queued.cost)}</span>
              {own && <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void run(() => p.cancelDesign(queued.id))}>Cancel</Button>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {summaries(queued.part_type, queued.components).map((c) => <div key={c.id} className="rounded-md bg-muted/60 px-2 py-1"><Summary text={c.summary} /></div>)}
            </div>
          </div>
        ) : current && !aiCurrent ? null : own ? (
          <Designer priv={priv} busy={busy} onOrder={(type, ids) => run(() => p.orderDesign(type, ids))} />
        ) : (
          !current && <p className="text-sm text-muted-foreground">No design running or queued.</p>
        )}
      </CardContent>
    </Card>
  )
}

function Designer({ priv, busy, onOrder }: { priv: TeamPrivate; busy: boolean; onOrder: (type: string, ids: number[]) => Promise<void> }) {
  const design = priv.design!
  const types = Object.keys(design.types)
  const [type, setType] = useState(types[0])
  const [picked, setPicked] = useState<number[]>([])
  const opts = design.types[type]
  const byId = useMemo(() => new Map(opts.components.map((c) => [c.id, c])), [opts])
  let plan: DesignPlan | null = null
  let problem: string | null = null
  if (picked.length) {
    try { plan = planDesign(opts.ctx, picked.map((id) => byId.get(id)!)) } catch (e) { problem = (e as Error).message }
  }
  const toggle = (id: number) => setPicked((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]))
  const buildingName = (t: number) => priv.hq.find((b) => b.type === t)?.name ?? `building #${t}`
  const chosen = picked.map((id) => byId.get(id)!).filter(Boolean)
  const sum = (k: "statBoost" | "maxStatBoost" | "reliabilityBoost") => chosen.reduce((s, c) => s + c[k], 0)

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={type} onValueChange={(v) => { setType(v); setPicked([]) }}>
        <TabsList className="flex-wrap">
          {types.map((t) => <TabsTrigger key={t} value={t}>{humanize(t)}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-muted-foreground">Slots</div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: opts.ctx.slots }, (_, i) => {
            const c = plan?.slots[i] != null ? byId.get(plan.slots[i]!) : null
            return <Slot key={`s${i}`} label={`Slot ${i + 1} · up to ${LEVEL_NAMES[i]}`} component={c ?? null} />
          })}
          {plan?.bonusSlots.map((b, i) => (
            <Slot key={`b${i}`} bonus label={`Bonus slot · up to ${LEVEL_NAMES[b.level - 1]}`} component={b.component != null ? byId.get(b.component)! : null} />
          ))}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3, 4, 5].map((level) => {
          const list = opts.components.filter((c) => c.level === level)
          const lock = opts.locked.find((l) => l.level === level)
          if (!list.length && !lock) return null
          return (
            <div key={level} className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                Level {level} · {LEVEL_NAMES[level - 1]}
                {lock && <span className="ml-1 font-normal">— needs {buildingName(lock.buildingType)} level {lock.buildingLevel}</span>}
              </div>
              {list.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggle(c.id)}
                  className={cn(
                    "flex items-start justify-between gap-2 rounded-lg border p-2 text-left transition-colors hover:bg-muted/60",
                    picked.includes(c.id) && "border-primary bg-primary/10 hover:bg-primary/15",
                  )}
                >
                  <Summary text={c.summary} />
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {c.engineer && <Badge variant="secondary" className="text-[10px]">Engineer</Badge>}
                    <span className="text-xs tabular-nums text-muted-foreground">{fmtMoneyShort(componentPrice(c, opts))}</span>
                  </div>
                </button>
              ))}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-muted/50 px-4 py-3 text-sm tabular-nums">
        {problem ? <span className="text-destructive">{problem}</span> : plan ? (
          <>
            <span><span className="text-muted-foreground">Part level </span>{plan.level}</span>
            <span><span className="text-muted-foreground">Performance </span>{sum("statBoost") >= 0 ? "+" : ""}{fmtNum(sum("statBoost"), 0)}</span>
            <span><span className="text-muted-foreground">Max performance </span>{sum("maxStatBoost") >= 0 ? "+" : ""}{fmtNum(sum("maxStatBoost"), 0)}</span>
            <span><span className="text-muted-foreground">Reliability </span>{sum("reliabilityBoost") >= 0 ? "+" : ""}{fmtPct(sum("reliabilityBoost"))}</span>
            <span><span className="text-muted-foreground">Time </span>{fmtDays(plan.days)}</span>
            {plan.extraCopies > 0 && <span><span className="text-muted-foreground">Parts </span>{1 + plan.extraCopies}</span>}
            <span className="font-medium"><span className="text-muted-foreground">Cost </span>{fmtMoney(plan.cost)}</span>
          </>
        ) : <span className="text-muted-foreground">Base cost {fmtMoney(opts.ctx.settings.materialsCost)} · {opts.ctx.settings.buildTimeDays} days. Pick components to see the design.</span>}
        <Button className="ml-auto" disabled={!plan || busy} onClick={() => void onOrder(type, picked).then(() => setPicked([]))}>
          {busy && <Loader2 className="animate-spin" />} Order design
        </Button>
      </div>
    </div>
  )
}

function Slot({ label, component, bonus }: { label: string; component: DesignComponent | null; bonus?: boolean }) {
  return (
    <div className={cn("flex min-h-16 w-44 flex-col gap-1 rounded-lg border border-dashed p-2", component && "border-solid bg-muted/40", bonus && "border-primary/50")}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {component ? <Summary text={component.summary} /> : <span className="text-xs text-muted-foreground">Empty</span>}
    </div>
  )
}

/** The member's improvement choice, else the game's current lists (null without design data). */
function useImprovement(priv: TeamPrivate, team: string) {
  const p = useParts()
  const row = p.improvement.find((i) => i.team === team)
  const imp = priv.design?.improvement
  if (!imp) return null
  return { performance: row?.performance ?? imp.performance, reliability: row?.reliability ?? imp.reliability, split: row?.split ?? imp.split, chosen: !!row }
}

function ImprovementCard({ priv, team, own }: { priv: TeamPrivate; team: string; own: boolean }) {
  const p = useParts()
  const imp = priv.design!.improvement
  const cur = useImprovement(priv, team)!
  const [split, setSplit] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = split ?? cur.split
  const commit = async () => {
    if (split == null || split === cur.split) return
    try { await p.setImprovement(cur.performance, cur.reliability, split) } catch (e) { setError((e as Error).message) }
    setSplit(null)
  }
  // MM puts every mechanic on the only list that has parts.
  const forced = !cur.performance.length && cur.reliability.length ? 0 : cur.performance.length && !cur.reliability.length ? 1 : null
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Part improvement</CardTitle>
        <CardDescription>
          {imp.mechanics} mechanics work on up to {imp.slots} parts per list (Factory level).
          {" "}Performance {cur.performance.length}/{imp.slots} · reliability {cur.reliability.length}/{imp.slots}.
          {cur.chosen ? " Re-applied at every apply." : " Showing the game's current lists until you change them."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex items-center gap-3 text-sm">
          <span className="w-24 text-right text-muted-foreground">Reliability {Math.round((1 - (forced ?? shown)) * 100)}%</span>
          <input
            type="range" min={0} max={100} step={5} className="flex-1 accent-primary"
            value={Math.round((forced ?? shown) * 100)} disabled={!own || forced != null}
            onChange={(e) => setSplit(Number(e.target.value) / 100)}
            onPointerUp={() => void commit()} onKeyUp={() => void commit()}
          />
          <span className="w-24 text-muted-foreground">Performance {Math.round((forced ?? shown) * 100)}%</span>
        </div>
        {forced != null && <p className="text-xs text-muted-foreground">With parts in only one list, MM puts every mechanic on it.</p>}
      </CardContent>
    </Card>
  )
}

function PartCard({ type, parts, priv, team, own }: { type: string; parts: Part[]; priv: TeamPrivate; team: string; own: boolean }) {
  const p = useParts()
  const imp = priv.design?.improvement
  const cur = useImprovement(priv, team)
  const fit = effectiveFitting(priv, team, p.fitting)[type] ?? [null, null]
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sorted = [...parts].sort((a, b) => (a.fittedToCar ?? 9) - (b.fittedToCar ?? 9) || (b.stat ?? 0) - (a.stat ?? 0))
  const best = Math.max(...parts.map((x) => x.stat ?? 0))
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const toggleImprove = (list: "performance" | "reliability", guid: string) => {
    if (!cur) return
    const next = { performance: [...cur.performance], reliability: [...cur.reliability] }
    next[list] = next[list].includes(guid) ? next[list].filter((g) => g !== guid) : [...next[list], guid]
    return run(`${list}${guid}`, () => p.setImprovement(next.performance, next.reliability, cur.split))
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{humanize(type)}</CardTitle>
        <CardDescription>{parts.length} in inventory · best {fmtNum(best)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead className="text-right">Stat</TableHead>
              <TableHead className="text-right">Perf.</TableHead>
              <TableHead className="text-right">Rel.</TableHead>
              <TableHead className="text-right">Cond.</TableHead>
              <TableHead className="text-right">Car</TableHead>
              {cur && <TableHead className="text-right">Improve</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((part) => {
              const ai = isAiPart(part, type, team, p.orders, p.leagueStart)
              const perfDone = (part.performance ?? 0) >= (part.maxPerformance ?? 0)
              const relDone = (part.reliability ?? 0) >= (part.maxReliability ?? 0)
              return (
                <TableRow key={part.guid} className={cn(ai && "opacity-60")}>
                  <TableCell>
                    <div className="font-mono text-xs">{part.name} <span className="text-muted-foreground">L{part.level}</span></div>
                    {ai && <div className="text-[11px] text-amber-600 dark:text-amber-400">AI-built · removed at next apply</div>}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", part.stat === best && "font-semibold text-primary")}>{fmtNum(part.stat)}</TableCell>
                  <TableCell className="text-right tabular-nums" title="Performance gained / max">{fmtNum(part.performance)}/{fmtNum(part.maxPerformance, 0)}</TableCell>
                  <TableCell className="text-right tabular-nums" title="Reliability / max">{fmtPct(part.reliability)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(part.condition)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {([0, 1] as const).map((car) => {
                        const on = fit[car] === part.guid
                        const onOther = fit[1 - car] === part.guid
                        if (!own) return on ? <Badge key={car}>Car {car + 1}</Badge> : null
                        return (
                          <Button
                            key={car} size="sm" variant={on ? "default" : "outline"} className="h-6 px-2 text-xs"
                            disabled={on || ai || busy != null || onOther}
                            title={onOther ? `On car ${2 - car}: fit another part there first` : undefined}
                            onClick={() => void run(`fit${car}${part.guid}`, () => p.setFitting(car, type, part.guid))}
                          >
                            {car + 1}
                          </Button>
                        )
                      })}
                    </div>
                  </TableCell>
                  {cur && imp && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {(["performance", "reliability"] as const).map((list) => {
                          const on = cur[list].includes(part.guid)
                          const full = !on && cur[list].length >= imp.slots
                          const done = list === "performance" ? perfDone : relDone
                          if (!own) return on ? <Badge key={list} variant="secondary">{list === "performance" ? "P" : "R"}</Badge> : null
                          return (
                            <Button
                              key={list} size="sm" variant={on ? "default" : "outline"} className="h-6 w-6 p-0 text-xs"
                              disabled={ai || busy != null || (!on && (full || done))}
                              title={`${list === "performance" ? "Performance" : "Reliability"}${done && !on ? ": already at its max" : full ? `: list full (${imp.slots})` : ""}`}
                              onClick={() => void toggleImprove(list, part.guid)}
                            >
                              {list === "performance" ? "P" : "R"}
                            </Button>
                          )
                        })}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>
}
