import { ArrowRight, Ban, Car, Coins, Handshake, Loader2, Lock, PackageCheck, Store, Tag, Undo2, X } from "lucide-react"
import { useState } from "react"
import { CUSTOMER_SPEC, customerStat, isCustomerPart } from "../../../src/part-market.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/page-header"
import { PART_ORDER, partIcon, RiskBadge, Tier } from "@/components/parts-tab"
import { fmtDate, fmtMoney, fmtMoneyShort, fmtPct, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { isAiPart, useParts, type Listing } from "@/lib/parts"
import { cn } from "@/lib/utils"
import type { Part } from "@/lib/types"

type Run = (key: string, fn: () => Promise<void>) => Promise<void>

const best = (parts: Part[] | undefined) => Math.max(0, ...(parts ?? []).filter((p) => !p.banned).map((p) => (p.stat ?? 0) + (p.performance ?? 0)))

export function PartMarketPage() {
  const { me, league } = useLeague()
  const p = useParts()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const run: Run = async (key, fn) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const ch = league.snapshot.championship
  const season = Number(league.snapshot.gameDate.slice(0, 4))
  const listed = p.listedParts(season)
  const spec = league.privateTeams[me.team]?.design?.specParts ?? []
  // As part_market_open() in SQL: this season still has a race to run.
  const open = league.snapshot.gameDate < (ch.seasonEnd ?? "9999") && ch.calendar.some((e) => !e.ended)

  return (
    <>
      <PageHeader title="Part market" description={<>{ch.name} · {season} season. Buy customer parts from other members, or sell copies of yours.</>} />
      {!open && (
        <Alert><Lock /><AlertDescription>The market is closed: this season's racing is over. Customer parts go back to their makers at the season's end, and the market opens again next season.</AlertDescription></Alert>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <RulesCard listed={listed} spec={spec} season={season} busy={busy} run={run} />
      <ListingsCard open={open} busy={busy} run={run} />
      {league.privateTeams[me.team] && <SellCard open={open} listed={listed} spec={spec} busy={busy} run={run} />}
      <DealsCard busy={busy} run={run} />
    </>
  )
}

function RulesCard({ listed, spec, season, busy, run }: { listed: string[]; spec: string[]; season: number; busy: string | null; run: Run }) {
  const { me } = useLeague()
  const p = useParts()
  const [draft, setDraft] = useState<string[] | null>(null)
  const organizer = me.role === "organizer"
  const shown = draft ?? listed
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Store className="size-4" /> How it works</CardTitle>
        <CardDescription>
          A customer part is a copy: the maker keeps theirs. It has {Math.round(CUSTOMER_SPEC * 100)} % of the part's gain over the series' base stat,
          the same reliability and the same components, so a grey-area part carries its risk. Copies arrive at the next apply, can be improved
          like your own parts, don't open design slots, and go back at the season's end. The maker pays MM's materials cost per copy out of the price.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Listed parts in {season} (every team designs its own):</span>
          {PART_ORDER.map((type) => {
            const Icon = partIcon(type)
            const on = shown.includes(type)
            if (!organizer) return on ? <Badge key={type} variant="secondary"><Icon /> {humanize(type)}</Badge> : null
            return (
              <Button key={type} size="sm" variant={on ? "default" : "outline"} disabled={busy != null}
                onClick={() => setDraft(on ? shown.filter((t) => t !== type) : [...shown, type])}>
                <Icon /> {humanize(type)}
              </Button>
            )
          })}
          {!organizer && !listed.length && <span>none</span>}
          {spec.length > 0 && <span className="text-xs text-muted-foreground">Spec in this series: {spec.map(humanize).join(", ")}</span>}
        </div>
        {organizer && draft && (
          <div className="flex gap-2">
            <Button size="sm" disabled={busy != null} onClick={() => void run("rules", async () => { await p.setListedParts(season, draft); setDraft(null) })}>
              {busy === "rules" ? <Loader2 className="animate-spin" /> : <Lock />} Save listed parts for {season}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ListingsCard({ open, busy, run }: { open: boolean; busy: string | null; run: Run }) {
  const { me, league } = useLeague()
  const p = useParts()
  const season = Number(league.snapshot.gameDate.slice(0, 4))
  const listed = p.listedParts(season)
  const rows = [...p.listings].sort((a, b) => PART_ORDER.indexOf(a.part_type) - PART_ORDER.indexOf(b.part_type) || b.preview.stat - a.preview.stat)
  const myParts = league.privateTeams[me.team]?.parts
  const game = league.snapshot.championship.game
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Tag className="size-4" /> On the market</CardTitle>
        <CardDescription>Stats are the customer spec as of the listing. "Yours" is your best part of that type now.</CardDescription>
      </CardHeader>
      <CardContent>
        {!rows.length ? <p className="text-sm text-muted-foreground">Nothing on the market yet.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Part</TableHead>
                <TableHead>Maker</TableHead>
                <TableHead className="text-right">Yours → copy</TableHead>
                <TableHead className="text-right">Reliability</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((l) => {
                const Icon = partIcon(l.part_type)
                const mine = best(myParts?.[l.part_type])
                const gain = l.preview.stat - mine
                const compare = myParts && l.team !== me.team
                return (
                  <TableRow key={l.id} className={cn(l.team === me.team && "bg-primary/5")}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Icon className="size-4 text-muted-foreground" />
                        <span className="font-medium">{humanize(l.part_type)}</span>
                        <span className="font-mono text-xs text-muted-foreground">{l.preview.name}</span>
                        {l.preview.level > 0 && <Tier level={l.preview.level} />}
                        {l.preview.risk > 0 && <RiskBadge risk={l.preview.risk} bonus={0} game={game} />}
                      </div>
                      {listed.includes(l.part_type) && <div className="flex items-center gap-1 text-[11px] text-muted-foreground"><Ban className="size-3" /> Listed this season · can't be bought</div>}
                    </TableCell>
                    <TableCell>{l.team}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {compare && <span className="text-muted-foreground">{mine.toFixed(0)} <ArrowRight className="inline size-3" /> </span>}
                      <span className="font-medium">{l.preview.stat.toFixed(0)}</span>
                      {compare && <span className={cn("ml-1 text-xs", gain > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>{gain > 0 ? "+" : ""}{gain.toFixed(0)}</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtPct(l.preview.reliability)} / {fmtPct(l.preview.maxReliability)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtMoneyShort(l.price)}</TableCell>
                    <TableCell className="text-right">
                      {l.team === me.team
                        ? <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void run(`w${l.id}`, () => p.withdrawListing(l.id))}>
                            {busy === `w${l.id}` ? <Loader2 className="animate-spin" /> : <Undo2 />} Withdraw
                          </Button>
                        : <BuyControls listing={l} disabled={!open || listed.includes(l.part_type) || !myParts} busy={busy} run={run} />}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function BuyControls({ listing, disabled, busy, run }: { listing: Listing; disabled: boolean; busy: string | null; run: Run }) {
  const { me } = useLeague()
  const p = useParts()
  const [copies, setCopies] = useState(1)
  const [cars, setCars] = useState<number[]>([])
  const pending = p.purchases.find((x) => x.listing_id === listing.id && x.buyer === me.team && x.status === "queued")
  if (pending) return <Badge variant="secondary"><PackageCheck /> Bought · arrives at next apply</Badge>
  const toggleCar = (car: number) => setCars(cars.includes(car) ? cars.filter((c) => c !== car) : [...cars, car].slice(-copies))
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {[1, 2].map((n) => (
        <Button key={n} size="xs" variant={copies === n ? "secondary" : "ghost"} disabled={disabled} title={n === 1 ? "One copy" : "Two copies, one per car"}
          onClick={() => { setCopies(n); setCars(cars.slice(0, n)) }}>×{n}</Button>
      ))}
      {[0, 1].map((car) => (
        <Button key={car} size="xs" variant={cars.includes(car) ? "secondary" : "ghost"} disabled={disabled} title={`Fit a copy to car ${car + 1} on arrival`}
          onClick={() => toggleCar(car)}><Car /> {car + 1}</Button>
      ))}
      <Button size="sm" disabled={disabled || busy != null} onClick={() => void run(`b${listing.id}`, () => p.buyPart(listing.id, copies, cars))}>
        {busy === `b${listing.id}` ? <Loader2 className="animate-spin" /> : <Coins />} Buy {fmtMoneyShort(listing.price * copies)}
      </Button>
    </div>
  )
}

function SellCard({ open, listed, spec, busy, run }: { open: boolean; listed: string[]; spec: string[]; busy: string | null; run: Run }) {
  const { me, league } = useLeague()
  const p = useParts()
  const priv = league.privateTeams[me.team]!
  const types = PART_ORDER.filter((t) => priv.parts[t]?.length && !listed.includes(t) && !spec.includes(t) && priv.design?.types[t])
  const [type, setType] = useState<string | null>(null)
  const [guid, setGuid] = useState<string | null>(null)
  const [price, setPrice] = useState("")
  const current = type && types.includes(type) ? type : types[0] ?? null
  const floor = league.snapshot.championship.partFloor?.[current ?? ""] ?? 0
  const materials = current ? priv.design?.types[current]?.ctx.settings.materialsCost ?? 0 : 0
  const onMarket = new Set(p.listings.map((l) => l.part_guid))
  const parts = (current ? priv.parts[current] ?? [] : [])
    .filter((x) => !x.banned && !isCustomerPart(x.guid) && !isAiPart(x, current!, me.team, p.orders, p.teamStart(me.team)))
    .sort((a, b) => (b.stat ?? 0) + (b.performance ?? 0) - (a.stat ?? 0) - (a.performance ?? 0))
  const chosen = parts.find((x) => x.guid === guid)
  const amount = Number(price.replace(/[^\d]/g, "")) || 0
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Handshake className="size-4" /> Sell a part</CardTitle>
        <CardDescription>
          Put one of your parts on the market. Any member may buy copies until you withdraw it; you keep your own.
          For each copy you get the price less MM's materials cost ({current ? fmtMoney(materials) : "—"} for this part).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!types.length ? <p className="text-sm text-muted-foreground">You have no part types you can sell this season.</p> : (
          <>
            <div className="flex flex-wrap gap-1">
              {types.map((t) => {
                const Icon = partIcon(t)
                return <Button key={t} size="sm" variant={t === current ? "secondary" : "ghost"} onClick={() => { setType(t); setGuid(null) }}><Icon /> {humanize(t)}</Button>
              })}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Part</TableHead>
                  <TableHead className="text-right">Yours → customer copy</TableHead>
                  <TableHead className="text-right">Reliability</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {parts.map((x) => {
                  const full = (x.stat ?? 0) + (x.performance ?? 0)
                  const listedNow = onMarket.has(x.guid)
                  return (
                    <TableRow key={x.guid} className={cn("cursor-pointer", guid === x.guid && "bg-primary/10 hover:bg-primary/15")} onClick={() => !listedNow && setGuid(x.guid)}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs">{x.name}</span>
                          {x.level > 0 && <Tier level={x.level} />}
                          {(x.rulesRisk ?? 0) > 0 && <RiskBadge risk={x.rulesRisk!} bonus={0} game={league.snapshot.championship.game} />}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="text-muted-foreground">{full.toFixed(0)} <ArrowRight className="inline size-3" /> </span>
                        <span className="font-medium">{customerStat(full, floor)}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(x.reliability)} / {fmtPct(x.maxReliability)}</TableCell>
                      <TableCell className="text-right">{listedNow ? <Badge variant="secondary">On the market</Badge> : guid === x.guid ? <Badge>Selected</Badge> : null}</TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={`Price per copy, at least ${fmtMoneyShort(materials)}`} className="max-w-64" inputMode="numeric" />
              {amount > 0 && <span className="text-xs text-muted-foreground">You get {fmtMoney(Math.max(0, amount - materials))} per copy</span>}
              <Button disabled={!open || !chosen || amount < materials || busy != null}
                onClick={() => void run("sell", async () => { await p.listPart(current!, chosen!.guid, amount); setGuid(null); setPrice("") })}>
                {busy === "sell" ? <Loader2 className="animate-spin" /> : <Tag />} List {chosen ? chosen.name : "part"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function DealsCard({ busy, run }: { busy: string | null; run: Run }) {
  const { me } = useLeague()
  const p = useParts()
  const deals = p.purchases.filter((x) => x.buyer === me.team || x.seller === me.team || me.role === "organizer")
  if (!deals.length) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><PackageCheck className="size-4" /> {me.role === "organizer" ? "Deals" : "Your deals"}</CardTitle>
        <CardDescription>Queued deals are delivered and paid at the next apply.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Part</TableHead>
              <TableHead>Buyer</TableHead>
              <TableHead>Maker</TableHead>
              <TableHead className="text-right">Copies</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {deals.map((d) => {
              const Icon = partIcon(d.part_type)
              return (
                <TableRow key={d.id}>
                  <TableCell><span className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" /> {humanize(d.part_type)}</span></TableCell>
                  <TableCell>{d.buyer}</TableCell>
                  <TableCell>{d.seller}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.copies}{d.fit_cars.length > 0 && <span className="text-xs text-muted-foreground"> · car {d.fit_cars.map((c) => c + 1).join(" & ")}</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtMoneyShort(d.price_each * d.copies)}</TableCell>
                  <TableCell>{d.status === "queued" ? <Badge variant="outline">Queued · {fmtDate(d.created_at)}</Badge> : <Badge variant="secondary">Delivered</Badge>}</TableCell>
                  <TableCell className="text-right">
                    {d.status === "queued" && (d.buyer === me.team || me.role === "organizer") && (
                      <Button size="sm" variant="ghost" disabled={busy != null} onClick={() => void run(`c${d.id}`, () => p.cancelPurchase(d.id))}>
                        {busy === `c${d.id}` ? <Loader2 className="animate-spin" /> : <X />} Cancel
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
