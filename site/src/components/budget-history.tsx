import {
  ArrowDownRight, ArrowUpRight, Building2, CarFront, CircleDollarSign, Factory, Flag, HardHat, History, Landmark, Megaphone,
  Trophy, User, Users, Wrench, type LucideIcon,
} from "lucide-react"
import { useMemo, useState } from "react"
import { circuitName } from "../../../src/circuit-names.ts"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fmtDate, fmtMoney, fmtMoneyShort } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { BudgetTransaction, CalendarEvent } from "@/lib/types"

/** MM's Transaction.Group, named from what each group holds in the FF20 saves. */
const GROUPS: Record<number, { label: string; icon: LucideIcon }> = {
  0: { label: "Parts & staff deals", icon: Wrench },
  1: { label: "Next year's car", icon: CarFront },
  2: { label: "Driver wages", icon: User },
  3: { label: "Mechanic wages", icon: Users },
  4: { label: "Engineer wages", icon: HardHat },
  5: { label: "HQ upkeep", icon: Building2 },
  6: { label: "HQ construction", icon: Factory },
  7: { label: "HQ income", icon: Landmark },
  8: { label: "Prize money", icon: Trophy },
  9: { label: "Race costs", icon: Flag },
  10: { label: "Chairman & league", icon: Landmark },
  12: { label: "Sponsors", icon: Megaphone },
  15: { label: "Pit crew wages", icon: Users },
}
const group = (g: number) => GROUPS[g] ?? { label: "Other", icon: CircleDollarSign }

const ALL = "all"
const PRE = "pre"

/** Round k holds everything from its race weekend until the next round's. */
function periodOf(date: string, calendar: CalendarEvent[]): string {
  let p = PRE
  for (const ev of calendar) if (date >= ev.date) p = String(ev.round)
  return p
}

export function BudgetStat({ budget, transactions, calendar }: { budget: number | null; transactions: BudgetTransaction[] | null | undefined; calendar: CalendarEvent[] }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>Budget</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{fmtMoneyShort(budget)}</CardTitle>
        <CardDescription className="text-xs tabular-nums">{fmtMoney(budget)}</CardDescription>
        {transactions && transactions.length > 0 && (
          <CardAction>
            <BudgetHistoryDialog budget={budget} transactions={transactions} calendar={calendar}
              trigger={<Button variant="ghost" size="icon-sm" title="Budget history" aria-label="Budget history"><History /></Button>} />
          </CardAction>
        )}
      </CardHeader>
    </Card>
  )
}

function BudgetHistoryDialog({ budget, transactions, calendar, trigger }: { budget: number | null; transactions: BudgetTransaction[]; calendar: CalendarEvent[]; trigger: React.ReactNode }) {
  const [period, setPeriod] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const rows = useMemo(() => transactions.map((t) => ({ ...t, period: periodOf(t.date, calendar) })), [transactions, calendar])
  const periods = [...new Set(rows.map((r) => r.period))]
  const inPeriod = rows.filter((r) => period === ALL || r.period === period)
  const shown = inPeriod.filter((r) => category === ALL || r.group === Number(category))
  const income = inPeriod.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)
  const costs = inPeriod.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0)
  const start = inPeriod.length ? inPeriod[0].after - inPeriod[0].amount : null
  const end = inPeriod.length ? inPeriod[inPeriod.length - 1].after : null

  const totals = new Map<number, { g: number; count: number; income: number; costs: number }>()
  for (const r of inPeriod) {
    const e = totals.get(r.group) ?? { g: r.group, count: 0, income: 0, costs: 0 }
    e.count++
    if (r.amount > 0) e.income += r.amount; else e.costs += r.amount
    totals.set(r.group, e)
  }
  const byGroup = [...totals.values()].sort((a, b) => Math.abs(b.income + b.costs) - Math.abs(a.income + a.costs))

  const periodLabel = (p: string) => {
    if (p === PRE) return calendar.length ? "Before round 1" : "Earlier"
    const ev = calendar.find((e) => String(e.round) === p)
    return ev ? `Round ${ev.round} · ${circuitName(ev.circuit)}` : `Round ${p}`
  }

  return (
    <Dialog onOpenChange={(o) => { if (o) { setPeriod(ALL); setCategory(ALL) } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="size-5" /> Budget history</DialogTitle>
          <DialogDescription>
            Every payment in MM's finance history, as of the last publish. Site orders show up here once they're applied to the save.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2 sm:flex">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-full sm:w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Whole history</SelectItem>
              {periods.map((p) => <SelectItem key={p} value={p}>{periodLabel(p)}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-full sm:w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {[...new Set(rows.map((r) => r.group))].sort((a, b) => a - b).map((g) => <SelectItem key={g} value={String(g)}>{group(g).label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Figure label="Start" value={start} hint={period === ALL ? "Oldest entry" : periodLabel(period)} />
          <Figure label="Income" value={income} icon={ArrowUpRight} tone="up" />
          <Figure label="Costs" value={costs} icon={ArrowDownRight} tone="down" />
          <Figure label={period === ALL ? "Budget now" : "End"} value={period === ALL ? budget : end} hint={`Net ${signed(income + costs)}`} />
        </div>

        <BudgetChart rows={inPeriod} />

        <Tabs defaultValue="categories">
          <TabsList>
            <TabsTrigger value="categories">By category</TabsTrigger>
            <TabsTrigger value="entries">Entries ({shown.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="categories">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Entries</TableHead>
                  <TableHead className="text-right">Income</TableHead>
                  <TableHead className="text-right">Costs</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byGroup.map(({ g, count, income, costs }) => {
                  const { label, icon: Icon } = group(g)
                  return (
                    <TableRow key={g} className={cn("cursor-pointer", String(g) === category && "bg-primary/10 hover:bg-primary/15")}
                      onClick={() => setCategory(String(g) === category ? ALL : String(g))}>
                      <TableCell className="font-medium"><span className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" />{label}</span></TableCell>
                      <TableCell className="text-right tabular-nums">{count}</TableCell>
                      <TableCell className="text-right tabular-nums">{income ? fmtMoney(income) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{costs ? fmtMoney(-costs) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums"><Amount v={income + costs} /></TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TabsContent>
          <TabsContent value="entries">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Budget after</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Newest first, as MM's finance screen lists them. */}
                {shown.toReversed().map((r, i) => {
                  const { label, icon: Icon } = group(r.group)
                  return (
                    <TableRow key={i}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2" title={label}><Icon className="size-4 shrink-0 text-muted-foreground" />{r.name.trim() || label}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums"><Amount v={r.amount} /></TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMoney(r.after)}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtMoneyShort(Math.abs(v))}`

function Amount({ v }: { v: number }) {
  return <span className={cn(v > 0 && "text-emerald-500", v < 0 && "text-destructive")}>{v > 0 ? "+" : v < 0 ? "−" : ""}{fmtMoney(Math.abs(v))}</span>
}

function Figure({ label, value, hint, icon: Icon, tone }: { label: string; value: number | null; hint?: string; icon?: LucideIcon; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon && <Icon className={cn("size-3.5", tone === "up" ? "text-emerald-500" : "text-destructive")} />}{label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value == null ? "—" : tone === "down" ? fmtMoneyShort(-value) : fmtMoneyShort(value)}</div>
      {hint && <div className="truncate text-xs text-muted-foreground tabular-nums">{hint}</div>}
    </div>
  )
}

const W = 800, H = 160, PAD = { l: 8, r: 8, t: 12, b: 20 }

/** The budget after each entry, one step per entry (a race weekend's entries share a date), with a hover readout. */
function BudgetChart({ rows }: { rows: BudgetTransaction[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (rows.length < 2) return null
  const values = [rows[0].after - rows[0].amount, ...rows.map((r) => r.after)]
  const lo = Math.min(...values), hi = Math.max(...values, lo + 1)
  const x = (i: number) => PAD.l + (i / rows.length) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b)
  let path = `M${x(0)},${y(values[0])}`
  rows.forEach((r, i) => { path += `V${y(r.after)}H${x(i + 1)}` })
  const h = hover != null ? rows[hover] : null

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    setHover(Math.min(rows.length - 1, Math.max(0, Math.floor(((px - PAD.l) / (W - PAD.l - PAD.r)) * rows.length))))
  }

  return (
    <div className="relative rounded-lg border p-2">
      <div className="flex justify-between gap-x-3 px-1 text-xs text-muted-foreground tabular-nums">
        <span className="shrink-0">{fmtMoneyShort(hi)}</span>
        <span className="text-right">{h ? <><b className="text-foreground">{fmtMoney(h.after)}</b> after {h.name.trim() || group(h.group).label} · {fmtDate(h.date)}</> : "Hover for the budget on a day"}</span>
      </div>
      <div className="relative h-40">
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full touch-none" preserveAspectRatio="none" role="img" aria-label="Budget over time"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(lo)} y2={y(lo)} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={path} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {h && hover != null && <line x1={x(hover + 0.5)} x2={x(hover + 0.5)} y1={PAD.t} y2={H - PAD.b} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
        </svg>
        {h && hover != null && (
          <span className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary"
            style={{ left: `${(x(hover + 0.5) / W) * 100}%`, top: `${(y(h.after) / H) * 100}%` }} />
        )}
      </div>
      <div className="flex justify-between px-1 text-xs text-muted-foreground tabular-nums">
        <span>{fmtMoneyShort(lo)}</span>
        <span>{fmtDate(rows[0].date)} – {fmtDate(rows[rows.length - 1].date)}</span>
      </div>
    </div>
  )
}
