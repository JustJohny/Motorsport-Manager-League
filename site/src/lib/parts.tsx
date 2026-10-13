import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { planDesign } from "../../../src/part-design.ts"
import { customerStat, DEFAULT_LISTED, isCustomerPart } from "../../../src/part-market.ts"
import { useLeague } from "./league"
import { demoMode, supabase, watchTable } from "./supabase"
import type { Part, TeamDesign, TeamPrivate } from "./types"

export interface DesignOrder {
  id: number
  team: string
  part_type: string
  components: number[]
  cost: number
  status: "queued" | "applied" | "cancelled"
  created_at: string
}
export interface Fitting { team: string; car: 0 | 1; part_type: string; part_guid: string }
export interface Improvement { team: string; performance: string[]; reliability: string[]; split: number }
/** What a buyer gets: the customer spec as of the listing's publish (migration 029). */
export interface ListingPreview { name: string; level: number; stat: number; reliability: number | null; maxReliability: number | null; risk: number; components: number; materials: number }
export interface Listing { id: number; team: string; part_type: string; part_guid: string; price: number; preview: ListingPreview; status: "active" | "withdrawn"; created_at: string }
export interface Purchase {
  id: number; listing_id: number; buyer: string; seller: string; part_type: string; part_guid: string; copies: number
  price_each: number; materials_each: number; guids: string[]; fit_cars: number[]; status: "queued" | "applied" | "cancelled"; created_at: string
}
export interface MarketRule { season: number; listed: string[] }

interface PartsState {
  /** Queued and applied design orders of the member's team (the organizer sees every team's). */
  orders: DesignOrder[]
  fitting: Fitting[]
  improvement: Improvement[]
  /** First published game date: AI designs and parts after it are undone at the next apply. */
  leagueStart: string | null
  /** What a team's queued design and part purchases commit. */
  committed: (team: string) => number
  designCommitted: (team: string) => number
  purchaseCommitted: (team: string) => number
  /** The part market: active listings, the member's deals (buyer or seller), and the organizer's listed parts per season. */
  listings: Listing[]
  purchases: Purchase[]
  marketRules: MarketRule[]
  /** Part types every team must design itself in a season. */
  listedParts: (season: number) => string[]
  listPart: (type: string, guid: string, price: number) => Promise<void>
  withdrawListing: (id: number) => Promise<void>
  buyPart: (listingId: number, copies: number, fitCars: number[]) => Promise<void>
  cancelPurchase: (id: number) => Promise<void>
  setListedParts: (season: number, listed: string[]) => Promise<void>
  orderDesign: (type: string, components: number[]) => Promise<void>
  cancelDesign: (orderId: number) => Promise<void>
  setFitting: (car: 0 | 1, type: string, guid: string) => Promise<void>
  setImprovement: (performance: string[], reliability: string[], split: number) => Promise<void>
}

const Ctx = createContext<PartsState | null>(null)

export function useParts() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useParts outside PartsProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** A design the in-game AI started after the league began (cancelled at the next apply). */
export function isAiDesign(current: TeamDesign["current"], team: string, orders: DesignOrder[], leagueStart: string | null) {
  if (!current || !leagueStart || current.start <= leagueStart) return false
  return !orders.some((o) => o.team === team && o.status === "applied" && o.part_type === current.type && sameSet(o.components, current.components))
}

/** A part the AI designed and built after the league began (removed at the next apply). */
export function isAiPart(part: Part, type: string, team: string, orders: DesignOrder[], leagueStart: string | null) {
  if (!leagueStart || part.buildDate <= leagueStart || isCustomerPart(part.guid)) return false
  return !orders.some((o) => o.team === team && o.status !== "cancelled" && o.part_type === type && sameSet(o.components, part.componentIds ?? []))
}

/** What each car runs: the member's choice, else what the game has fitted. */
export function effectiveFitting(priv: TeamPrivate, team: string, fitting: Fitting[]) {
  const out: Record<string, [string | null, string | null]> = {}
  for (const [type, parts] of Object.entries(priv.parts)) {
    out[type] = [0, 1].map((car) =>
      fitting.find((f) => f.team === team && f.car === car && f.part_type === type
        // A banned part stays off the car (pull skips it), so the car keeps what the save has.
        && !parts.find((p) => p.guid === f.part_guid)?.banned)?.part_guid
      ?? parts.find((p) => p.fittedToCar === car)?.guid ?? null) as [string | null, string | null]
  }
  return out
}

export function PartsProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [orders, setOrders] = useState<DesignOrder[]>([])
  const [fitting, setFittingRows] = useState<Fitting[]>([])
  const [improvement, setImprovementRows] = useState<Improvement[]>([])
  const [leagueStart, setLeagueStart] = useState<string | null>(demoMode ? league.snapshot.gameDate : null)
  const [listings, setListings] = useState<Listing[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [marketRules, setMarketRules] = useState<MarketRule[]>([])

  const reload = useCallback(async () => {
    if (demoMode) return
    const [o, f, i, start] = await Promise.all([
      check(supabase!.from("design_orders").select("*").in("status", ["queued", "applied"]).order("created_at")),
      check(supabase!.from("part_fitting").select("*")),
      check(supabase!.from("part_improvement").select("*")),
      check(supabase!.rpc("league_start")),
    ])
    setOrders(((o ?? []) as DesignOrder[]).map((x) => ({ ...x, cost: Number(x.cost) })))
    setFittingRows((f ?? []) as Fitting[])
    setImprovementRows(((i ?? []) as Improvement[]).map((x) => ({ ...x, split: Number(x.split) })))
    setLeagueStart((start as string | null) ?? null)
    // The part market (migration 029): left empty until it's run.
    const [l, pu, r] = await Promise.all([
      supabase!.from("part_listings").select("*").eq("status", "active").order("created_at"),
      supabase!.from("part_purchases").select("*").neq("status", "cancelled").order("created_at"),
      supabase!.from("part_market_rules").select("*").order("season"),
    ])
    setListings(((l.data ?? []) as Listing[]).map((x) => ({ ...x, price: Number(x.price) })))
    setPurchases(((pu.data ?? []) as Purchase[]).map((x) => ({ ...x, price_each: Number(x.price_each), materials_each: Number(x.materials_each) })))
    setMarketRules((r.data ?? []) as MarketRule[])
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("parts")
    for (const table of ["design_orders", "part_fitting", "part_improvement", "part_listings", "part_purchases", "part_market_rules"]) {
      watchTable(channel, table, () => void reload())
    }
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const designCommitted = (team: string) => orders.filter((o) => o.team === team && o.status === "queued").reduce((s, o) => s + o.cost, 0)
  const purchaseCommitted = (team: string) => purchases.filter((x) => x.buyer === team && x.status === "queued").reduce((s, x) => s + x.price_each * x.copies, 0)
  // As listed_parts() in SQL: the latest choice up to that season, else the aero.
  const listedParts = (season: number) => [...marketRules].filter((r) => r.season <= season).sort((a, b) => b.season - a.season)[0]?.listed ?? [...DEFAULT_LISTED]

  const value: PartsState = {
    orders,
    fitting,
    improvement,
    leagueStart,
    committed: (team) => designCommitted(team) + purchaseCommitted(team),
    designCommitted,
    purchaseCommitted,
    listings,
    purchases,
    marketRules,
    listedParts,
    listPart: async (type, guid, price) => {
      if (demoMode) {
        const part = league.privateTeams[me.team]?.parts[type]?.find((x) => x.guid === guid)
        if (!part) throw new Error("That part isn't in the latest publish")
        const floor = league.snapshot.championship.partFloor?.[type] ?? 0
        const materials = league.privateTeams[me.team]?.design?.types[type]?.ctx.settings.materialsCost ?? 0
        const preview: ListingPreview = {
          name: part.name, level: part.level, stat: customerStat((part.stat ?? 0) + (part.performance ?? 0), floor), reliability: part.reliability,
          maxReliability: part.maxReliability, risk: part.rulesRisk ?? 0, components: part.componentIds.length, materials,
        }
        setListings((ls) => [...ls, { id: Date.now(), team: me.team, part_type: type, part_guid: guid, price, preview, status: "active", created_at: new Date().toISOString() }])
        return
      }
      await check(supabase!.rpc("list_part", { part_type: type, part_guid: guid, price }))
      await reload()
    },
    withdrawListing: async (id) => {
      if (demoMode) return setListings((ls) => ls.filter((l) => l.id !== id))
      await check(supabase!.rpc("withdraw_listing", { listing_id: id }))
      await reload()
    },
    buyPart: async (listingId, copies, fitCars) => {
      if (demoMode) {
        const l = listings.find((x) => x.id === listingId)!
        setPurchases((ps) => [...ps, {
          id: Date.now(), listing_id: listingId, buyer: me.team, seller: l.team, part_type: l.part_type, part_guid: l.part_guid, copies,
          price_each: l.price, materials_each: l.preview.materials, guids: [], fit_cars: fitCars, status: "queued", created_at: new Date().toISOString(),
        }])
        return
      }
      await check(supabase!.rpc("buy_part", { listing_id: listingId, copies, fit_cars: fitCars }))
      await reload()
    },
    cancelPurchase: async (id) => {
      if (demoMode) return setPurchases((ps) => ps.filter((x) => x.id !== id))
      await check(supabase!.rpc("cancel_purchase", { purchase_id: id }))
      await reload()
    },
    setListedParts: async (season, listed) => {
      if (demoMode) return setMarketRules((rs) => [...rs.filter((r) => r.season !== season), { season, listed }])
      await check(supabase!.rpc("set_listed_parts", { season, listed }))
      await reload()
    },
    orderDesign: async (type, components) => {
      if (demoMode) {
        // Demo: the same price and slot rules, no budget check.
        const opts = league.privateTeams[me.team]?.design?.types[type]
        if (!opts) throw new Error("Your team can't design that part")
        if (orders.some((o) => o.team === me.team && o.status === "queued")) throw new Error("You already have a design queued (MM designs one part at a time)")
        const plan = planDesign(opts.ctx, components.map((id) => opts.components.find((c) => c.id === id)!))
        setOrders((os) => [...os, { id: Date.now(), team: me.team, part_type: type, components, cost: plan.cost, status: "queued", created_at: new Date().toISOString() }])
        return
      }
      await check(supabase!.rpc("order_design", { part_type: type, components }))
      await reload()
    },
    cancelDesign: async (orderId) => {
      if (demoMode) return setOrders((os) => os.filter((o) => o.id !== orderId))
      await check(supabase!.rpc("cancel_design", { order_id: orderId }))
      await reload()
    },
    setFitting: async (car, type, guid) => {
      if (demoMode) {
        setFittingRows((fs) => [...fs.filter((f) => !(f.team === me.team && f.car === car && f.part_type === type)), { team: me.team, car, part_type: type, part_guid: guid }])
        return
      }
      await check(supabase!.rpc("set_fitting", { car, part_type: type, part_guid: guid }))
      await reload()
    },
    setImprovement: async (performance, reliability, split) => {
      if (demoMode) {
        setImprovementRows((is) => [...is.filter((i) => i.team !== me.team), { team: me.team, performance, reliability, split }])
        return
      }
      await check(supabase!.rpc("set_improvement", { performance, reliability, split }))
      await reload()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
