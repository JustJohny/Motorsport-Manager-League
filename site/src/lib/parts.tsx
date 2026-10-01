import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { planDesign } from "../../../src/part-design.ts"
import { useLeague } from "./league"
import { demoMode, supabase } from "./supabase"
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

interface PartsState {
  /** Queued and applied design orders of the member's team (the organizer sees every team's). */
  orders: DesignOrder[]
  fitting: Fitting[]
  improvement: Improvement[]
  /** First published game date: AI designs and parts after it are undone at the next apply. */
  leagueStart: string | null
  /** What a team's queued design commits. */
  committed: (team: string) => number
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
  if (!leagueStart || part.buildDate <= leagueStart) return false
  return !orders.some((o) => o.team === team && o.status !== "cancelled" && o.part_type === type && sameSet(o.components, part.componentIds ?? []))
}

/** What each car runs: the member's choice, else what the game has fitted. */
export function effectiveFitting(priv: TeamPrivate, team: string, fitting: Fitting[]) {
  const out: Record<string, [string | null, string | null]> = {}
  for (const [type, parts] of Object.entries(priv.parts)) {
    out[type] = [0, 1].map((car) =>
      fitting.find((f) => f.team === team && f.car === car && f.part_type === type)?.part_guid
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
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("parts")
    for (const table of ["design_orders", "part_fitting", "part_improvement"]) {
      channel.on("postgres_changes", { event: "*", schema: "public", table }, () => void reload())
    }
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const value: PartsState = {
    orders,
    fitting,
    improvement,
    leagueStart,
    committed: (team) => orders.filter((o) => o.team === team && o.status === "queued").reduce((s, o) => s + o.cost, 0),
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
