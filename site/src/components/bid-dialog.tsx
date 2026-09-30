import { Loader2 } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fmtMoney, fmtNum, humanize, statAverage } from "@/lib/format"
import { useHqOrders } from "@/lib/hq"
import { useLeague } from "@/lib/league"
import { bidCost, nextMinBid } from "@/lib/rules"
import { useTransfers, type Auction } from "@/lib/transfers"
import { cn } from "@/lib/utils"

const JOB_FOR: Record<Auction["kind"], string> = { Driver: "Driver", Engineer: "EngineerLead", Mechanic: "Mechanic" }

export function BidDialog({ auction, trigger }: { auction: Auction; trigger: React.ReactNode }) {
  const { me, league } = useLeague()
  const t = useTransfers()
  const hqCommitted = useHqOrders().committed(me.team)
  const minBid = nextMinBid(Number(auction.min_wage), auction.leading_wage == null ? null : Number(auction.leading_wage), t.settings)
  const [open, setOpen] = useState(false)
  const [wage, setWage] = useState(String(minBid))
  const [years, setYears] = useState("2")
  const [replacing, setReplacing] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const team = league.snapshot.teams.find((x) => x.name === me.team)
  const candidates = (team?.staff ?? []).filter((s) => s.job === JOB_FOR[auction.kind] && s.person).map((s) => s.person!)
  // People already being replaced by another auction I lead.
  const taken = new Map([...t.myLeading.entries()].filter(([id]) => id !== auction.id).map(([, b]) => [b.replacing_guid, b]))
  const replaced = candidates.find((p) => p.guid === replacing)
  const wageNum = Number(wage.replace(/[^\d]/g, "")) || 0
  const cost = bidCost(wageNum, Number(auction.buyout), replaced?.contract.yearlyWages ?? 0, league.snapshot.gameDate, t.settings)
  const budget = league.privateTeams[me.team]?.budget ?? 0
  const left = budget - t.committed - hqCommitted - cost.total
  const problem = wageNum < minBid ? `The minimum bid is ${fmtMoney(minBid)}.`
    : !replaced ? `Choose who the new ${humanize(JOB_FOR[auction.kind]).toLowerCase()} replaces.`
    : left < 0 ? "Not enough budget for this bid on top of your leading bids and HQ orders." : null

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await t.placeBid(auction.id, wageNum, Number(years), replacing)
      setOpen(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setWage(String(minBid)); setError(null) } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bid for {auction.person.name}</DialogTitle>
          <DialogDescription>
            {humanize(auction.kind)} · {fmtNum(statAverage(auction.person.stats))} avg ·{" "}
            {auction.from_team ? `under contract at ${auction.from_team}` : "free agent"}
            {auction.leading_team && <> · leader {auction.leading_team} at {fmtMoney(Number(auction.leading_wage))}/yr</>}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="wage">Yearly wage</Label>
            <Input id="wage" inputMode="numeric" value={wage} onChange={(e) => setWage(e.target.value)} />
            <span className="text-xs text-muted-foreground">At least {fmtMoney(minBid)}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Contract</Label>
              <Select value={years} onValueChange={setYears}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Array.from({ length: t.settings.max_contract_years }, (_, i) => i + 1).map((y) => (
                    <SelectItem key={y} value={String(y)}>{y} season{y > 1 ? "s" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Replaces</Label>
              <Select value={replacing} onValueChange={setReplacing}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>
                  {candidates.map((p) => (
                    <SelectItem key={p.guid} value={p.guid} disabled={taken.has(p.guid)}>
                      {p.name}{taken.has(p.guid) ? " (in another bid)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {auction.from_team && replaced && (
            <p className="text-xs text-muted-foreground">{replaced.name} moves to {auction.from_team} in a swap.</p>
          )}
          {!auction.from_team && replaced && <p className="text-xs text-muted-foreground">{replaced.name} is released to the market.</p>}

          <div className="grid grid-cols-[1fr_auto] gap-y-1 rounded-lg bg-muted/50 p-3 text-sm tabular-nums">
            <span className="text-muted-foreground">Sign-on fee ({Math.round(t.settings.sign_on_fee_pct * 100)}%)</span><span className="text-right">{fmtMoney(cost.signOnFee)}</span>
            {cost.buyout > 0 && <><span className="text-muted-foreground">Buyout to {auction.from_team}</span><span className="text-right">{fmtMoney(cost.buyout)}</span></>}
            <span className="text-muted-foreground">Extra wages this season</span><span className="text-right">{fmtMoney(cost.seasonWages)}</span>
            <span className="font-medium">This bid commits</span><span className="text-right font-medium">{fmtMoney(cost.total)}</span>
            <span className="mt-2 text-muted-foreground">Budget</span><span className="mt-2 text-right">{fmtMoney(budget)}</span>
            <span className="text-muted-foreground">Your other leading bids</span><span className="text-right">−{fmtMoney(t.committed)}</span>
            {hqCommitted > 0 && <><span className="text-muted-foreground">Queued HQ orders</span><span className="text-right">−{fmtMoney(hqCommitted)}</span></>}
            <span className="font-medium">Left if you win everything</span>
            <span className={cn("text-right font-medium", left < 0 && "text-destructive")}>{fmtMoney(left)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Only the fee and any buyout are taken when the window closes; wages are paid by the game over the season.
          </p>
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !!problem} title={problem ?? undefined}>
            {busy && <Loader2 className="animate-spin" />} Bid {fmtMoney(wageNum)}/yr
          </Button>
        </DialogFooter>
        {problem && !error && <p className="-mt-2 text-right text-xs text-muted-foreground">{problem}</p>}
      </DialogContent>
    </Dialog>
  )
}
