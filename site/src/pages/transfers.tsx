import { ChevronDown, ChevronRight, Gavel } from "lucide-react"
import { Fragment, useEffect, useState } from "react"
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BidDialog } from "@/components/bid-dialog"
import { PageHeader } from "@/components/page-header"
import { fmtMoney, fmtMoneyShort, fmtNum, humanize, statAverage } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { nextMinBid } from "@/lib/rules"
import { fmtCountdown, useNow, useTransfers, type Auction, type PublicBid, type TransferWindow } from "@/lib/transfers"
import { cn } from "@/lib/utils"

type Filter = "all" | "leading" | "outbid"

export function TransfersPage() {
  const t = useTransfers()
  const now = useNow()
  const [tab, setTab] = useState<"current" | "history">("current")
  const w = t.transferWindow
  const closesIn = w ? Date.parse(w.closes_at) - now : 0
  const awaiting = !!w && w.status === "open" && !t.isOpen

  return (
    <>
      <PageHeader
        title="Transfer window"
        description={
          t.isOpen ? <>Closes {new Date(w!.closes_at).toLocaleString()} · <b>{fmtCountdown(closesIn)}</b> left</>
            : awaiting ? "Bidding has closed. The organizer will apply the signings before the next race."
            : "No transfer window is open."
        }
        actions={t.isOpen && <Button asChild variant="outline"><Link to="/market"><Gavel /> Nominate from the market</Link></Button>}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as "current" | "history")}>
        <TabsList>
          <TabsTrigger value="current">Current window</TabsTrigger>
          <TabsTrigger value="history">
            History {awaiting && <Badge variant="secondary" className="ml-1">results</Badge>}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "current"
        ? t.isOpen ? <CurrentWindow /> : <NoWindow awaiting={awaiting} onHistory={() => setTab("history")} />
        : <WindowHistory />}
    </>
  )
}

function NoWindow({ awaiting, onHistory }: { awaiting: boolean; onHistory: () => void }) {
  const { me } = useLeague()
  return (
    <Card size="sm">
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <Gavel className="size-8 text-muted-foreground" />
        <div className="text-sm text-muted-foreground">
          {awaiting
            ? "Bidding is over. The results are in the history until the organizer applies them."
            : me.role === "organizer"
              ? <>Open the next window on the <Link to="/organizer" className="underline">Organizer page</Link>.</>
              : "The organizer opens a window between races."}
        </div>
        <Button variant="outline" onClick={onHistory}>See past windows</Button>
      </CardContent>
    </Card>
  )
}

function CurrentWindow() {
  const { me, league } = useLeague()
  const t = useTransfers()
  const [filter, setFilter] = useState<Filter>("all")
  const [expanded, setExpanded] = useState<number | null>(null)

  const iBid = new Set(t.myBids.map((b) => b.auction_id))
  const shown = t.auctions.filter((a) =>
    filter === "all" || (filter === "leading" ? a.leading_team === me.team : iBid.has(a.id) && a.leading_team !== me.team))
  const budget = league.privateTeams[me.team]?.budget ?? 0

  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Budget" value={fmtMoneyShort(budget)} />
        <Stat label="Committed by leading bids" value={fmtMoneyShort(t.committed)} />
        <Stat label="Auctions you lead" value={String(t.myLeading.size)} />
        <Stat label="Auctions" value={String(t.auctions.length)} />
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="leading">Leading</TabsTrigger>
          <TabsTrigger value="outbid">Outbid</TabsTrigger>
        </TabsList>
      </Tabs>

      <Card size="sm">
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>Person</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="text-right">Opening</TableHead>
                <TableHead>Leader</TableHead>
                <TableHead className="text-right">Bid / yr</TableHead>
                <TableHead className="text-right">Next min</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((a) => {
                const mine = a.leading_team === me.team
                const outbid = !mine && iBid.has(a.id)
                const leading = a.leading_wage == null ? null : Number(a.leading_wage)
                return (
                  <Fragment key={a.id}>
                    <TableRow className={cn(mine && "bg-primary/10 hover:bg-primary/15")}>
                      <TableCell>
                        <button className="text-muted-foreground" onClick={() => setExpanded(expanded === a.id ? null : a.id)} aria-label="Bid history">
                          {expanded === a.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{a.person.name}</div>
                        <div className="text-xs text-muted-foreground">{humanize(a.kind)} · {fmtNum(statAverage(a.person.stats))} avg</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.from_team ?? <span className="text-muted-foreground">Free agent</span>}
                        {Number(a.buyout) > 0 && <div className="text-xs text-muted-foreground">buyout {fmtMoneyShort(Number(a.buyout))}</div>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoneyShort(Number(a.min_wage))}</TableCell>
                      <TableCell>
                        {a.leading_team
                          ? <Badge variant={mine ? "default" : "secondary"}>{mine ? "You" : a.leading_team}</Badge>
                          : <span className="text-xs text-muted-foreground">No bids</span>}
                        {outbid && <Badge variant="destructive" className="ml-1">Outbid</Badge>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {leading == null ? "—" : <>{fmtMoneyShort(leading)} <span className="text-xs text-muted-foreground">×{a.leading_years}</span></>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoneyShort(nextMinBid(Number(a.min_wage), leading, t.settings))}</TableCell>
                      <TableCell className="text-right">
                        {!mine && <BidDialog auction={a} trigger={<Button size="sm">Bid</Button>} />}
                      </TableCell>
                    </TableRow>
                    {expanded === a.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell />
                        <TableCell colSpan={7}><History auction={a} /></TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
              {!shown.length && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    {t.auctions.length ? "Nothing here." : "No auctions yet. Nominate someone from the staff market."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription className="grid gap-1">
            <span>Each bid is a yearly wage for 1–{t.settings.max_contract_years} seasons and names who in your team the signing replaces.</span>
            <span>A bid must beat the leader by {Math.round(t.settings.min_increment_pct * 100)}%. You can't raise your own leading bid.</span>
            <span>When the window closes, winners pay a {Math.round(t.settings.sign_on_fee_pct * 100)}% sign-on fee, plus a buyout for AI teams' staff (MM's own rule: the months of wage left on their contract, at most 6), who swap with the person you release. AI teams' staff open at no less than their current wage.</span>
            <span>Your leading bids must fit in your budget, including the extra wages for the rest of this season.</span>
          </CardDescription>
        </CardHeader>
      </Card>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}

function History({ auction }: { auction: Auction }) {
  const t = useTransfers()
  const [bids, setBids] = useState<PublicBid[] | null>(null)
  const { bidHistory } = t
  // Reload when the auction changes (a new bid arrives through realtime).
  useEffect(() => {
    let live = true
    void bidHistory(auction.id).then((b) => live && setBids(b))
    return () => { live = false }
  }, [bidHistory, auction.id, auction.updated_at])
  if (!bids) return <span className="text-xs text-muted-foreground">Loading…</span>
  if (!bids.length) return <span className="text-xs text-muted-foreground">No bids yet. Opened by {auction.opened_by}.</span>
  return (
    <div className="grid gap-0.5 text-xs tabular-nums">
      {bids.map((b) => (
        <div key={b.id} className="flex gap-3">
          <span className="w-36 text-muted-foreground">{new Date(b.created_at).toLocaleString()}</span>
          <span className="w-44 truncate">{b.team}</span>
          <span>{fmtMoney(Number(b.yearly_wage))}/yr × {b.years}</span>
        </div>
      ))}
    </div>
  )
}

function WindowHistory() {
  const t = useTransfers()
  // The running window is on the current tab.
  const past = t.windows.filter((w) => !(t.isOpen && w.id === t.transferWindow?.id))
  if (!past.length) {
    return <Card size="sm"><CardContent className="py-8 text-center text-sm text-muted-foreground">No past transfer windows yet.</CardContent></Card>
  }
  return (
    <div className="flex flex-col gap-3">
      {past.map((w, i) => <PastWindow key={w.id} window={w} defaultOpen={i === 0} />)}
    </div>
  )
}

function PastWindow({ window: w, defaultOpen }: { window: TransferWindow; defaultOpen: boolean }) {
  const { me } = useLeague()
  const t = useTransfers()
  const [open, setOpen] = useState(defaultOpen)
  const [auctions, setAuctions] = useState<Auction[] | null>(null)
  const { windowAuctions } = t
  useEffect(() => {
    if (!open) return
    let live = true
    void windowAuctions(w.id).then((a) => live && setAuctions(a))
    return () => { live = false }
  }, [open, windowAuctions, w.id, w.status, w.closes_at])

  const signed = (auctions ?? []).filter((a) => a.leading_team)
  const unsold = (auctions ?? []).filter((a) => !a.leading_team)
  return (
    <Card size="sm">
      <CardHeader>
        <button className="flex items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <CardTitle>Window #{w.id}</CardTitle>
          <Badge variant={w.status === "applied" ? "secondary" : "default"}>{w.status === "applied" ? "Applied" : "Awaiting organizer"}</Badge>
          <CardDescription className="ml-auto">closed {new Date(w.closes_at).toLocaleString()}</CardDescription>
        </button>
      </CardHeader>
      {open && (
        <CardContent>
          {!auctions ? <span className="text-sm text-muted-foreground">Loading…</span> : !auctions.length ? (
            <span className="text-sm text-muted-foreground">No auctions in this window.</span>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead className="text-right">Wage / yr</TableHead>
                  <TableHead className="text-right">Sign-on fee</TableHead>
                  <TableHead className="text-right">Buyout</TableHead>
                  <TableHead className="text-right">Bids</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signed.map((a) => {
                  const wage = Number(a.leading_wage)
                  return (
                    <TableRow key={a.id} className={cn(a.leading_team === me.team && "bg-primary/10 hover:bg-primary/15")}>
                      <TableCell>
                        <div className="font-medium">{a.person.name}</div>
                        <div className="text-xs text-muted-foreground">{humanize(a.kind)} · {fmtNum(statAverage(a.person.stats))} avg</div>
                      </TableCell>
                      <TableCell className="text-sm">{a.from_team ?? <span className="text-muted-foreground">Free agent</span>}</TableCell>
                      <TableCell><Badge variant={a.leading_team === me.team ? "default" : "secondary"}>{a.leading_team}</Badge></TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoneyShort(wage)} <span className="text-xs text-muted-foreground">×{a.leading_years}</span></TableCell>
                      <TableCell className="text-right tabular-nums">{fmtMoneyShort(wage * t.settings.sign_on_fee_pct)}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(a.buyout) > 0 ? fmtMoneyShort(Number(a.buyout)) : "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">{a.bid_count}</TableCell>
                    </TableRow>
                  )
                })}
                {unsold.length > 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="text-xs text-muted-foreground">
                      No bids: {unsold.map((a) => a.person.name).join(", ")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      )}
    </Card>
  )
}
