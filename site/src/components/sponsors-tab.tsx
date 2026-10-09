import { StickersPanel } from "@/components/stickers-panel"
import {
  BadgeDollarSign, Banknote, Bot, CalendarClock, Check, Coins, Columns2, Fan, Handshake, Hourglass, Loader2, Lock, Megaphone,
  PanelBottom, PanelTop, Square, Star, Sticker, TriangleAlert, Trophy, Triangle, Undo2, X, type LucideIcon,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import { SPONSOR_SLOTS } from "../../../src/league-types.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fmtDate, fmtMoney, fmtMoneyShort } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { useSponsors, type SponsorOrder } from "@/lib/sponsors"
import { cn } from "@/lib/utils"
import type { SponsorDeal, SponsorOffer, SponsorOnCar, SponsorTerms, TeamPrivate } from "@/lib/types"

/** An icon per car position, in SponsorSlot.SlotType order. */
const SLOT_ICONS: LucideIcon[] = [PanelTop, PanelBottom, Triangle, Columns2, Square, Fan]

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex" aria-label={`${n} star sponsor`}>
      {[1, 2, 3, 4, 5].map((i) => <Star key={i} className={cn("size-3", i <= n ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30")} />)}
    </span>
  )
}

function SlotName({ slot, className }: { slot: number; className?: string }) {
  const Icon = SLOT_ICONS[slot] ?? Square
  return <span className={cn("flex items-center gap-1.5", className)}><Icon className="size-4 text-muted-foreground" /> {SPONSOR_SLOTS[slot]}</span>
}

/** Per race payment, or the race bonus with its target position (MM shows one or the other). */
function Income({ t }: { t: SponsorTerms }) {
  if (t.bonus > 0) {
    return (
      <span className="flex items-center gap-1 tabular-nums">
        <Trophy className="size-3.5 text-muted-foreground" /> {fmtMoneyShort(t.bonus)} for P{t.bonusTarget} or better
        {t.homeBonus > 1 && <Badge variant="outline" className="ml-1 text-[10px]">×{t.homeBonus.toFixed(1)} at home</Badge>}
      </span>
    )
  }
  return <span className="flex items-center gap-1 tabular-nums"><Banknote className="size-3.5 text-muted-foreground" /> {fmtMoneyShort(t.perRace)} per race</span>
}

/** What a deal is worth if it runs its length: upfront plus per-race money (bonuses only if earned). */
const guaranteed = (t: SponsorTerms) => t.upfront + t.perRace * t.length

export function SponsorsTab({ team, priv, own }: { team: string; priv: TeamPrivate | undefined; own: boolean }) {
  const { league } = useLeague()
  const pub = league.snapshot.teams.find((t) => t.name === team)
  const isPlayer = !!pub?.isPlayerTeam
  if (!pub?.sponsors) return <Alert><AlertDescription>The latest publish has no sponsor data yet; it appears after the organizer publishes again.</AlertDescription></Alert>
  if (!priv?.sponsorship) return <div className="flex flex-col gap-4"><StickersPanel team={team} own={false} /><PublicCar sponsors={pub.sponsors} /></div>
  return <TeamSponsors team={team} own={own && !isPlayer} isPlayer={isPlayer} sponsorship={priv.sponsorship} budget={priv.budget ?? 0} />
}

/** Rival teams: the sponsors on their car, as MM shows them. */
function PublicCar({ sponsors }: { sponsors: SponsorOnCar[] }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">The sponsors on this team's car. Their money terms and offers are private.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SPONSOR_SLOTS.map((_, slot) => {
          const s = sponsors.find((x) => x.slot === slot)
          return (
            <Card key={slot} size="sm">
              <CardContent className="flex flex-col gap-1">
                <SlotName slot={slot} className="text-xs text-muted-foreground" />
                {s ? (
                  <>
                    <span className="font-medium">{s.sponsor}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground"><Stars n={s.prestige} /> {s.category}</span>
                  </>
                ) : <span className="text-sm text-muted-foreground">No sponsor</span>}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function TeamSponsors({ team, own, isPlayer, sponsorship, budget }: {
  team: string; own: boolean; isPlayer: boolean; sponsorship: NonNullable<TeamPrivate["sponsorship"]>; budget: number
}) {
  const { league } = useLeague()
  const s = useSponsors()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const mine = s.orders.filter((o) => o.team === team)
  const open = (kind: SponsorOrder["kind"], slot: number) => mine.find((o) => o.kind === kind && o.slot === slot && (o.status === "queued" || o.status === "kept"))
  const { deals, offers } = sponsorship
  const perRace = deals.reduce((sum, d) => sum + d.perRace, 0)
  const aiUndecided = deals.filter((d) => s.isAiDeal(d, team) && !open("keep", d.slot) && !open("drop", d.slot))
  const payBack = s.committed(team)
  const incoming = mine.filter((o) => o.kind === "sign" && o.status === "queued").reduce((sum, o) => sum + o.amount, 0)
  const ctx: SlotCtx = { team, own, busy, run, open, gameDate: league.snapshot.gameDate }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-2 text-sm tabular-nums">
        <span className="flex items-center gap-1.5"><Handshake className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Slots</span> {deals.length}/6</span>
        <span className="flex items-center gap-1.5"><Banknote className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Per race</span> {fmtMoneyShort(perRace)}</span>
        {incoming > 0 && <span><span className="text-muted-foreground">Upfront from new deals </span>+{fmtMoneyShort(incoming)}</span>}
        {payBack > 0 && <span><span className="text-muted-foreground">Upfront paid back </span>−{fmtMoneyShort(payBack)}</span>}
        <span className="flex items-center gap-1.5"><Coins className="size-4 text-muted-foreground" /><span className="text-muted-foreground">Budget</span> {fmtMoneyShort(budget)}</span>
      </div>
      {isPlayer && (
        <Alert><Lock /><AlertDescription>The organizer's career team signs its sponsors in game; this is what the save shows.</AlertDescription></Alert>
      )}
      {own && aiUndecided.length > 0 && (
        <Alert className="border-amber-500/50">
          <Bot />
          <AlertDescription>
            MM's AI signed {aiUndecided.map((d) => d.sponsor).join(", ")} for you since the last apply. Keep {aiUndecided.length > 1 ? "them" : "it"}, or
            drop {aiUndecided.length > 1 ? "them" : "it"} and pay the upfront money back. Doing nothing keeps the deal.
          </AlertDescription>
        </Alert>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Tabs defaultValue="car">
        <TabsList variant="line">
          <TabsTrigger value="car"><Handshake /> Deals</TabsTrigger>
          <TabsTrigger value="stickers"><Sticker /> Stickers</TabsTrigger>
          <TabsTrigger value="offers"><Megaphone /> Offers <Badge variant="secondary" className="h-4 px-1.5 text-[10px] tabular-nums">{offers.length}</Badge></TabsTrigger>
        </TabsList>
        <TabsContent value="car" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SPONSOR_SLOTS.map((_, slot) => (
            <SlotCard key={slot} slot={slot} deal={deals.find((d) => d.slot === slot)} offers={offers.filter((o) => o.slot === slot).length} ctx={ctx} />
          ))}
        </TabsContent>
        <TabsContent value="stickers"><StickersPanel team={team} own={own || isPlayer} /></TabsContent>
        <TabsContent value="offers">
          <OffersTable offers={offers} deals={deals} ctx={ctx} />
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        MM makes the offers: sponsors approach teams over time, depending on the team's marketability (results and drivers). Each slot holds
        one deal, which runs its full length; MM counts the length in months, though its screens call them races. Per-race money and bonuses
        are paid in game after each race; the upfront money is paid when the deal starts at the next apply.
      </p>
    </div>
  )
}

interface SlotCtx {
  team: string
  own: boolean
  busy: string | null
  run: (key: string, fn: () => Promise<void>) => Promise<void>
  open: (kind: SponsorOrder["kind"], slot: number) => SponsorOrder | undefined
  gameDate: string
}

function SlotCard({ slot, deal, offers, ctx }: { slot: number; deal: SponsorDeal | undefined; offers: number; ctx: SlotCtx }) {
  const s = useSponsors()
  const sign = ctx.open("sign", slot)
  const drop = ctx.open("drop", slot)
  const keep = ctx.open("keep", slot)
  const ai = deal ? s.isAiDeal(deal, ctx.team) : false
  const spin = (key: string) => (ctx.busy === key ? <Loader2 className="animate-spin" /> : null)
  return (
    <Card size="sm" className={cn(ai && !keep && !drop && "border-amber-500/50", drop && "border-destructive/50", sign && "border-primary/40 bg-primary/5")}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <SlotName slot={slot} />
          {deal && ai && <Badge variant="outline" className="gap-1"><Bot className="size-3" /> AI deal</Badge>}
        </CardTitle>
        {deal && <CardDescription className="flex items-center gap-2"><Stars n={deal.prestige} /> {deal.category}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {deal ? (
          <>
            <span className={cn("text-base font-medium", drop && "line-through text-muted-foreground")}>{deal.sponsor}</span>
            <Income t={deal} />
            <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
              <Hourglass className="size-3.5" /> {deal.left} of {deal.length} month{deal.length === 1 ? "" : "s"} left
            </span>
            <span className="flex items-center gap-1 tabular-nums text-muted-foreground">
              <BadgeDollarSign className="size-3.5" /> {fmtMoneyShort(deal.earned)} received · {fmtMoneyShort(deal.upfront)} upfront
            </span>
            {ctx.own && ai && (
              drop ? (
                <Pending icon={X} text={`Ends at the next apply · ${fmtMoneyShort(drop.amount)} upfront paid back`}>
                  <Button size="sm" variant="ghost" disabled={!!ctx.busy} onClick={() => void ctx.run(`c${drop.id}`, () => s.cancel(drop.id))}>{spin(`c${drop.id}`) ?? <Undo2 />} Undo</Button>
                </Pending>
              ) : keep ? (
                <Pending icon={Check} text="Kept">
                  <Button size="sm" variant="ghost" disabled={!!ctx.busy} onClick={() => void ctx.run(`c${keep.id}`, () => s.cancel(keep.id))}>{spin(`c${keep.id}`) ?? <Undo2 />} Undo</Button>
                </Pending>
              ) : (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={!!ctx.busy} onClick={() => void ctx.run(`k${slot}`, () => s.keep(slot))}>{spin(`k${slot}`) ?? <Check />} Keep</Button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="sm" variant="outline" disabled={!!ctx.busy} onClick={() => void ctx.run(`d${slot}`, () => s.drop(slot))}>{spin(`d${slot}`) ?? <X />} Drop</Button>
                    </TooltipTrigger>
                    <TooltipContent>Frees the slot for an offer; pays back {fmtMoney(deal.upfront)}</TooltipContent>
                  </Tooltip>
                </div>
              )
            )}
            {!ai && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> Runs until it ends</span>}
          </>
        ) : (
          <span className="text-muted-foreground">No sponsor · {offers} offer{offers === 1 ? "" : "s"}</span>
        )}
        {sign && (
          <Pending icon={Handshake} text={`${sign.sponsor_name} signs at the next apply${sign.amount ? ` · +${fmtMoneyShort(sign.amount)} upfront` : ""}`}>
            {ctx.own && <Button size="sm" variant="ghost" disabled={!!ctx.busy} onClick={() => void ctx.run(`c${sign.id}`, () => s.cancel(sign.id))}>{spin(`c${sign.id}`) ?? <X />} Cancel</Button>}
          </Pending>
        )}
      </CardContent>
    </Card>
  )
}

function Pending({ icon: Icon, text, children }: { icon: LucideIcon; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/60 px-2 py-1 text-xs">
      <Icon className="size-3.5" /> <span>{text}</span>
      <span className="ml-auto">{children}</span>
    </div>
  )
}

function OffersTable({ offers, deals, ctx }: { offers: SponsorOffer[]; deals: SponsorDeal[]; ctx: SlotCtx }) {
  const s = useSponsors()
  if (!offers.length) {
    return <p className="py-4 text-sm text-muted-foreground">No offers right now. MM's sponsors look for teams every one to two weeks.</p>
  }
  const sorted = [...offers].sort((a, b) => a.slot - b.slot || guaranteed(b) - guaranteed(a))
  return (
    <Card size="sm">
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Slot</TableHead>
              <TableHead>Sponsor</TableHead>
              <TableHead className="text-right">Upfront</TableHead>
              <TableHead>Income</TableHead>
              <TableHead className="text-right">Length</TableHead>
              <TableHead className="text-right">Guaranteed</TableHead>
              <TableHead>Offer lapses</TableHead>
              {ctx.own && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((o) => {
              const current = deals.find((d) => d.slot === o.slot)
              const freed = !!ctx.open("drop", o.slot)
              const chosen = ctx.open("sign", o.slot)
              const soon = o.daysLeft <= 7
              const why = chosen ? (chosen.sponsor_id === o.sponsorId ? "Chosen" : "Another offer is chosen for this slot")
                : current && !freed ? `${current.sponsor} is on this slot` + (s.isAiDeal(current, ctx.team) ? " (drop it first)" : " until its deal ends")
                : null
              const key = `s${o.slot}${o.sponsorId}`
              return (
                <TableRow key={key}>
                  <TableCell><SlotName slot={o.slot} /></TableCell>
                  <TableCell>
                    <div className="font-medium">{o.sponsor}</div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground"><Stars n={o.prestige} /> {o.category}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{o.upfront ? fmtMoneyShort(o.upfront) : "—"}</TableCell>
                  <TableCell><Income t={o} /></TableCell>
                  <TableCell className="text-right tabular-nums">{o.length} mo</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Tooltip>
                      <TooltipTrigger className="tabular-nums">{fmtMoneyShort(guaranteed(o))}</TooltipTrigger>
                      <TooltipContent>Upfront + per-race money over {o.length} months{o.bonus > 0 ? ", plus race bonuses when earned" : ""}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    <span className={cn("flex items-center gap-1 tabular-nums", soon && "text-amber-600 dark:text-amber-400")}>
                      {soon ? <TriangleAlert className="size-3.5" /> : <CalendarClock className="size-3.5 text-muted-foreground" />}
                      {fmtDate(o.expires)} · {o.daysLeft} day{o.daysLeft === 1 ? "" : "s"}
                    </span>
                    {soon && <span className="text-xs text-muted-foreground">Signed only if the organizer applies before then</span>}
                  </TableCell>
                  {ctx.own && (
                    <TableCell className="text-right">
                      {why ? (
                        <span className="text-xs text-muted-foreground">{why}</span>
                      ) : (
                        <Button size="sm" disabled={!!ctx.busy} onClick={() => void ctx.run(key, () => s.sign(o.slot, o.sponsorId))}>
                          {ctx.busy === key ? <Loader2 className="animate-spin" /> : <Handshake />} Sign
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
