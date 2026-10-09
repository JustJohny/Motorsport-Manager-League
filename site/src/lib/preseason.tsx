import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { replay, type Lineup, type PreseasonMove, type PreseasonMoveKind } from "../../../src/preseason.ts"
import { contractEnd, minWage } from "./rules"
import { useLeague } from "./league"
import { demoMode, supabase, watchTable } from "./supabase"
import { useTransfers } from "./transfers"

export type { Lineup, PreseasonMove, Seat } from "../../../src/preseason.ts"
export { SEAT_LABEL } from "./seat-labels"

export interface SupplierPick {
  team: string
  supplier_type: string
  supplier_id: number
  supplier_name: string
  applied_at: string | null
}

interface PreseasonState {
  /** The organizer has the pre-season open. */
  open: boolean
  /** Every team's queued moves, oldest first (signings and line-ups are public). */
  moves: PreseasonMove[]
  /** The member's own picks for this season's suppliers (the organizer sees every team's). */
  picks: SupplierPick[]
  /** The team's line-up after its queued moves. */
  lineup: (team: string) => Lineup | null
  /** The team that signed this free agent in pre-season, if any. */
  signedBy: (guid: string) => string | null
  sign: (personGuid: string, replacingGuid: string | null, years: number) => Promise<void>
  move: (kind: Exclude<PreseasonMoveKind, "sign">, personGuid?: string, otherGuid?: string) => Promise<void>
  undo: () => Promise<void>
  pickSupplier: (type: string, id: number) => Promise<void>
  clearSupplier: (type: string) => Promise<void>
  setOpen: (open: boolean) => Promise<void>
}

const Ctx = createContext<PreseasonState | null>(null)

export function usePreseason() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("usePreseason outside PreseasonProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

export function PreseasonProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const { settings } = useTransfers()
  // The demo shows it open.
  const [open, setOpenState] = useState(demoMode)
  const [moves, setMoves] = useState<PreseasonMove[]>([])
  const [picks, setPicks] = useState<SupplierPick[]>([])

  const reload = useCallback(async () => {
    if (demoMode) return
    // Before migration 022 the tables and the column don't exist: no pre-season.
    const [s, m, p] = await Promise.all([
      check(supabase!.from("league_settings").select("preseason").maybeSingle()).catch(() => null),
      check(supabase!.from("preseason_moves").select("*").eq("status", "queued").order("created_at").order("id")).catch(() => []),
      check(supabase!.from("preseason_suppliers").select("*").is("applied_at", null)).catch(() => []),
    ])
    setOpenState(!!(s as { preseason?: boolean } | null)?.preseason)
    setMoves((m ?? []) as PreseasonMove[])
    setPicks(((p ?? []) as SupplierPick[]).map((x) => ({ ...x, supplier_id: Number(x.supplier_id) })))
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("preseason")
    watchTable(channel, "preseason_moves", () => void reload())
    watchTable(channel, "preseason_suppliers", () => void reload())
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const lineups = useMemo(() => {
    const out = new Map<string, Lineup>()
    for (const t of league.snapshot.teams) out.set(t.name, replay(t.name, t.staff, moves.filter((m) => m.team === t.name)))
    return out
  }, [league.snapshot.teams, moves])

  /** Demo mode: the move as the database would store it. */
  const local = (m: Partial<PreseasonMove> & { kind: PreseasonMoveKind }): PreseasonMove => ({
    id: Date.now(), team: me.team, person_guid: null, person_name: null, other_guid: null, other_name: null, years: null,
    yearly_wage: null, new_end: null, person: null, status: "queued", created_at: new Date().toISOString(), ...m,
  })
  const staffName = (guid?: string) => {
    const l = lineups.get(me.team)
    return l?.seats.map((s) => s.person ?? s.leaving).find((p) => p?.guid === guid)?.name ?? null
  }

  const value: PreseasonState = {
    open,
    moves,
    picks,
    lineup: (team) => lineups.get(team) ?? null,
    signedBy: (guid) => moves.find((m) => m.kind === "sign" && m.person_guid === guid)?.team ?? null,
    sign: async (personGuid, replacingGuid, years) => {
      if (demoMode) {
        const p = league.freeAgents.find((x) => x.guid === personGuid)
        if (!p) throw new Error("Only free agents can be signed in pre-season")
        const by = moves.find((m) => m.kind === "sign" && m.person_guid === personGuid)?.team
        if (by) throw new Error(`${p.name} has already been signed by ${by}`)
        return setMoves((ms) => [...ms, local({
          kind: "sign", person_guid: p.guid, person_name: p.name, other_guid: replacingGuid, other_name: staffName(replacingGuid ?? undefined),
          years, yearly_wage: minWage(p, settings), new_end: contractEnd(league.snapshot.gameDate, years), person: p,
        })])
      }
      await check(supabase!.rpc("preseason_sign", { person_guid: personGuid, replacing_guid: replacingGuid, years }))
      await reload()
    },
    move: async (kind, personGuid, otherGuid) => {
      if (demoMode) {
        return setMoves((ms) => [...ms, local({
          kind, person_guid: personGuid ?? null, person_name: staffName(personGuid), other_guid: otherGuid ?? null, other_name: staffName(otherGuid),
        })])
      }
      await check(supabase!.rpc("preseason_move", { kind, person_guid: personGuid ?? null, other_guid: otherGuid ?? null }))
      await reload()
    },
    undo: async () => {
      if (demoMode) {
        const last = moves.filter((m) => m.team === me.team).at(-1)
        if (!last) throw new Error("Nothing to undo")
        return setMoves((ms) => ms.filter((m) => m !== last))
      }
      await check(supabase!.rpc("preseason_undo"))
      await reload()
    },
    pickSupplier: async (type, id) => {
      if (demoMode) {
        const o = league.privateTeams[me.team]?.design?.currentCar?.options[type]?.find((x) => x.id === id)
        if (!o) throw new Error("That supplier isn't available to your team")
        return setPicks((ps) => [...ps.filter((x) => !(x.team === me.team && x.supplier_type === type)),
          { team: me.team, supplier_type: type, supplier_id: id, supplier_name: o.name, applied_at: null }])
      }
      await check(supabase!.rpc("preseason_supplier", { supplier_type: type, supplier_id: id }))
      await reload()
    },
    clearSupplier: async (type) => {
      if (demoMode) return setPicks((ps) => ps.filter((x) => !(x.team === me.team && x.supplier_type === type)))
      await check(supabase!.rpc("clear_preseason_supplier", { supplier_type: type }))
      await reload()
    },
    setOpen: async (o) => {
      if (demoMode) return setOpenState(o)
      await check(supabase!.rpc("set_preseason", { open: o }))
      await reload()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
