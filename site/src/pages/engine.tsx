import { ChevronsUp, Coins, Factory, Fan, FlaskConical, Fuel, Gauge, Loader2, Lock, Plus, ShoppingCart, Siren, Store, Wrench } from "lucide-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  carryOver, CONCEPTS, developEngine, ENGINE_SETTINGS, illegalDetection, pointsCost, projectChance, PROJECTS,
  type EngineArea, type EngineConcept, type EngineStats,
} from "../../../src/engine-rules.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/page-header"
import { fmtMoney, fmtMoneyShort, fmtPct, statAverage } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { demoMode, supabase, watchTable } from "@/lib/supabase"
import { cn } from "@/lib/utils"

interface Programme { team: string; name: string; founded_season: number; offering: boolean; customer_price: number; customer_detuned: boolean }
interface Plan { team: string; season: number; concept: EngineConcept; points: Record<EngineArea, number>; projects: string[] }
interface Build { team: string; season: number; legal: EngineStats; works: EngineStats }
interface Customer { customer: string; season: number; owner: string; price: number; detuned: boolean }

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

function useEngineData() {
  const [data, setData] = useState({ programmes: [] as Programme[], plans: [] as Plan[], builds: [] as Build[], customers: [] as Customer[] })
  const reload = useCallback(async () => {
    if (demoMode) return
    const [programmes, plans, builds, customers] = await Promise.all([
      check(supabase!.from("engine_programmes").select("*")),
      check(supabase!.from("engine_plans").select("*")),
      check(supabase!.from("engine_builds").select("*").order("season", { ascending: false })),
      check(supabase!.from("engine_customers").select("*")),
    ])
    setData({ programmes: (programmes ?? []) as Programme[], plans: (plans ?? []) as Plan[], builds: (builds ?? []) as Build[], customers: (customers ?? []) as Customer[] })
  }, [])
  useEffect(() => {
    if (demoMode) return
    void reload()
    const ch = supabase!.channel("engines")
    for (const table of ["engine_programmes", "engine_plans", "engine_spend", "engine_customers"]) watchTable(ch, table, () => void reload())
    ch.subscribe()
    return () => void supabase!.removeChannel(ch)
  }, [reload])
  return { ...data, reload }
}

const AREAS: { area: EngineArea; label: string; icon: typeof Gauge }[] = [
  { area: "power", label: "Power (engine level)", icon: Gauge },
  { area: "fuel", label: "Fuel efficiency", icon: Fuel },
  { area: "improvability", label: "Improvability", icon: ChevronsUp },
  { area: "tyres", label: "Tyre wear", icon: Wrench },
]

function EngineStatsView({ e, label }: { e: EngineStats; label: string }) {
  const pill = (icon: ReactNode, name: string, value: string) => (
    <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5" title={name}>
      {icon}<div className="flex flex-col leading-tight"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">{name}</span><span className="text-sm tabular-nums">{value}</span></div>
    </div>
  )
  const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-2">
        {pill(<Gauge className="size-4 text-muted-foreground" />, "Engine level", e.level.toFixed(0))}
        {pill(<Fuel className="size-4 text-muted-foreground" />, "Fuel efficiency", signed(e.fuel))}
        {pill(<ChevronsUp className="size-4 text-muted-foreground" />, "Improvability", signed(e.improvability))}
        {pill(<Wrench className="size-4 text-muted-foreground" />, "Tyre wear", signed(e.tyreWear))}
      </div>
    </div>
  )
}

export function EnginePage() {
  const { me, league } = useLeague()
  const d = useEngineData()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, fn: () => PromiseLike<unknown>) => {
    setBusy(key); setError(null)
    try { await check(fn() as PromiseLike<{ data: unknown; error: { message: string } | null }>); await d.reload() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const ch = league.snapshot.championship
  const season = Number(league.snapshot.gameDate.slice(0, 4))
  const mine = d.programmes.find((p) => p.team === me.team)
  const specEngine = (league.privateTeams[me.team]?.design?.specParts ?? []).includes("Engine")

  return (
    <>
      <PageHeader title="Engine programme" description={<>{ch.name} · {season} season. Found your own engine, develop it, and sell it to other members.</>} />
      {demoMode && <Alert><AlertDescription>Engine programmes work on the live site only.</AlertDescription></Alert>}
      {specEngine && (
        <Alert>
          <Lock />
          <AlertDescription>
            Engines are a spec part in this championship, so a works engine doesn't race here yet. You can build the programme up now;
            it counts once the league races in a series where engines aren't spec.
          </AlertDescription>
        </Alert>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {mine
        ? <Programme me={me.team} programme={mine} plan={d.plans.find((p) => p.team === me.team && p.season === season)} builds={d.builds.filter((b) => b.team === me.team)}
            customers={d.customers.filter((c) => c.owner === me.team)} season={season} busy={busy} run={run} />
        : <Found busy={busy} run={run} />}
      <Market programmes={d.programmes} customers={d.customers} me={me.team} season={season} busy={busy} run={run} />
    </>
  )
}

type Run = (key: string, fn: () => PromiseLike<unknown>) => Promise<void>

function Found({ busy, run }: { busy: string | null; run: Run }) {
  const [name, setName] = useState("")
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Factory className="size-4" /> Found an engine programme</CardTitle>
        <CardDescription>
          A long-term investment of {fmtMoney(ENGINE_SETTINGS.foundingCost)}. Each season you choose a concept, buy development points
          (each costs $1M more than the last that season) and fund research projects. At the season change your engine is built and
          becomes a real supplier in MM for your team and the members who buy it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Engine name, e.g. Tatra Power" className="max-w-72" />
        <Button disabled={name.trim().length < 2 || busy != null} onClick={() => void run("found", () => supabase!.rpc("found_engine_programme", { name: name.trim() }))}>
          {busy === "found" ? <Loader2 className="animate-spin" /> : <Factory />} Found for {fmtMoneyShort(ENGINE_SETTINGS.foundingCost)}
        </Button>
      </CardContent>
    </Card>
  )
}

function Programme({ me, programme, plan, builds, customers, season, busy, run }: {
  me: string; programme: Programme; plan: Plan | undefined; builds: Build[]; customers: Customer[]; season: number; busy: string | null; run: Run
}) {
  const { league } = useLeague()
  const last = builds[0]
  const start = last ? carryOver(last.legal) : ENGINE_SETTINGS.newEngine
  const p: Plan = plan ?? { team: me, season, concept: "balanced", points: { power: 0, fuel: 0, improvability: 0, tyres: 0 }, projects: [] }
  const bought = Object.values(p.points).reduce((a, b) => a + b, 0)
  const projected = developEngine(start, p)
  const lead = league.snapshot.teams.find((t) => t.name === me)?.staff.find((s) => s.job === "EngineerLead")?.person
  const skill = lead ? statAverage(lead.stats) : 0
  const dc = league.privateTeams[me]?.hq.find((b) => b.type === 0)?.level ?? 0
  const [price, setPrice] = useState(String(programme.customer_price))
  const [detuned, setDetuned] = useState(programme.customer_detuned)

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Fan className="size-4" /> {programme.name}</CardTitle>
          <CardDescription>Founded {programme.founded_season}. {last ? `Last built for ${last.season + 1}.` : "Your first engine is built at the next season change."}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2 md:grid-cols-3">
            {(Object.keys(CONCEPTS) as EngineConcept[]).map((c) => (
              <button key={c} type="button" disabled={busy != null}
                onClick={() => void run(`concept${c}`, () => supabase!.rpc("set_engine_concept", { concept: c }))}
                className={cn("flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60", p.concept === c && "border-primary bg-primary/10")}>
                <span className="text-sm font-medium">{CONCEPTS[c].name}</span>
                <span className="text-xs text-muted-foreground">{CONCEPTS[c].description}</span>
                <span className="text-xs tabular-nums text-muted-foreground">+{CONCEPTS[c].levelPerPoint} level per power point · stats ±{CONCEPTS[c].statCap} max</span>
              </button>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <EngineStatsView e={start} label={last ? "This season's starting point (80 % of last season's engine)" : "A new engine"} />
            <EngineStatsView e={projected} label="After this season's development (before research)" />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Development points this season: {bought}. Next point costs {fmtMoneyShort(pointsCost(bought, 1))}. More power costs fuel and tyre wear.
            </span>
            {AREAS.map(({ area, label, icon: Icon }) => (
              <div key={area} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm">
                <Icon className="size-4 text-muted-foreground" /><span className="flex-1">{label}</span>
                <span className="tabular-nums text-muted-foreground">{p.points[area]} points</span>
                {[1, 5].map((n) => (
                  <Button key={n} size="sm" variant="outline" disabled={busy != null}
                    onClick={() => void run(`${area}${n}`, () => supabase!.rpc("buy_engine_points", { area, n }))}>
                    <Plus /> {n} · {fmtMoneyShort(pointsCost(bought, n))}
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FlaskConical className="size-4" /> Research projects</CardTitle>
          <CardDescription>Rolled at the season change. Your lead engineer and Design Centre raise the odds. Illegal projects only ever go into your works engine.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {PROJECTS.map((pr) => {
            const running = p.projects.includes(pr.id)
            const fx = (o: Partial<EngineStats>) => Object.entries(o).map(([k, v]) => `${k === "level" ? "engine level" : k === "tyreWear" ? "tyre wear" : k} ${v! > 0 ? "+" : ""}${v}`).join(", ")
            return (
              <div key={pr.id} className={cn("flex flex-col gap-1.5 rounded-lg border p-3", pr.illegal && "border-destructive/40", running && "bg-primary/5")}>
                <span className="flex items-center gap-2 text-sm font-medium">{pr.illegal && <Siren className="size-4 text-destructive" />}{pr.name}</span>
                <span className="text-xs text-muted-foreground">{pr.description}</span>
                <span className="text-xs">Success ({fmtPct(projectChance(pr, skill, dc))}): {fx(pr.success)} · failure: {fx(pr.failure)}</span>
                {pr.illegal && <span className="text-xs text-destructive">Caught after a race: {fmtPct(illegalDetection(pr, 1))} the first race, +{fmtPct(pr.illegal.growthPerRace)} each race. If caught: back to the legal engine, that race's points lost, and a fine.</span>}
                <Button size="sm" variant={running ? "secondary" : "outline"} className="self-start" disabled={running || busy != null}
                  onClick={() => void run(pr.id, () => supabase!.rpc("choose_engine_project", { project_id: pr.id }))}>
                  <Coins /> {running ? "Running this season" : `Fund for ${fmtMoneyShort(pr.cost)}`}
                </Button>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Store className="size-4" /> Customer engines</CardTitle>
          <CardDescription>Sell your legal engine to other members for next season. A detuned spec has {Math.round(ENGINE_SETTINGS.customerDetune * 100)} % of its engine level.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">Price <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" className="h-8 w-32" /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={detuned} onChange={(e) => setDetuned(e.target.checked)} /> Detuned customer spec</label>
          <Button size="sm" disabled={busy != null}
            onClick={() => void run("offer", () => supabase!.rpc("set_engine_offer", { offering: true, price: Number(price.replace(/[^\d]/g, "")) || 0, detuned }))}>
            {programme.offering ? "Update offer" : "Offer engines"}
          </Button>
          {programme.offering && <Button size="sm" variant="ghost" disabled={busy != null}
            onClick={() => void run("offoff", () => supabase!.rpc("set_engine_offer", { offering: false, price: programme.customer_price, detuned: programme.customer_detuned }))}>Stop selling</Button>}
          <span className="w-full text-muted-foreground">{customers.length ? `Customers: ${customers.map((c) => `${c.customer} (${c.season})`).join(", ")}` : "No customers yet."}</span>
        </CardContent>
      </Card>
    </>
  )
}

function Market({ programmes, customers, me, season, busy, run }: { programmes: Programme[]; customers: Customer[]; me: string; season: number; busy: string | null; run: Run }) {
  const bought = customers.find((c) => c.customer === me && c.season === season + 1)
  const offers = programmes.filter((p) => p.offering && p.team !== me)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ShoppingCart className="size-4" /> Member engines for {season + 1}</CardTitle>
        <CardDescription>Buy another member's engine for next season. It's paid at the next apply and fitted at the season change.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {bought && <Badge className="self-start">You run the {programmes.find((p) => p.team === bought.owner)?.name} engine in {bought.season}</Badge>}
        {offers.length ? offers.map((p) => (
          <div key={p.team} className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2">
            <Fan className="size-4 text-muted-foreground" /><span className="flex-1"><b className="font-medium">{p.name}</b> by {p.team}{p.customer_detuned ? " · detuned spec" : " · full spec"}</span>
            <span className="tabular-nums">{fmtMoney(p.customer_price)}</span>
            <Button size="sm" disabled={!!bought || busy != null} onClick={() => void run(`buy${p.team}`, () => supabase!.rpc("buy_engine", { owner: p.team }))}>Buy</Button>
          </div>
        )) : <span className="text-muted-foreground">No member sells engines yet.</span>}
      </CardContent>
    </Card>
  )
}
