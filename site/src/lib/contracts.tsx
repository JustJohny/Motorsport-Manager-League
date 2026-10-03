import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { useLeague } from "./league"
import { demoMode, supabase, watchTable } from "./supabase"

export interface RenewalOrder {
  id: number
  team: string
  person_guid: string
  person_name: string
  kind: string
  years: number
  yearly_wage: number
  sign_on_fee: number
  end_before: string
  new_end: string
  status: "queued" | "applied" | "cancelled"
  created_at: string
}

interface ContractsState {
  /** The member's team's queued and applied renewals (the organizer sees every team's). */
  orders: RenewalOrder[]
  /** Sign-on fees of queued renewals. */
  committed: (team: string) => number
  renew: (personGuid: string, years: number) => Promise<void>
  cancel: (orderId: number) => Promise<void>
}

const Ctx = createContext<ContractsState | null>(null)

export function useContracts() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useContracts outside ContractsProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

export function ContractsProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [orders, setOrders] = useState<RenewalOrder[]>([])

  const reload = useCallback(async () => {
    if (demoMode) return
    const rows = await check(supabase!.from("contract_renewals").select("*").in("status", ["queued", "applied"]).order("created_at"))
      // Before migration 018 the table doesn't exist: no renewals.
      .catch(() => [])
    setOrders(((rows ?? []) as RenewalOrder[]).map((x) => ({ ...x, yearly_wage: Number(x.yearly_wage), sign_on_fee: Number(x.sign_on_fee) })))
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("contracts")
    watchTable(channel, "contract_renewals", () => void reload())
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const contracts = league.privateTeams[me.team]?.contracts
  const value: ContractsState = {
    orders,
    committed: (team) => orders.filter((o) => o.team === team && o.status === "queued").reduce((s, o) => s + o.sign_on_fee, 0),
    renew: async (personGuid, years) => {
      if (demoMode) {
        const r = contracts?.renewals.find((x) => x.guid === personGuid)
        if (!r) throw new Error("That person's contract isn't up for renewal")
        if (r.refusal) throw new Error(`${r.name} won't renew: ${r.refusal}`)
        if (orders.some((o) => o.team === me.team && o.person_guid === personGuid && o.status === "queued")) throw new Error(`You already renewed ${r.name}; cancel it first to change it`)
        return setOrders((os) => [...os, {
          id: Date.now(), team: me.team, person_guid: personGuid, person_name: r.name, kind: r.kind, years, yearly_wage: r.askingWage,
          sign_on_fee: r.signOnFee, end_before: r.end, new_end: `${Number(r.end.slice(0, 4)) + years}-12-31T00:00:00.0000000`,
          status: "queued", created_at: new Date().toISOString(),
        }])
      }
      await check(supabase!.rpc("renew_contract", { person_guid: personGuid, years }))
      await reload()
    },
    cancel: async (orderId) => {
      if (demoMode) return setOrders((os) => os.filter((o) => o.id !== orderId))
      await check(supabase!.rpc("cancel_renewal", { order_id: orderId }))
      await reload()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
