import { Building2, Car, Coins, HardHat, Loader2, RotateCcw, Scale, SignalHigh, SignalLow, SignalMedium, Timer, User, Wrench, X, type LucideIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { fieldDefaults, presetSettings, type Preset } from "../../../src/equalize.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fmtMoneyShort, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { demoMode, supabase, watchTable } from "@/lib/supabase"
import { cn } from "@/lib/utils"
import type { EqualizeSettings } from "@/lib/types"

type Area = "budget" | "hq" | "parts" | "leadDesigner" | "mechanics" | "pitCrew"
const AREAS: { key: Area; label: string; icon: LucideIcon }[] = [
  { key: "budget", label: "Budget", icon: Coins },
  { key: "hq", label: "HQ", icon: Building2 },
  { key: "parts", label: "Car parts", icon: Car },
  { key: "leadDesigner", label: "Lead designer", icon: HardHat },
  { key: "mechanics", label: "Mechanics", icon: Wrench },
  { key: "pitCrew", label: "Pit crew", icon: Timer },
]

interface Queued { id: number; settings: EqualizeSettings; created_at: string }

/** A small labelled number field. */
function Num({ label, value, onChange, step = 0.1, min = 0, max, suffix }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1">
        <Input type="number" inputMode="decimal" className="h-8 tabular-nums" value={Number.isFinite(value) ? value : ""} step={step} min={min} max={max}
          onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />
        {suffix && <span className="text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  )
}

function Section({ area, on, onToggle, children }: { area: (typeof AREAS)[number]; on: boolean; onToggle: () => void; children: ReactNode }) {
  const Icon = area.icon
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-3", !on && "opacity-50")}>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={on} onChange={onToggle} className="size-4 accent-primary" />
        <Icon className="size-4 text-muted-foreground" /> {area.label}
        {!on && <span className="text-xs font-normal text-muted-foreground">left as it is</span>}
      </label>
      {on && children}
    </div>
  )
}

export function EqualizeCard() {
  const { league } = useLeague()
  const snap = league.snapshot
  const teams = useMemo(() => snap.teams.map((pub) => ({ pub, priv: league.privateTeams[pub.name] })), [snap, league.privateTeams])
  const defaults = useMemo(() => fieldDefaults(teams, snap.championship.pitCrew?.aiLevel ?? 10), [teams, snap])
  const [s, setS] = useState<EqualizeSettings>(defaults)
  const [on, setOn] = useState<Record<Area, boolean>>({ budget: true, hq: true, parts: true, leadDesigner: true, mechanics: true, pitCrew: true })
  const [preset, setPreset] = useState<Preset | "field" | null>("field")
  const [queued, setQueued] = useState<Queued | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const maxLevel = (name: string) => Math.max(1, ...teams.flatMap((t) => t.priv?.hq.filter((b) => b.name === name).map((b) => b.maxLevel) ?? []))

  const reload = useCallback(async () => {
    if (demoMode) return
    const { data, error } = await supabase!.from("equalize_orders").select("id, settings, created_at").eq("status", "queued").maybeSingle()
    if (!error) setQueued((data as Queued | null) ?? null)
  }, [])
  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("equalize")
    watchTable(channel, "equalize_orders", () => void reload())
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  // Only the areas switched on; car parts bring the development rate with them.
  const chosen: EqualizeSettings = {
    ...(on.budget ? { budget: s.budget } : {}),
    ...(on.hq ? { hq: s.hq } : {}),
    ...(on.parts ? { parts: s.parts, ...(s.developmentRate !== undefined ? { developmentRate: s.developmentRate } : {}) } : {}),
    ...(on.leadDesigner ? { leadDesigner: s.leadDesigner } : {}),
    ...(on.mechanics ? { mechanics: s.mechanics } : {}),
    ...(on.pitCrew ? { pitCrew: s.pitCrew } : {}),
  }
  const invalid = JSON.stringify(chosen).includes("null") || !Object.keys(chosen).length

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const queue = () => run(async () => {
    if (demoMode) return setQueued({ id: 1, settings: chosen, created_at: new Date().toISOString() })
    const { error } = await supabase!.rpc("queue_equalize", { settings: chosen })
    if (error) throw new Error(error.message)
    await reload()
  })
  const cancel = () => run(async () => {
    if (demoMode) return setQueued(null)
    const { error } = await supabase!.rpc("cancel_equalize")
    if (error) throw new Error(error.message)
    await reload()
  })
  const setStat = (group: "leadDesigner" | "mechanics", k: string, v: number) => setS((x) => ({ ...x, [group]: { ...x[group], [k]: v } }))
  const avgOf = (r?: Record<string, number | null>) => { const v = Object.values(r ?? {}).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Scale className="size-4" /> Equalize the field</CardTitle>
        <CardDescription>
          Usually at the start of a league: every team in the championship, AI and members, gets the same values below. Drivers keep their own stats.
          It's applied at the next pull and apply, before members' own orders. Running part designs are cancelled, constructions stop
          (no refund: budgets are set anyway), every part of a designable type gets the stats below (spec parts stay the supplier's),
          and member pit crews restart as equal crews at the skill below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {queued && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <Badge>Queued</Badge>
            <span>Equalization of {AREAS.filter((a) => a.key in queued.settings).map((a) => a.label).join(", ")} waits for the next pull.</span>
            <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void cancel()}><X /> Cancel</Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Start from</span>
          {(["low", "medium", "high"] as Preset[]).map((p) => (
            <Button key={p} size="sm" variant={preset === p ? "default" : "outline"} onClick={() => { setS(presetSettings(p, defaults, maxLevel)); setPreset(p) }}>
              {p === "low" ? <SignalLow /> : p === "medium" ? <SignalMedium /> : <SignalHigh />} {p[0].toUpperCase() + p.slice(1)}
            </Button>
          ))}
          <Button size="sm" variant={preset === "field" ? "default" : "outline"} onClick={() => { setS(defaults); setPreset("field") }}><RotateCcw /> Field averages</Button>
          <span className="text-xs text-muted-foreground">then adjust any value.</span>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          <Section area={AREAS[0]} on={on.budget} onToggle={() => setOn((o) => ({ ...o, budget: !o.budget }))}>
            <Num label="Budget ($)" value={s.budget ?? NaN} step={100000} onChange={(v) => setS((x) => ({ ...x, budget: v }))} />
          </Section>

          <Section area={AREAS[5]} on={on.pitCrew} onToggle={() => setOn((o) => ({ ...o, pitCrew: !o.pitCrew }))}>
            <div className="grid grid-cols-2 gap-2">
              <Num label="Skill (0-20)" value={s.pitCrew?.skill ?? NaN} max={20} onChange={(v) => setS((x) => ({ ...x, pitCrew: { ...x.pitCrew!, skill: v } }))} />
              <Num label="Confidence (%)" value={Math.round((s.pitCrew?.confidence ?? NaN) * 100)} step={1} max={100}
                onChange={(v) => setS((x) => ({ ...x, pitCrew: { ...x.pitCrew!, confidence: v / 100 } }))} />
            </div>
            <p className="text-xs text-muted-foreground">AI crews' task values; MM rebuilds them from the mechanics' Pit stops after each race, so set that the same.</p>
          </Section>

          <Section area={AREAS[1]} on={on.hq} onToggle={() => setOn((o) => ({ ...o, hq: !o.hq }))}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(s.hq ?? {}).map(([name, level]) => (
                <Num key={name} label={name} value={level} step={1} max={maxLevel(name)} suffix={`/${maxLevel(name)}`}
                  onChange={(v) => setS((x) => ({ ...x, hq: { ...x.hq, [name]: v } }))} />
              ))}
            </div>
            <p className="text-xs text-muted-foreground">0 = not built.</p>
          </Section>

          <Section area={AREAS[2]} on={on.parts} onToggle={() => setOn((o) => ({ ...o, parts: !o.parts }))}>
            {Object.entries(s.parts ?? {}).map(([type, v]) => {
              const set = (k: keyof typeof v, val: number) => setS((x) => ({ ...x, parts: { ...x.parts, [type]: { ...x.parts![type], [k]: val } } }))
              return (
                <div key={type} className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">{humanize(type)}</span>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                    <Num label="Performance" value={v.stat} onChange={(n) => set("stat", n)} />
                    <Num label="Max perf." value={v.maxPerformance} onChange={(n) => set("maxPerformance", n)} />
                    <Num label="Reliability %" value={Math.round(v.reliability * 1000) / 10} max={100} onChange={(n) => set("reliability", n / 100)} />
                    <Num label="Max rel. %" value={Math.round(v.maxReliability * 1000) / 10} max={100} onChange={(n) => set("maxReliability", n / 100)} />
                    <Num label="Level" value={v.level ?? 1} step={1} min={1} max={5} onChange={(n) => set("level", n)} />
                  </div>
                </div>
              )
            })}
            <Num label="Development rate (component boosts ×)" value={s.developmentRate ?? NaN} step={0.01} onChange={(v) => setS((x) => ({ ...x, developmentRate: v }))} />
          </Section>

          <Section area={AREAS[3]} on={on.leadDesigner} onToggle={() => setOn((o) => ({ ...o, leadDesigner: !o.leadDesigner }))}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(s.leadDesigner ?? {}).map(([k, v]) => <Num key={k} label={humanize(k)} value={v} max={20} onChange={(n) => setStat("leadDesigner", k, n)} />)}
            </div>
          </Section>

          <Section area={AREAS[4]} on={on.mechanics} onToggle={() => setOn((o) => ({ ...o, mechanics: !o.mechanics }))}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(s.mechanics ?? {}).map(([k, v]) => <Num key={k} label={humanize(k)} value={v} max={20} onChange={(n) => setStat("mechanics", k, n)} />)}
            </div>
          </Section>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead className="text-right"><Coins className="inline size-3.5" /> Budget</TableHead>
                <TableHead className="text-right"><Building2 className="inline size-3.5" /> HQ levels</TableHead>
                <TableHead className="text-right"><HardHat className="inline size-3.5" /> Designer avg</TableHead>
                <TableHead className="text-right"><User className="inline size-3.5" /> Mechanics avg</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map(({ pub, priv }) => {
                const hqNow = priv?.hq.reduce((sum, b) => sum + b.level, 0) ?? null
                const hqNew = on.hq ? Object.values(s.hq ?? {}).reduce((a, b) => a + b, 0) : hqNow
                const des = avgOf(pub.staff.find((x) => x.job === "EngineerLead")?.person?.stats)
                const mechs = pub.staff.filter((x) => x.job === "Mechanic" && x.person).map((x) => avgOf(x.person!.stats) ?? 0)
                const mech = mechs.length ? mechs.reduce((a, b) => a + b, 0) / mechs.length : null
                const arrow = (now: string, next: string, changes: boolean) => changes && now !== next
                  ? <span className="tabular-nums"><span className="text-muted-foreground">{now} →</span> {next}</span> : <span className="tabular-nums">{now}</span>
                return (
                  <TableRow key={pub.name}>
                    <TableCell className="whitespace-nowrap font-medium">{pub.name}{pub.member && <Badge variant="outline" className="ml-2 text-[10px]">Member</Badge>}</TableCell>
                    <TableCell className="text-right">{arrow(priv?.budget != null ? fmtMoneyShort(priv.budget) : "?", fmtMoneyShort(s.budget ?? 0), on.budget)}</TableCell>
                    <TableCell className="text-right">{arrow(String(hqNow ?? "?"), String(hqNew), on.hq)}</TableCell>
                    <TableCell className="text-right">{arrow(des?.toFixed(1) ?? "—", (avgOf(s.leadDesigner) ?? 0).toFixed(1), on.leadDesigner)}</TableCell>
                    <TableCell className="text-right">{arrow(mech?.toFixed(1) ?? "—", (avgOf(s.mechanics) ?? 0).toFixed(1), on.mechanics)}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy || invalid} onClick={() => void queue()}>
            {busy ? <Loader2 className="animate-spin" /> : <Scale />} {queued ? "Replace the queued equalization" : "Queue for the next apply"}
          </Button>
          {invalid && <span className="text-xs text-destructive">Fill in every value of the areas you equalize.</span>}
        </div>
      </CardContent>
    </Card>
  )
}
