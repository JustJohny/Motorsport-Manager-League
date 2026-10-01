import {
  BatteryCharging, CalendarClock, Check, ChevronsUp, Circle, Coins, Disc3, Fan, Flame, Fuel, Gauge, Layers, Loader2, Lock,
  RotateCcw, Settings2, Thermometer, Zap, type LucideIcon,
} from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { SUPPLIER_STATS, supplierWindow } from "../../../src/supplier-rules.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fmtMoneyShort, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { demoMode, supabase, watchTable } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { SupplierOffer, TeamPrivate } from "@/lib/types"

const TYPE_ICONS: Record<string, LucideIcon> = {
  Engine: Fan, Brakes: Disc3, Fuel: Fuel, Materials: Layers, Battery: BatteryCharging, ERSAdvanced: Zap,
}
const TYPE_LABELS: Record<string, string> = { ERSAdvanced: "ERS" }
const STAT_ICONS: Record<number, LucideIcon> = { 0: Circle, 1: Thermometer, 2: Fuel, 3: ChevronsUp, 4: BatteryCharging, 5: Flame }

interface Choice { team: string; season: number; supplier_type: string; supplier_id: number }

function useSupplierChoices(team: string, season: number) {
  const [rows, setRows] = useState<Choice[]>([])
  const reload = useCallback(async () => {
    if (demoMode) return
    const { data, error } = await supabase!.from("supplier_choices").select("*").eq("team", team).eq("season", season)
    if (error) throw new Error(error.message)
    setRows((data ?? []) as Choice[])
  }, [team, season])
  useEffect(() => {
    if (demoMode) return
    void reload()
    const ch = watchTable(supabase!.channel(`suppliers-${team}`), "supplier_choices", () => void reload()).subscribe()
    return () => void supabase!.removeChannel(ch)
  }, [reload, team])

  const call = async (fn: string, args: Record<string, unknown>, local: (r: Choice[]) => Choice[]) => {
    if (demoMode) return setRows(local)
    const { error } = await supabase!.rpc(fn, args)
    if (error) throw new Error(error.message)
    await reload()
  }
  return {
    rows,
    choose: (type: string, id: number) => call("choose_supplier", { supplier_type: type, supplier_id: id },
      (r) => [...r.filter((c) => c.supplier_type !== type), { team, season, supplier_type: type, supplier_id: id }]),
    clear: (type: string) => call("clear_supplier_choice", { supplier_type: type }, (r) => r.filter((c) => c.supplier_type !== type)),
  }
}

/** Members choose MM's suppliers for next year's car; the pull puts them on the car MM designs at pre-season. */
export function NextSeasonCard({ priv, team, own }: { priv: TeamPrivate; team: string; own: boolean }) {
  const { league } = useLeague()
  const car = priv.design?.nextYearCar
  if (!car?.season) {
    return <Alert><AlertDescription>Next season's suppliers appear after the organizer's next publish.</AlertDescription></Alert>
  }
  return <SupplierChoices priv={priv} team={team} own={own} calendar={league.snapshot.championship.calendar} />
}

function SupplierChoices({ priv, team, own, calendar }: { priv: TeamPrivate; team: string; own: boolean; calendar: { ended: boolean }[] }) {
  const car = priv.design!.nextYearCar!
  const s = useSupplierChoices(team, car.season)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const win = supplierWindow(calendar, car.state, car.options)
  const editable = own && win.status === "open"
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const types = Object.keys(car.options)
  const specEngine = (priv.design?.specParts ?? []).includes("Engine")
  // What the car gets: the choice, else this season's supplier if it's still on offer (else MM's AI picks).
  const picked = (type: string) => {
    const offered = (id?: number) => car.options[type].find((o) => o.id === id)
    return offered(s.rows.find((c) => c.supplier_type === type)?.supplier_id) ?? offered(car.current[type]?.id) ?? null
  }
  const bill = (pick: (t: string) => SupplierOffer | null | undefined) => types.reduce((a, t) => a + (pick(t)?.price ?? 0), 0)
  const status = {
    closed: { icon: Lock, text: `MM offers next season's suppliers after the final race (${win.racesLeft} race${win.racesLeft === 1 ? "" : "s"} to go)` },
    open: car.state === "designing"
      ? { icon: CalendarClock, text: `MM is designing your ${car.season} car: choices are applied at every pull until it's built` }
      : { icon: CalendarClock, text: "Open: applied at the pre-season checkpoint, when MM starts next year's car" },
    done: { icon: Check, text: `Your ${car.season} car is built` },
  }[win.status]

  return (
    <div className="flex flex-col gap-4">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Settings2 className="size-4" /> Suppliers for {car.season}</CardTitle>
          <CardDescription>
            As in MM's car design screen: after the final race MM offers each championship a few deals per supplier type, and they set
            next year's chassis stats; the engine supplier also adds to the engine level. No choice keeps this season's supplier if MM
            offers it again, otherwise MM's AI picks. Each one is paid at MM's price for your team when it's applied at pre-season.
            Choices are private; the organizer sees them too.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm tabular-nums">
            <Badge variant={win.status === "open" ? "default" : "secondary"} className="h-auto gap-1.5 whitespace-normal text-left"><status.icon /> {status.text}</Badge>
            <span className="flex items-center gap-1.5"><Coins className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">This season's suppliers</span> {fmtMoneyShort(bill((t) => car.current[t]))}</span>
            <span className="flex items-center gap-1.5 font-medium"><Coins className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">Next season</span> {fmtMoneyShort(bill(picked))}</span>
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      {types.map((type) => {
        const Icon = TYPE_ICONS[type] ?? Settings2
        const current = car.current[type]
        const choice = s.rows.find((c) => c.supplier_type === type)?.supplier_id
        const chosen = picked(type)
        const currentOffered = car.options[type].some((o) => o.id === current?.id)
        return (
          <section key={type} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">{TYPE_LABELS[type] ?? humanize(type)}</h3>
              <span className="text-xs text-muted-foreground">
                {chosen ? `${car.season}: ${chosen.name}` : "MM's AI picks"}
                {current && !currentOffered && ` · ${current.name} isn't on offer to you any more`}
              </span>
              {choice != null && editable && (
                <Button size="sm" variant="ghost" className="ml-auto" disabled={busy != null} onClick={() => void run(`clear${type}`, () => s.clear(type))}>
                  {busy === `clear${type}` ? <Loader2 className="animate-spin" /> : <RotateCcw />} Keep this season's
                </Button>
              )}
            </div>
            {type === "Engine" && specEngine && (
              <p className="text-xs text-muted-foreground">Engines are a spec part in this championship, so only the engine supplier's chassis stats count, not its engine level.</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {dealNames(car.options[type]).map(({ o, name }) => (
                <SupplierOption key={o.id} o={o} name={name} current={current} selected={chosen?.id === o.id} isCurrent={current?.id === o.id}
                  disabled={!editable || busy != null || chosen?.id === o.id} busy={busy === `${type}${o.id}`}
                  onChoose={() => void run(`${type}${o.id}`, () => o.id === current?.id ? s.clear(type) : s.choose(type, o.id))} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/** MM has several deals per supplier (Micronix Racing makes every brake): number repeated names, cheapest first. */
function dealNames(options: SupplierOffer[]) {
  const sorted = [...options].sort((a, b) => a.price - b.price || a.id - b.id)
  const count = new Map<string, number>(), seen = new Map<string, number>()
  for (const o of sorted) count.set(o.name, (count.get(o.name) ?? 0) + 1)
  return sorted.map((o) => {
    const n = (seen.get(o.name) ?? 0) + 1
    seen.set(o.name, n)
    return { o, name: count.get(o.name)! > 1 ? `${o.name} · deal ${n}` : o.name }
  })
}

function SupplierOption({ o, name, current, selected, isCurrent, disabled, busy, onChoose }: {
  o: SupplierOffer; name: string; current?: SupplierOffer; selected: boolean; isCurrent: boolean; disabled: boolean; busy: boolean; onChoose: () => void
}) {
  // Energy stats (4, 5) are zero outside hybrid series.
  const keys = [...new Set([...Object.keys(o.stats), ...Object.keys(current?.stats ?? {})].map(Number))].sort()
    .filter((k) => k < 4 || o.stats[k] || current?.stats[k])
  const level = (l: [number, number]) => (l[0] === l[1] ? `+${l[0]}` : `+${l[0]}–${l[1]}`)
  const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v)}`
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border p-3", selected && "border-primary bg-primary/5")}>
      <div className="flex items-start gap-2">
        <span className="flex-1 text-sm font-medium">{name}</span>
        {isCurrent && <Badge variant="outline">This season</Badge>}
        {selected && <Badge><Check /> {isCurrent ? "Kept" : "Chosen"}</Badge>}
      </div>
      <div className="flex flex-col gap-1 text-xs tabular-nums">
        <span className="flex items-center gap-1.5"><Coins className="size-3.5 text-muted-foreground" /> {fmtMoneyShort(o.price)}
          {current && !isCurrent && <Delta v={current.price - o.price} fmt={(v) => fmtMoneyShort(Math.abs(v))} />}</span>
        {o.engineLevel && (
          <span className="flex items-center gap-1.5"><Gauge className="size-3.5 text-muted-foreground" /> Engine level {level(o.engineLevel)}
            {current?.engineLevel && !isCurrent && <Delta v={o.engineLevel[0] - current.engineLevel[0]} fmt={(d) => String(Math.abs(d))} />}</span>
        )}
        {keys.map((k) => {
          const StatIcon = STAT_ICONS[k] ?? Settings2
          const v = o.stats[k] ?? 0
          return (
            <span key={k} className="flex items-center gap-1.5">
              <StatIcon className="size-3.5 text-muted-foreground" /> {SUPPLIER_STATS[k] ?? `Stat ${k}`} {signed(v)}
              {current && !isCurrent && <Delta v={v - (current.stats[k] ?? 0)} fmt={(d) => String(Math.abs(d))} />}
            </span>
          )
        })}
      </div>
      <Button size="sm" variant={selected ? "secondary" : "outline"} className="mt-auto self-start" disabled={disabled} onClick={onChoose}>
        {busy ? <Loader2 className="animate-spin" /> : selected ? <Check /> : null}
        {selected ? "On your car" : isCurrent ? "Keep" : "Choose"}
      </Button>
    </div>
  )
}

/** Change against this season's supplier: positive is better for the team. */
function Delta({ v, fmt }: { v: number; fmt: (v: number) => string }) {
  if (!v) return <span className="text-muted-foreground">(same)</span>
  return <span className={v > 0 ? "text-emerald-500" : "text-red-500"}>({v > 0 ? "▲" : "▼"} {fmt(v)})</span>
}
