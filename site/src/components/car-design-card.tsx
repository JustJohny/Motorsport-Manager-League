import { ChevronsUp, Circle, Coins, Fuel, Loader2, PiggyBank, SlidersHorizontal, Thermometer, type LucideIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { chassisStats, clampSlider, INVESTMENT_LEVELS, sliderRange, type ChassisResult } from "../../../src/chassis.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fmtMoneyShort } from "@/lib/format"
import { demoMode, supabase, watchTable } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { SupplierOffer, TeamPrivate } from "@/lib/types"

type Car = NonNullable<NonNullable<TeamPrivate["design"]>["nextYearCar"]>

function useCarChoices(team: string, season: number) {
  const [chassis, setChassis] = useState<{ nose: number; rear: number } | null>(null)
  const [level, setLevel] = useState<number | null>(null)
  const reload = useCallback(async () => {
    if (demoMode) return
    const [c, i] = await Promise.all([
      supabase!.from("chassis_choices").select("*").eq("team", team).eq("season", season).maybeSingle(),
      supabase!.from("car_investment").select("*").eq("team", team).maybeSingle(),
    ])
    setChassis(c.data ? { nose: Number(c.data.nose), rear: Number(c.data.rear) } : null)
    setLevel(i.data ? Number(i.data.level) : null)
  }, [team, season])
  useEffect(() => {
    if (demoMode) return
    void reload()
    const ch = supabase!.channel(`car-${team}`)
    watchTable(ch, "chassis_choices", () => void reload())
    watchTable(ch, "car_investment", () => void reload())
    ch.subscribe()
    return () => void supabase!.removeChannel(ch)
  }, [reload, team])
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { error } = await supabase!.rpc(fn, args)
    if (error) throw new Error(error.message)
    await reload()
  }
  return {
    chassis, level,
    saveChassis: (nose: number, rear: number) => (demoMode ? Promise.resolve(setChassis({ nose, rear })) : rpc("set_chassis", { nose, rear })),
    saveLevel: (l: number) => (demoMode ? Promise.resolve(setLevel(l)) : rpc("set_car_investment", { level: l })),
  }
}

const STATS: { key: keyof ChassisResult; label: string; icon: LucideIcon }[] = [
  { key: "fuelEfficiency", label: "Fuel efficiency", icon: Fuel },
  { key: "tyreWear", label: "Tyre wear", icon: Circle },
  { key: "improvability", label: "Improvability", icon: ChevronsUp },
  { key: "tyreHeating", label: "Tyre heating", icon: Thermometer },
]

/**
 * MM's car design sliders and the car fund, under the supplier picks. `suppliers` = what the car
 * will get (the member's picks, else MM's).
 */
export function CarDesignCard({ car, team, own, editable, suppliers }: { car: Car; team: string; own: boolean; editable: boolean; suppliers: SupplierOffer[] }) {
  const c = useCarChoices(team, car.season)
  const sups = suppliers.map((s) => ({ type: s.type, stats: s.stats, minBound: s.minBound, maxBound: s.maxBound }))
  const range = sliderRange(sups)
  const [nose, setNose] = useState(0.5)
  const [rear, setRear] = useState(0.5)
  useEffect(() => { if (c.chassis) { setNose(c.chassis.nose); setRear(c.chassis.rear) } }, [c.chassis])
  const n = clampSlider(nose, range.nose), r = clampSlider(rear, range.rear)
  const base = chassisStats(sups), mine = chassisStats(sups, n, r)
  const dirty = !c.chassis || Math.abs(c.chassis.nose - nose) > 1e-3 || Math.abs(c.chassis.rear - rear) > 1e-3
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const inv = car.investment
  const level = c.level ?? inv?.level ?? 1

  const slider = (label: string, left: string, right: string, value: number, set: (v: number) => void, [lo, hi]: [number, number]) => (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{left}</span><span className="font-medium text-foreground">{label}</span><span>{right}</span></div>
      <div className="relative">
        <input type="range" min={0} max={1} step={0.01} value={value} disabled={!editable || !car.chassisDesign}
          onChange={(e) => set(clampSlider(Number(e.target.value), [lo, hi]))} className="w-full accent-primary disabled:opacity-60" aria-label={label} />
      </div>
      <div className="text-[11px] text-muted-foreground">
        {hi - lo < 0.005 ? "Your suppliers leave no room on this slider: it stays where MM's AI would put it" : `Your suppliers allow ${Math.round(lo * 100)}–${Math.round(hi * 100)} %`}
      </div>
    </div>
  )

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="size-4" /> Car design for {car.season}</CardTitle>
          <CardDescription>
            MM's two design sliders: nose height trades fuel efficiency against tyre wear, the rear package improvability against tyre
            heating, ±5 around the middle (which is the car MM's AI would build). Your suppliers narrow how far each can go and add their
            own stats. Applied at pre-season with your suppliers.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!car.chassisDesign ? (
            <Alert><AlertDescription>MM only lets teams in the main championship shape their chassis; this series gets the default car.</AlertDescription></Alert>
          ) : (
            <>
              {slider("Nose height", "Tyre wear", "Fuel efficiency", n, setNose, range.nose)}
              {slider("Rear package", "Tyre heating", "Improvability", r, setRear, range.rear)}
            </>
          )}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {STATS.map(({ key, label, icon: Icon }) => {
              const d = mine[key] - base[key]
              return (
                <div key={key} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 tabular-nums">
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{label}</span>
                  <span className="ml-auto">{base[key].toFixed(1)}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className={cn("font-medium", d > 0.05 && "text-emerald-600 dark:text-emerald-400", d < -0.05 && "text-red-600 dark:text-red-400")}>{mine[key].toFixed(1)}</span>
                </div>
              )
            })}
          </div>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {own && car.chassisDesign && (
            <div className="flex gap-2">
              <Button size="sm" disabled={!editable || !dirty || !!busy} onClick={() => void run("c", () => c.saveChassis(n, r))}>
                {busy === "c" && <Loader2 className="animate-spin" />} {c.chassis ? "Save design" : "Use this design"}
              </Button>
              <Button size="sm" variant="ghost" disabled={!editable || !!busy} onClick={() => { setNose(0.5); setRear(0.5) }}>Middle (MM's default)</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><PiggyBank className="size-4" /> Car fund</CardTitle>
          <CardDescription>
            As in MM's finances: every month this much moves from your budget into next year's car fund, and the fund comes back to your
            budget when MM designs the car, to pay for the suppliers. It changes when the money leaves, not how good the car is.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {inv && <div className="flex items-center gap-1.5 text-sm tabular-nums"><Coins className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Saved so far</span> {fmtMoneyShort(inv.fund)}</div>}
          <div className="grid grid-cols-3 gap-2">
            {INVESTMENT_LEVELS.map((l, i) => (
              <Button key={l} variant={i === level ? "default" : "outline"} disabled={!own || !!busy || i === level}
                onClick={() => void run(`l${i}`, () => c.saveLevel(i))} className="h-auto flex-col py-2">
                <span>{busy === `l${i}` ? <Loader2 className="animate-spin" /> : l}</span>
                {inv && <span className="text-xs opacity-80 tabular-nums">{fmtMoneyShort(inv.monthly[i])}/month</span>}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Applied at every pull. MM's default is Medium.</p>
        </CardContent>
      </Card>
    </div>
  )
}
