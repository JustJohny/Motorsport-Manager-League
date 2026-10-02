import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { hqName } from "../../../src/hq-info.ts"
import { useLeague } from "./league"
import { nextHqStep, unorderedProject } from "./rules"
import { demoMode, supabase, watchTable } from "./supabase"

export interface HqOrder {
  id: number
  team: string
  building_type: number
  building_name: string
  to_level: number
  cost: number
  weeks: number
  status: "queued" | "applied" | "cancelled"
  created_at: string
}

interface HqOrders {
  /** Queued orders of the member's team (the organizer also sees other teams'). */
  orders: HqOrder[]
  /** Applied orders: constructions the league started (tells them apart from AI projects). */
  applied: HqOrder[]
  /** First published game date; AI projects are those started after it. */
  leagueStart: string | null
  committed: (team: string) => number
  order: (buildingType: number) => Promise<void>
  cancel: (orderId: number) => Promise<void>
}

const HqContext = createContext<HqOrders | null>(null)

export function useHqOrders() {
  const ctx = useContext(HqContext)
  if (!ctx) throw new Error("useHqOrders outside HqOrdersProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

export function HqOrdersProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [orders, setOrders] = useState<HqOrder[]>([])
  const [applied, setApplied] = useState<HqOrder[]>([])
  const [leagueStart, setLeagueStart] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (demoMode) return
    const [all, start] = await Promise.all([
      check(supabase!.from("hq_orders").select("*").in("status", ["queued", "applied"]).order("created_at")),
      check(supabase!.rpc("league_start")),
    ])
    const list = (all ?? []) as HqOrder[]
    setOrders(list.filter((o) => o.status === "queued"))
    setApplied(list.filter((o) => o.status === "applied"))
    setLeagueStart((start as string | null) ?? null)
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = watchTable(supabase!.channel("hq_orders"), "hq_orders", () => void reload()).subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const value: HqOrders = {
    orders,
    applied,
    leagueStart,
    committed: (team) => orders.filter((o) => o.team === team).reduce((s, o) => s + Number(o.cost), 0),
    order: async (buildingType) => {
      if (demoMode) {
        // Demo: same price and time rules, no budget or prerequisite checks.
        const b = league.privateTeams[me.team]?.hq.find((x) => x.type === buildingType)
        const step = b && nextHqStep(b, unorderedProject(b, [], leagueStart))
        if (!b || !step) throw new Error("Can't order that")
        if (orders.some((o) => o.building_type === buildingType)) throw new Error(`${hqName(b.type, b.name)} already has a queued order`)
        setOrders((os) => [...os, { id: Date.now(), team: me.team, building_type: buildingType, building_name: hqName(b.type, b.name), to_level: step.toLevel, cost: step.cost, weeks: step.weeks, status: "queued", created_at: new Date().toISOString() }])
        return
      }
      await check(supabase!.rpc("order_hq", { building_type: buildingType }))
      await reload()
    },
    cancel: async (orderId) => {
      if (demoMode) return setOrders((os) => os.filter((o) => o.id !== orderId))
      await check(supabase!.rpc("cancel_hq", { order_id: orderId }))
      await reload()
    },
  }
  return <HqContext.Provider value={value}>{children}</HqContext.Provider>
}
