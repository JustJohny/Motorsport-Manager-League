import {
  AlertTriangle, ArrowLeftRight, ArrowUp, CalendarClock, CarFront, Lock, Loader2, Repeat, Settings2, Undo2, UserMinus, UserPlus, Users, Wrench,
  type LucideIcon,
} from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router"
import { SupplierOption } from "@/components/next-season-card"
import { dealNames, TYPE_ICONS, TYPE_LABELS } from "@/lib/suppliers"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fmtMoneyShort, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { SEAT_LABEL, usePreseason, type PreseasonMove, type Seat } from "@/lib/preseason"
import type { TeamPrivate } from "@/lib/types"

const SEAT_ICON: Record<Seat["role"], LucideIcon> = {
  car1: CarFront, car2: CarFront, reserve: Users, engineer: Settings2, mechanic: Wrench, other: Users,
}

/**
 * The league's pre-season (opened by the organizer): sign free agents straight away, rearrange the
 * team and pick this season's suppliers, all free. Moves are applied in order at the next pull.
 */
export function PreseasonTab({ team, priv, own }: { team: string; priv?: TeamPrivate; own: boolean }) {
  const { league } = useLeague()
  const pre = usePreseason()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lineup = pre.lineup(team)
  const career = league.snapshot.teams.find((t) => t.name === team)?.isPlayerTeam
  const editable = own && pre.open && !career
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const moves = pre.moves.filter((m) => m.team === team)
  if (!lineup) return null
  const reserve = lineup.seats.find((s) => s.role === "reserve" && s.person)
  const mechanics = lineup.seats.filter((s) => s.role === "mechanic" && (s.person ?? s.leaving))

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        {pre.open ? <CalendarClock /> : <Lock />}
        <AlertTitle>{pre.open ? "Pre-season is open" : "Pre-season is closed"}</AlertTitle>
        <AlertDescription>
          {career ? "The career team is managed in game."
            : pre.open ? "Sign free agents (first come wins, no fees, the market's opening wage), rearrange your team and pick this season's suppliers for free. Everything is applied in order at the organizer's next pull."
            : "The organizer opens the pre-season before the first race. Your line-up below is as published."}
        </AlertDescription>
      </Alert>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Users className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Line-up</h3>
          {editable && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy != null} onClick={() => navigate("/market")}><UserPlus /> Sign a free agent</Button>
              <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void run("cars", () => pre.move("swapCars"))}>
                {busy === "cars" ? <Loader2 className="animate-spin" /> : <ArrowLeftRight />} Swap cars
              </Button>
              <Button size="sm" variant="outline" disabled={busy != null || mechanics.length !== 2} onClick={() => void run("mech", () => pre.move("swapMechanics"))}>
                {busy === "mech" ? <Loader2 className="animate-spin" /> : <Repeat />} Swap mechanics
              </Button>
            </div>
          )}
        </div>
        <Card size="sm">
          <CardContent className="flex flex-col divide-y">
            {lineup.seats.filter((s) => s.role !== "other").map((s) => {
              const Icon = SEAT_ICON[s.role]
              const p = s.person
              return (
                <div key={s.slotID} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2">
                  <span className="flex w-32 items-center gap-1.5 text-sm text-muted-foreground"><Icon className="size-4" /> {SEAT_LABEL[s.role]}</span>
                  <span className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                    {p ? <span className="font-medium">{p.name}</span> : <span className="text-muted-foreground">Empty</span>}
                    {s.signed && <Badge><UserPlus /> Signed</Badge>}
                    {s.role === "mechanic" && p?.mechanicCar != null && <Badge variant="outline">Car {p.mechanicCar + 1}</Badge>}
                    {s.leaving && (
                      <Badge variant={s.required ? "destructive" : "secondary"} className="h-auto whitespace-normal">
                        {s.required ? <AlertTriangle /> : <UserMinus />}
                        {s.leaving.name} released{s.required ? ": stays unless you sign someone" : ""}
                      </Badge>
                    )}
                  </span>
                  {editable && p && (
                    <div className="flex flex-wrap gap-2">
                      {s.role === "reserve" && ["car1", "car2"].map((role, i) => {
                        const target = lineup.seats.find((x) => x.role === role)
                        const out = target?.person ?? target?.leaving
                        return out && (
                          <Button key={role} size="sm" variant="ghost" disabled={busy != null} onClick={() => void run(`up${i}`, () => pre.move("promote", p.guid, out.guid))}>
                            {busy === `up${i}` ? <Loader2 className="animate-spin" /> : <ArrowUp />} To car {i + 1}
                          </Button>
                        )
                      })}
                      <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => void run(`rel${p.guid}`, () => pre.move("release", p.guid))}>
                        {busy === `rel${p.guid}` ? <Loader2 className="animate-spin" /> : <UserMinus />} Release
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
        {editable && !reserve && <p className="text-xs text-muted-foreground">No reserve driver: sign a free agent into the empty reserve seat.</p>}
      </section>

      {(moves.length > 0 || lineup.invalid.size > 0) && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Waiting for the next pull</h3>
            {editable && moves.length > 0 && (
              <Button size="sm" variant="ghost" className="ml-auto" disabled={busy != null} onClick={() => void run("undo", pre.undo)}>
                {busy === "undo" ? <Loader2 className="animate-spin" /> : <Undo2 />} Undo last
              </Button>
            )}
          </div>
          <ol className="flex flex-col gap-1 text-sm">
            {moves.map((m, i) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-right text-muted-foreground tabular-nums">{i + 1}.</span>
                <span>{describe(m)}</span>
                {lineup.invalid.has(m.id) && <Badge variant="destructive"><AlertTriangle /> Skipped: {lineup.invalid.get(m.id)}</Badge>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {priv?.design?.currentCar && <ThisSeasonCar priv={priv} team={team} editable={editable} />}
    </div>
  )
}

function describe(m: PreseasonMove) {
  switch (m.kind) {
    case "sign": return `Sign ${m.person_name} for ${m.years} season${m.years === 1 ? "" : "s"} at ${fmtMoneyShort(Number(m.yearly_wage))}/yr${m.other_name ? `, replacing ${m.other_name}` : ""}`
    case "promote": return `Promote ${m.person_name} in place of ${m.other_name}`
    case "release": return `Release ${m.person_name}`
    case "swapCars": return "Swap the drivers' cars"
    case "swapMechanics": return "Swap the mechanics"
  }
}

/** This season's suppliers: any of the tier, free. A new engine moves the engine by the difference in engine level. */
function ThisSeasonCar({ priv, team, editable }: { priv: TeamPrivate; team: string; editable: boolean }) {
  const pre = usePreseason()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const car = priv.design!.currentCar!
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  // Energy systems only matter in hybrid series; MM still lists them.
  const types = Object.keys(car.options).filter((t) => car.current[t] || !["Battery", "ERSAdvanced"].includes(t))

  return (
    <section className="flex flex-col gap-3">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Settings2 className="size-4" /> This season's suppliers</CardTitle>
          <CardDescription>
            Pre-season only, and free: switch any supplier on your current car. The chassis stats follow the new supplier, as in MM's car screen.
            {car.specEngine
              ? " Engines are a spec part here, so a new engine changes the chassis stats only."
              : " A new engine also moves your engine parts by the difference in engine level (MM otherwise adds it when next year's car is built)."}
            {" "}Picks are private and applied at the next pull.
          </CardDescription>
        </CardHeader>
        {error && <CardContent><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></CardContent>}
      </Card>
      {types.map((type) => {
        const Icon = TYPE_ICONS[type] ?? Settings2
        const current = car.current[type]
        const pick = pre.picks.find((p) => p.team === team && p.supplier_type === type)
        const chosen = car.options[type].find((o) => o.id === pick?.supplier_id) ?? current
        return (
          <div key={type} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Icon className="size-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">{TYPE_LABELS[type] ?? humanize(type)}</h4>
              <span className="text-xs text-muted-foreground">{pick ? `${current?.name ?? "none"} → ${pick.supplier_name}` : `Keeping ${current?.name ?? "none"}`}</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {dealNames(car.options[type]).map(({ o, name }) => (
                <SupplierOption key={o.id} o={o} name={name} current={current} free currentLabel="On your car"
                  selected={chosen?.id === o.id} isCurrent={current?.id === o.id}
                  disabled={!editable || busy != null || chosen?.id === o.id} busy={busy === `${type}${o.id}`}
                  onChoose={() => void run(`${type}${o.id}`, () => (o.id === current?.id ? pre.clearSupplier(type) : pre.pickSupplier(type, o.id)))} />
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}
