import {
  Bot, Car, ChevronsUp, Clock, Coins, Cog, Disc3, Fan, Fuel, Gauge, Hammer, HeartPulse, Layers, Loader2, Lock,
  Package, PencilRuler, Settings2, ShieldCheck, ShieldPlus, Sparkles, Star, Timer, TriangleAlert, User, Waves, Wind,
  WindArrowDown, Wrench, type LucideIcon,
} from "lucide-react"
import { Fragment, useMemo, useState, type ReactNode } from "react"
import { planDesign, predictPart, type DesignPlan } from "../../../src/part-design.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fmtDate, fmtMoney, fmtMoneyShort, fmtNum, fmtPct, humanize } from "@/lib/format"
import { useHqOrders } from "@/lib/hq"
import { useLeague } from "@/lib/league"
import { effectiveFitting, isAiDesign, isAiPart, useParts } from "@/lib/parts"
import { useTransfers } from "@/lib/transfers"
import { cn } from "@/lib/utils"
import type { DesignComponent, Part, PartDesignOptions, TeamPrivate } from "@/lib/types"

// ---------------------------------------------------------------------------------------------
// Icons and tiers, after MM's own design screen: a symbol per part, per stat and per tier.

export const PART_ICONS: Record<string, LucideIcon> = {
  Brakes: Disc3, Engine: Fan, FrontWing: Wind, Gearbox: Cog, RearWing: WindArrowDown, Suspension: Waves,
}
/** MM's part order. */
const PART_ORDER = ["Brakes", "Engine", "FrontWing", "Gearbox", "RearWing", "Suspension"]
const partIcon = (type: string) => PART_ICONS[type.replace(/(GT|GET)$/, "")] ?? Settings2

const TIERS = [
  { name: "Basic", color: "text-zinc-400", border: "border-zinc-400/40" },
  { name: "Good", color: "text-emerald-500", border: "border-emerald-500/50" },
  { name: "Great", color: "text-sky-500", border: "border-sky-500/50" },
  { name: "Epic", color: "text-violet-500", border: "border-violet-500/50" },
  { name: "Legendary", color: "text-amber-500", border: "border-amber-500/60" },
]

function Tier({ level, label = false }: { level: number; label?: boolean }) {
  const tier = TIERS[level - 1]
  if (!tier) return <span className="text-xs text-muted-foreground">L{level}</span>
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", tier.color)} title={`Level ${level} · ${tier.name}`}>
      <span className="inline-flex">{Array.from({ length: level }, (_, i) => <Star key={i} className="size-3 fill-current" />)}</span>
      {label && <span className="font-medium">{tier.name}</span>}
    </span>
  )
}

/** The icon for a line of MM's component summary, by its label. */
function lineIcon(line: string): LucideIcon {
  const l = line.toLowerCase()
  if (l.includes("max performance")) return ChevronsUp
  if (l.includes("max reliability")) return ShieldPlus
  if (l.includes("performance")) return Gauge
  if (l.includes("reliability")) return ShieldCheck
  if (l.includes("build time") || l.includes("each million")) return Clock
  if (l.includes("cost")) return Coins
  if (l.includes("risk")) return TriangleAlert
  if (l.includes("slot")) return Sparkles
  if (l.includes("components")) return Layers
  if (l.includes("driver")) return User
  if (l.includes("fuel")) return Fuel
  if (l.includes("additional parts")) return Package
  if (l.includes("fix time")) return Timer
  if (l.includes("condition")) return HeartPulse
  return Settings2
}

/** MM's component summaries: "<b>Performance:</b> +10\r\n<b>Reliability:</b> -15%". */
function Summary({ text, className }: { text: string; className?: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  return (
    <div className={cn("flex flex-col gap-0.5 text-xs leading-snug", className)}>
      {lines.map((line, i) => {
        const Icon = lineIcon(line.replace(/<\/?b>/g, ""))
        return (
          <span key={i} className="flex items-start gap-1.5">
            <Icon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
            <span>
              {line.split(/(<b>.*?<\/b>)/g).map((chunk, j) =>
                chunk.startsWith("<b>") ? <strong key={j} className="font-medium">{chunk.slice(3, -4)}</strong> : <Fragment key={j}>{chunk}</Fragment>)}
            </span>
          </span>
        )
      })}
    </div>
  )
}

function StatPill({ icon: Icon, label, children, className }: { icon: LucideIcon; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5", className)} title={label}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-sm tabular-nums">{children}</span>
      </div>
    </div>
  )
}

const componentPrice = (c: DesignComponent, o: PartDesignOptions) =>
  c.cost !== 0 ? c.cost : c.engineer ? 0 : o.ctx.settings.costPerLevel[c.level - 1] ?? 0

const fmtDays = (d: number) => {
  const whole = Math.floor(d), hours = Math.round((d - whole) * 24)
  return `${whole} day${whole === 1 ? "" : "s"}${hours ? ` ${hours} h` : ""}`
}
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`

// ---------------------------------------------------------------------------------------------

export function PartsTab({ priv, team, own }: { priv: TeamPrivate; team: string; own: boolean }) {
  const design = priv.design ?? null
  return (
    <div className="flex flex-col gap-4">
      {own && <BudgetStrip budget={priv.budget ?? 0} />}
      <Tabs defaultValue="design">
        <TabsList variant="line">
          <TabsTrigger value="design"><PencilRuler /> Design a new part</TabsTrigger>
          <TabsTrigger value="parts"><Car /> Your parts: fitting &amp; improvement</TabsTrigger>
        </TabsList>
        <TabsContent value="design" className="pt-2">
          {design ? <DesignCard priv={priv} team={team} own={own} /> : <NoDesignData />}
        </TabsContent>
        <TabsContent value="parts" className="flex flex-col gap-4 pt-2">
          <p className="text-sm text-muted-foreground">
            Parts your team already owns. Choose what each car runs and which parts your mechanics improve;
            both choices are re-applied before every race. Newly designed parts appear here after the organizer's next publish.
          </p>
          {design ? <ImprovementCard priv={priv} team={team} own={own} /> : <NoDesignData />}
          <div className="grid gap-3 lg:grid-cols-2">
            {Object.entries(priv.parts).map(([type, list]) => <PartCard key={type} type={type} parts={list} priv={priv} team={team} own={own} />)}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function NoDesignData() {
  return <Alert><AlertDescription>The latest publish has no design data yet; it appears after the organizer publishes again.</AlertDescription></Alert>
}

function BudgetStrip({ budget }: { budget: number }) {
  const { me } = useLeague()
  const hq = useHqOrders().committed(me.team)
  const parts = useParts().committed(me.team)
  const bids = useTransfers().committed
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-sm tabular-nums">
      <span className="flex items-center gap-1.5"><Coins className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Budget</span> {fmtMoneyShort(budget)}</span>
      {parts > 0 && <span><span className="text-muted-foreground">Queued design </span>−{fmtMoneyShort(parts)}</span>}
      {hq > 0 && <span><span className="text-muted-foreground">HQ orders </span>−{fmtMoneyShort(hq)}</span>}
      {bids > 0 && <span><span className="text-muted-foreground">Leading bids </span>−{fmtMoneyShort(bids)}</span>}
      <span className="font-medium"><span className="text-muted-foreground">Available </span>{fmtMoneyShort(budget - hq - parts - bids)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Design

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
  const comps = (type: string, ids: number[]) => ids.map((id) => design.types[type]?.components.find((c) => c.id === id)).filter(Boolean) as DesignComponent[]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PencilRuler className="size-4" /> Design a new part</CardTitle>
        <CardDescription>
          MM designs one part at a time. Pick components from your team's list; MM builds the part in game with its own stats,
          paid at MM's player price when the organizer applies it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {current && (
          <DesignSummary
            type={current.type}
            components={comps(current.type, current.components)}
            badge={aiCurrent ? <Badge variant="outline" className="gap-1"><Bot className="size-3" /> AI design</Badge> : <Badge className="gap-1"><Hammer className="size-3" /> In production</Badge>}
            extra={<span className="flex items-center gap-1 text-muted-foreground"><Clock className="size-3.5" /> done {fmtDate(current.end)}</span>}
            className={aiCurrent ? "border-amber-500/50" : undefined}
            note={aiCurrent ? "The in-game AI started this with your money. It's cancelled and refunded at the next apply, so you can order your own." : undefined}
          />
        )}
        {queued ? (
          <DesignSummary
            type={queued.part_type}
            components={comps(queued.part_type, queued.components)}
            badge={<Badge className="gap-1"><Clock className="size-3" /> Queued</Badge>}
            extra={<span className="flex items-center gap-1 tabular-nums text-muted-foreground"><Coins className="size-3.5" /> {fmtMoney(queued.cost)}</span>}
            action={own && <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void run(() => p.cancelDesign(queued.id))}>Cancel</Button>}
            className="border-primary/40 bg-primary/5"
            note="Started in game at the next apply."
          />
        ) : current && !aiCurrent ? null : own ? (
          <Designer priv={priv} busy={busy} onOrder={(type, ids) => run(() => p.orderDesign(type, ids))} />
        ) : (
          !current && <p className="text-sm text-muted-foreground">No design running or queued.</p>
        )}
      </CardContent>
    </Card>
  )
}

function DesignSummary({ type, components, badge, extra, action, note, className }: {
  type: string; components: DesignComponent[]; badge: ReactNode; extra?: ReactNode; action?: ReactNode; note?: string; className?: string
}) {
  const Icon = partIcon(type)
  return (
    <div className={cn("rounded-lg border p-3", className)}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {badge}
        <span className="flex items-center gap-1.5 font-medium"><Icon className="size-4" /> {humanize(type)}</span>
        {extra}
        {action}
      </div>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {components.map((c) => (
          <div key={c.id} className={cn("flex flex-col gap-1 rounded-md border bg-muted/40 px-2 py-1.5", TIERS[c.level - 1]?.border)}>
            <Tier level={c.level} />
            <Summary text={c.summary} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Designer({ priv, busy, onOrder }: { priv: TeamPrivate; busy: boolean; onOrder: (type: string, ids: number[]) => Promise<void> }) {
  const design = priv.design!
  const types = PART_ORDER.filter((t) => t in design.types)
  const spec = design.specParts ?? []
  const [type, setType] = useState(types[0])
  const [picked, setPicked] = useState<number[]>([])
  const opts = design.types[type]
  const byId = useMemo(() => new Map(opts.components.map((c) => [c.id, c])), [opts])
  const chosen = picked.map((id) => byId.get(id)!).filter(Boolean)
  let plan: DesignPlan | null = null
  let problem: string | null = null
  if (chosen.length) {
    try { plan = planDesign(opts.ctx, chosen) } catch (e) { problem = (e as Error).message }
  }
  // A component that can't go into the current design (no free slot of its level) is disabled.
  const whyNot = (c: DesignComponent) => {
    if (picked.includes(c.id)) return null
    try { planDesign(opts.ctx, [...chosen, c]); return null } catch (e) { return (e as Error).message }
  }
  const toggle = (id: number) => setPicked((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]))
  const buildingName = (t: number) => priv.hq.find((b) => b.type === t)?.name ?? `building #${t}`
  const base = opts.base
  const result = base ? predictPart(base, chosen) : null
  const owned = priv.parts[type] ?? []
  const best = owned.reduce((m, x) => Math.max(m, (x.stat ?? 0) + (x.performance ?? 0)), 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Tabs value={type} onValueChange={(v) => { setType(v); setPicked([]) }}>
          <TabsList className="h-auto flex-wrap">
            {PART_ORDER.filter((t) => t in design.types || spec.includes(t)).map((t) => {
              const Icon = partIcon(t)
              const isSpec = spec.includes(t)
              return (
                <TabsTrigger key={t} value={t} disabled={isSpec} title={isSpec ? `${humanize(t)} is a spec part: it can't be designed or improved` : undefined}>
                  <Icon /> {humanize(t)}
                  {isSpec && <span className="flex items-center gap-0.5 text-[10px] uppercase tracking-wide"><Lock className="size-3" /> Spec</span>}
                </TabsTrigger>
              )
            })}
          </TabsList>
        </Tabs>
        {spec.length > 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            {spec.map((t) => humanize(t)).join(" and ")} {spec.length > 1 ? "are spec parts" : "is a spec part"} in this championship:
            every team runs the supplier's part, so {spec.length > 1 ? "they" : "it"} can't be designed or improved.
          </p>
        )}
      </div>

      {base && result && (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-lg border p-3">
            <div className="text-xs font-medium text-muted-foreground">Starting point (before components)</div>
            <div className="flex flex-wrap gap-2">
              <StatPill icon={Gauge} label="Performance">{fmtNum(base.stat)}</StatPill>
              <StatPill icon={ChevronsUp} label="Max performance">{fmtNum(base.maxPerformance)}</StatPill>
              <StatPill icon={ShieldCheck} label="Reliability">{fmtPct(base.reliability)}</StatPill>
              <StatPill icon={ShieldPlus} label="Max reliability">{fmtPct(base.maxReliability)}</StatPill>
            </div>
            <div className="text-xs text-muted-foreground">
              Your best {humanize(type).toLowerCase()} now: {fmtNum(best)}. Component performance counts ×{base.developmentRate.toFixed(2)} (your {humanize(type).toLowerCase()} development rate).
            </div>
          </div>
          <div className={cn("flex flex-col gap-2 rounded-lg border p-3", chosen.length && "border-primary/50")}>
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              New part (estimate) {plan && <Tier level={plan.level} label />}
            </div>
            <div className="flex flex-wrap gap-2">
              <StatPill icon={Gauge} label="Performance">{fmtNum(result.stat)} <Delta v={result.stat - base.stat} /></StatPill>
              <StatPill icon={ChevronsUp} label="Max performance">{fmtNum(result.maxPerformance)} <Delta v={result.maxPerformance - base.maxPerformance} /></StatPill>
              <StatPill icon={ShieldCheck} label="Reliability">{fmtPct(result.reliability)}</StatPill>
              <StatPill icon={ShieldPlus} label="Max reliability">≈{fmtPct(result.maxReliability)}</StatPill>
              {result.risk !== 0 && <StatPill icon={TriangleAlert} label="Rules risk">{signed(result.risk, 0)}</StatPill>}
            </div>
            <div className="text-xs text-muted-foreground">MM rolls max reliability ±10 % when the design starts.</div>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Layers className="size-3.5" /> Slots</div>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: opts.ctx.slots }, (_, i) => {
            const c = plan?.slots[i] != null ? byId.get(plan.slots[i]!) : null
            return <Slot key={`s${i}`} level={i + 1} component={c ?? null} />
          })}
          {plan?.bonusSlots.map((b, i) => (
            <Slot key={`b${i}`} bonus level={b.level} component={b.component != null ? byId.get(b.component)! : null} />
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
              <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
                <Tier level={level} label />
                {lock && <span className="flex items-center gap-1 font-normal"><Lock className="size-3" /> needs {buildingName(lock.buildingType)} level {lock.buildingLevel}</span>}
              </div>
              {lock && !list.length && (
                <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  <Lock className="size-4" /> Locked until your HQ has the building.
                </div>
              )}
              {list.map((c) => {
                const reason = whyNot(c)
                const on = picked.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    disabled={!!reason}
                    title={reason ?? undefined}
                    onClick={() => toggle(c.id)}
                    className={cn(
                      "flex items-start justify-between gap-2 rounded-lg border p-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                      on && "border-primary bg-primary/10 hover:bg-primary/15",
                    )}
                  >
                    <Summary text={c.summary} />
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {c.engineer && <Badge variant="secondary" className="text-[10px]">Engineer</Badge>}
                      <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><Coins className="size-3" />{fmtMoneyShort(componentPrice(c, opts))}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg bg-muted/50 px-4 py-3 text-sm tabular-nums">
        {problem ? <span className="text-destructive">{problem}</span> : plan ? (
          <>
            <span className="flex items-center gap-1.5"><Clock className="size-4 text-muted-foreground" /> {fmtDays(plan.days)}</span>
            {plan.extraCopies > 0 && <span className="flex items-center gap-1.5"><Package className="size-4 text-muted-foreground" /> {1 + plan.extraCopies} parts</span>}
            <span className="flex items-center gap-1.5 font-medium"><Coins className="size-4 text-muted-foreground" /> {fmtMoney(plan.cost)}</span>
          </>
        ) : (
          <span className="flex items-center gap-3 text-muted-foreground">
            <span className="flex items-center gap-1.5"><Coins className="size-4" /> from {fmtMoney(opts.ctx.settings.materialsCost)}</span>
            <span className="flex items-center gap-1.5"><Clock className="size-4" /> {opts.ctx.settings.buildTimeDays} days base</span>
            <span>Pick components to see the design.</span>
          </span>
        )}
        <Button className="ml-auto" disabled={!plan || busy} onClick={() => void onOrder(type, picked).then(() => setPicked([]))}>
          {busy ? <Loader2 className="animate-spin" /> : <Hammer />} Order design
        </Button>
      </div>
    </div>
  )
}

function Delta({ v }: { v: number }) {
  if (Math.abs(v) < 0.05) return null
  return <span className={cn("text-xs", v > 0 ? "text-emerald-500" : "text-destructive")}>{signed(v)}</span>
}

function Slot({ level, component, bonus }: { level: number; component: DesignComponent | null; bonus?: boolean }) {
  return (
    <div className={cn("flex min-h-16 w-44 flex-col gap-1 rounded-lg border border-dashed p-2", component && "border-solid bg-muted/40", TIERS[level - 1]?.border)}>
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {bonus ? <Sparkles className="size-3" /> : <Layers className="size-3" />}
        {bonus ? "Bonus slot" : `Slot ${level}`} · up to <Tier level={level} />
      </span>
      {component ? <Summary text={component.summary} /> : <span className="text-xs text-muted-foreground">Empty</span>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Fitting and improvement

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
  const value = forced ?? shown
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wrench className="size-4" /> Mechanics: improving parts you own</CardTitle>
        <CardDescription>
          Your {imp.mechanics} mechanics work on up to {imp.slots} parts per list (Factory level). Pick parts with the
          {" "}<Gauge className="inline size-3.5" /> and <ShieldCheck className="inline size-3.5" /> buttons in the tables below.
          {cur.chosen ? " Re-applied before every race." : " Showing the game's current lists until you change them."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="flex flex-wrap gap-2">
          <StatPill icon={Gauge} label="Improving performance">{cur.performance.length} / {imp.slots} parts</StatPill>
          <StatPill icon={ShieldCheck} label="Improving reliability">{cur.reliability.length} / {imp.slots} parts</StatPill>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="flex w-36 items-center justify-end gap-1.5 text-muted-foreground"><ShieldCheck className="size-4" /> Reliability {Math.round((1 - value) * 100)}%</span>
          <input
            type="range" min={0} max={100} step={5} className="flex-1 accent-primary" aria-label="Mechanics split"
            value={Math.round(value * 100)} disabled={!own || forced != null}
            onChange={(e) => setSplit(Number(e.target.value) / 100)}
            onPointerUp={() => void commit()} onKeyUp={() => void commit()}
          />
          <span className="flex w-36 items-center gap-1.5 text-muted-foreground"><Gauge className="size-4" /> Performance {Math.round(value * 100)}%</span>
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
  const Icon = partIcon(type)
  const isSpec = (priv.design?.specParts ?? []).includes(type)
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
  const head = (icon: LucideIcon, label: string, title: string, right = true) => {
    const H = icon
    return <TableHead className={right ? "text-right" : undefined} title={title}><span className={cn("inline-flex items-center gap-1", right && "justify-end")}><H className="size-3.5" />{label}</span></TableHead>
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4" /> {humanize(type)}
          {isSpec && <Badge variant="outline" className="gap-1 text-[10px] uppercase"><Lock className="size-3" /> Spec</Badge>}
        </CardTitle>
        <CardDescription>
          {parts.length} in inventory · best {fmtNum(best)}
          {isSpec && " · supplied part: can't be designed or improved"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              {head(Gauge, "Stat", "Performance stat")}
              {head(ChevronsUp, "Gained", "Performance gained by improvement / max")}
              {head(ShieldCheck, "Rel.", "Reliability")}
              {head(HeartPulse, "Cond.", "Condition")}
              {head(Car, "Car", "Fitted to car 1 or 2")}
              {cur && head(Wrench, "Improve", "What the mechanics improve")}
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
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{part.name}</span>
                      {part.level > 0 && <Tier level={part.level} />}
                    </div>
                    {ai && <div className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"><Bot className="size-3" /> AI-built · removed at next apply</div>}
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", part.stat === best && "font-semibold text-primary")}>{fmtNum(part.stat)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(part.performance)}/{fmtNum(part.maxPerformance)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(part.reliability)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtPct(part.condition)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {([0, 1] as const).map((car) => {
                        const on = fit[car] === part.guid
                        const onOther = fit[1 - car] === part.guid
                        if (!own) return on ? <Badge key={car}>Car {car + 1}</Badge> : null
                        return (
                          <Button
                            key={car} size="sm" variant={on ? "default" : "outline"} className="h-6 px-2 text-xs disabled:opacity-100"
                            disabled={on || ai || busy != null || onOther}
                            title={on ? `Runs on car ${car + 1}` : onOther ? `On car ${2 - car}: fit another part there first` : `Fit to car ${car + 1}`}
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
                          const ListIcon = list === "performance" ? Gauge : ShieldCheck
                          const name = list === "performance" ? "Improve performance" : "Improve reliability"
                          if (!own) return on ? <Badge key={list} variant="secondary"><ListIcon className="size-3" /></Badge> : null
                          return (
                            <Button
                              key={list} size="sm" variant={on ? "default" : "outline"} className="size-6 p-0"
                              disabled={ai || isSpec || busy != null || (!on && (full || done))}
                              title={`${name}${isSpec ? ": spec part, can't be improved" : done && !on ? ": already at its max" : full ? `: list full (${imp.slots})` : ""}`}
                              aria-label={name}
                              onClick={() => void toggleImprove(list, part.guid)}
                            >
                              <ListIcon className="size-3.5" />
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
