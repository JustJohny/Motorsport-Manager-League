import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { useLeague } from "./league"
import { demoMode, supabase, watchTable } from "./supabase"
import type { SponsorDeal } from "./types"

export interface SponsorOrder {
  id: number
  team: string
  kind: "sign" | "drop" | "keep"
  slot: number
  sponsor_id: string
  sponsor_name: string
  amount: number
  expires: string | null
  status: "queued" | "applied" | "cancelled" | "expired" | "kept"
  created_at: string
}

interface SponsorsState {
  /** The member's team's open and applied choices (the organizer sees every team's). */
  orders: SponsorOrder[]
  leagueStart: string | null
  /** Upfront money that queued drops pay back. */
  committed: (team: string) => number
  /** A deal MM's AI signed since the league began that no league order signed. */
  isAiDeal: (deal: SponsorDeal, team: string) => boolean
  sign: (slot: number, sponsorId: string) => Promise<void>
  drop: (slot: number) => Promise<void>
  keep: (slot: number) => Promise<void>
  cancel: (orderId: number) => Promise<void>
}

const Ctx = createContext<SponsorsState | null>(null)

export function useSponsors() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useSponsors outside SponsorsProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

export function SponsorsProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [orders, setOrders] = useState<SponsorOrder[]>([])
  const [leagueStart, setLeagueStart] = useState<string | null>(demoMode ? league.snapshot.gameDate : null)

  const reload = useCallback(async () => {
    if (demoMode) return
    const [o, start] = await Promise.all([
      check(supabase!.from("sponsor_orders").select("*").in("status", ["queued", "applied", "kept"]).order("created_at")),
      check(supabase!.rpc("league_start")),
    ])
    setOrders(((o ?? []) as SponsorOrder[]).map((x) => ({ ...x, amount: Number(x.amount) })))
    setLeagueStart((start as string | null) ?? null)
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("sponsors")
    watchTable(channel, "sponsor_orders", () => void reload())
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const priv = league.privateTeams[me.team]?.sponsorship
  const add = (o: Omit<SponsorOrder, "id" | "team" | "created_at">) =>
    setOrders((os) => [...os, { ...o, id: Date.now(), team: me.team, created_at: new Date().toISOString() }])

  const value: SponsorsState = {
    orders,
    leagueStart,
    committed: (team) => orders.filter((o) => o.team === team && o.kind === "drop" && o.status === "queued").reduce((s, o) => s + o.amount, 0),
    isAiDeal: (deal, team) =>
      !!leagueStart && deal.offerDate >= leagueStart
      && !orders.some((o) => o.team === team && o.kind === "sign" && o.status === "applied" && o.slot === deal.slot && o.sponsor_id === deal.sponsorId),
    sign: async (slot, sponsorId) => {
      if (demoMode) {
        const offer = priv?.offers.find((o) => o.slot === slot && o.sponsorId === sponsorId)
        if (!offer) throw new Error("That offer isn't on your list")
        if (orders.some((o) => o.team === me.team && o.kind === "sign" && o.status === "queued" && o.slot === slot)) throw new Error("You already chose a sponsor for that slot; cancel it first")
        return add({ kind: "sign", slot, sponsor_id: sponsorId, sponsor_name: offer.sponsor, amount: offer.upfront, expires: offer.expires, status: "queued" })
      }
      await check(supabase!.rpc("sign_sponsor", { slot, sponsor_id: sponsorId }))
      await reload()
    },
    drop: async (slot) => {
      if (demoMode) {
        const deal = priv?.deals.find((d) => d.slot === slot)
        if (!deal) throw new Error("That slot has no sponsor")
        setOrders((os) => os.filter((o) => !(o.team === me.team && o.kind === "keep" && o.slot === slot)))
        return add({ kind: "drop", slot, sponsor_id: deal.sponsorId, sponsor_name: deal.sponsor, amount: deal.upfront, expires: null, status: "queued" })
      }
      await check(supabase!.rpc("drop_sponsor", { slot }))
      await reload()
    },
    keep: async (slot) => {
      if (demoMode) {
        const deal = priv?.deals.find((d) => d.slot === slot)
        if (!deal) throw new Error("That slot has no sponsor")
        setOrders((os) => os.filter((o) => !(o.team === me.team && o.status === "queued" && o.slot === slot)))
        return add({ kind: "keep", slot, sponsor_id: deal.sponsorId, sponsor_name: deal.sponsor, amount: 0, expires: null, status: "kept" })
      }
      await check(supabase!.rpc("keep_sponsor", { slot }))
      await reload()
    },
    cancel: async (orderId) => {
      if (demoMode) {
        const o = orders.find((x) => x.id === orderId)
        return setOrders((os) => os.filter((x) => x.id !== orderId && !(o?.kind === "drop" && x.team === o.team && x.kind === "sign" && x.status === "queued" && x.slot === o.slot)))
      }
      await check(supabase!.rpc("cancel_sponsor_order", { order_id: orderId }))
      await reload()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
