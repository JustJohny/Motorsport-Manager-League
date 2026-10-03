import {
  CalendarClock, Car, Coins, DraftingCompass, Hourglass, Loader2, Lock, Signature, Undo2, UserCheck, UserX, Wrench, type LucideIcon,
} from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useContracts } from "@/lib/contracts"
import { fmtDate, fmtMoney, fmtMoneyShort } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { cn } from "@/lib/utils"
import type { ContractRenewal, TeamPrivate } from "@/lib/types"

const KIND_ICONS: Record<string, LucideIcon> = { Driver: Car, Engineer: DraftingCompass, Mechanic: Wrench }
const KIND_LABEL: Record<string, string> = { Driver: "Driver", Engineer: "Lead engineer", Mechanic: "Mechanic" }
const YEARS = [1, 2, 3]

/** Expiring contracts: renew at MM's terms before pre-season, or let them run out. */
export function ContractsTab({ team, priv, own }: { team: string; priv: TeamPrivate | undefined; own: boolean }) {
  const { league } = useLeague()
  const pub = league.snapshot.teams.find((t) => t.name === team)
  if (!priv) return <Alert><Lock /><AlertDescription>Like in the game, only the team's manager sees its contracts.</AlertDescription></Alert>
  if (!priv.contracts) return <Alert><AlertDescription>The latest publish has no contract data yet; it appears after the organizer publishes again.</AlertDescription></Alert>
  const isPlayer = !!pub?.isPlayerTeam
  return <Renewals team={team} own={own && !isPlayer} isPlayer={isPlayer} contracts={priv.contracts} budget={priv.budget ?? 0} />
}

function Renewals({ team, own, isPlayer, contracts, budget }: {
  team: string; own: boolean; isPlayer: boolean; contracts: NonNullable<TeamPrivate["contracts"]>; budget: number
}) {
  const { league } = useLeague()
  const c = useContracts()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [years, setYears] = useState<Record<string, number>>({})
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const gameDate = league.snapshot.gameDate
  const closed = gameDate >= contracts.deadline
  const mine = c.orders.filter((o) => o.team === team)
  const fees = c.committed(team)
  const { renewals } = contracts
  const willing = renewals.filter((r) => !r.refusal).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-sm tabular-nums">
        <span className="flex items-center gap-1.5"><Hourglass className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Expiring</span> {renewals.length}</span>
        <span className="flex items-center gap-1.5"><UserCheck className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Willing to renew</span> {willing}</span>
        <span className="flex items-center gap-1.5"><CalendarClock className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Deadline</span> {fmtDate(contracts.deadline)}</span>
        {fees > 0 && <span><span className="text-muted-foreground">Sign-on fees </span>−{fmtMoneyShort(fees)}</span>}
        <span className="flex items-center gap-1.5"><Coins className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Budget</span> {fmtMoneyShort(budget)}</span>
      </div>
      {isPlayer && <Alert><Lock /><AlertDescription>The organizer's career team renews its contracts in game; this is what MM would offer.</AlertDescription></Alert>}
      {closed && <Alert><Lock /><AlertDescription>Renewals closed when MM's pre-season began on {fmtDate(contracts.deadline)}. Contracts not renewed run out at season end.</AlertDescription></Alert>}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <p className="text-sm text-muted-foreground">
        Contracts in their last 12 months can be renewed at MM's terms: the wage MM's AI would offer and the sign-on fee they ask,
        for 1 to 3 more seasons. Only the fee is taken from your budget now; the new wage runs from the renewal on.
        Someone you don't renew leaves when the contract ends.
      </p>
      {renewals.length === 0 ? (
        <Alert><AlertDescription>No contract on this team ends within the next 12 months.</AlertDescription></Alert>
      ) : (
        <Card size="sm">
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead className="text-right">Now</TableHead>
                  <TableHead className="text-right">MM asks</TableHead>
                  <TableHead>Answer</TableHead>
                  {own && !closed && <TableHead className="text-right">Renew for</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {renewals.map((r) => {
                  const order = mine.find((o) => o.person_guid === r.guid && o.status === "queued")
                  const applied = mine.find((o) => o.person_guid === r.guid && o.status === "applied")
                  const y = years[r.guid] ?? r.preferredYears
                  return (
                    <TableRow key={r.guid} className={cn(order && "bg-primary/10 hover:bg-primary/15")}>
                      <TableCell><Person r={r} /></TableCell>
                      <TableCell className="text-right tabular-nums">
                        {fmtMoneyShort(r.wage)}/yr
                        <div className="text-xs text-muted-foreground">ends {fmtDate(r.end)} · {r.monthsLeft} mo</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span title={fmtMoney(r.askingWage)}>{fmtMoneyShort(r.askingWage)}/yr</span>
                        <WageChange from={r.wage} to={r.askingWage} />
                        <div className="text-xs text-muted-foreground">{r.signOnFee ? `${fmtMoneyShort(r.signOnFee)} sign-on` : "no sign-on fee"} · likes {r.preferredYears} season{r.preferredYears > 1 ? "s" : ""}</div>
                      </TableCell>
                      <TableCell>
                        {r.refusal
                          ? <Badge variant="outline" className="gap-1 text-destructive"><UserX className="size-3" /> {r.refusal}</Badge>
                          : <Badge variant="secondary" className="gap-1"><UserCheck className="size-3" /> Willing</Badge>}
                        {order && <div className="mt-1 text-xs">Renewing {order.years} season{order.years > 1 ? "s" : ""}, until {fmtDate(order.new_end)}</div>}
                        {applied && !order && <div className="mt-1 text-xs text-muted-foreground">Renewed until {fmtDate(applied.new_end)}; shows after the next publish</div>}
                      </TableCell>
                      {own && !closed && (
                        <TableCell className="text-right">
                          {order ? (
                            <Button size="sm" variant="ghost" disabled={busy === r.guid} onClick={() => void run(r.guid, () => c.cancel(order.id))}>
                              <Undo2 /> Cancel
                            </Button>
                          ) : !r.refusal && !applied ? (
                            <div className="flex items-center justify-end gap-2">
                              <div className="inline-flex rounded-md border" role="group" aria-label="Seasons">
                                {YEARS.map((n) => (
                                  <button key={n} type="button" onClick={() => setYears((s) => ({ ...s, [r.guid]: n }))}
                                    className={cn("px-2 py-1 text-xs tabular-nums first:rounded-l-md last:rounded-r-md", n === y ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
                                    {n}y
                                  </button>
                                ))}
                              </div>
                              <Button size="sm" disabled={busy === r.guid} onClick={() => void run(r.guid, () => c.renew(r.guid, y))}>
                                {busy === r.guid ? <Loader2 className="animate-spin" /> : <Signature />} Renew
                              </Button>
                            </div>
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
      )}
    </div>
  )
}

function Person({ r }: { r: ContractRenewal }) {
  const Icon = KIND_ICONS[r.kind] ?? UserCheck
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 text-muted-foreground" />
      <span>
        <span className="font-medium">{r.name}</span>
        <div className="text-xs text-muted-foreground">{KIND_LABEL[r.kind] ?? r.kind}</div>
      </span>
    </span>
  )
}

/** The raise MM asks for, against the current wage. */
function WageChange({ from, to }: { from: number; to: number }) {
  if (!from || Math.abs(to - from) < 1000) return <div className="text-xs text-muted-foreground">same as now</div>
  const pct = Math.round(((to - from) / from) * 100)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("text-xs", to > from ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400")}>
          {to > from ? "+" : "−"}{fmtMoneyShort(Math.abs(to - from))} ({to > from ? "+" : ""}{pct}%)
        </div>
      </TooltipTrigger>
      <TooltipContent>MM's AI never offers less than the current wage; stars, potential and the team's standing set the rest.</TooltipContent>
    </Tooltip>
  )
}
