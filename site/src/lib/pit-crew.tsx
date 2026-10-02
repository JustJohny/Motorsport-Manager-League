import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  applicant, assignRole, crewMember, crewRow, applicantRow, CREW_SETTINGS, fillEmptyRoles, refillApplicants, RESERVE, startingCrew,
  type Applicant, type CrewMember, type CrewPersonRow, type CrewRow, type NamePool,
} from "../../../src/pit-crew.ts"
import { useLeague } from "./league"
import { demoMode, supabase, watchTable } from "./supabase"

export interface CrewTeam { team: string; funding: number; processed_round: number }
export interface CrewSpend { id: number; team: string; kind: "wages" | "funding" | "signon"; description: string; amount: number; status: string }
export interface CrewLog { id: number; team: string; round: number | null; message: string; created_at: string }

interface CrewState {
  /** Site-run crews the user may see: the member's own (the organizer sees every team's). */
  teams: CrewTeam[]
  crewOf: (team: string) => (CrewMember & { id: number })[]
  applicantsOf: (team: string) => (Applicant & { id: number })[]
  logOf: (team: string) => CrewLog[]
  /** Queued crew costs (sign-on fees, last races' wages and funding), charged at the next apply. */
  committed: (team: string) => number
  setRole: (id: number, role: number) => Promise<void>
  setFunding: (level: number) => Promise<void>
  sign: (applicantId: number) => Promise<void>
  release: (id: number) => Promise<void>
  renew: (id: number) => Promise<void>
}

const Ctx = createContext<CrewState | null>(null)

export function usePitCrew() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("usePitCrew outside PitCrewProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

/** Demo: names from the snapshot's people, by nationality. */
function demoNames(people: { name: string; nationality: string | null }[]): NamePool {
  const pool: NamePool = {}
  for (const p of people) {
    const [first, ...rest] = p.name.split(" ")
    if (!p.nationality || !rest.length) continue
    const e = (pool[p.nationality] ??= { first: [], last: [] })
    if (!e.first.includes(first)) e.first.push(first)
    if (!e.last.includes(rest.join(" "))) e.last.push(rest.join(" "))
  }
  for (const k of Object.keys(pool)) if (pool[k].first.length < 2) delete pool[k]
  return pool
}

export function PitCrewProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [teams, setTeams] = useState<CrewTeam[]>([])
  const [crew, setCrew] = useState<CrewRow[]>([])
  const [applicants, setApplicants] = useState<CrewPersonRow[]>([])
  const [spend, setSpend] = useState<CrewSpend[]>([])
  const [log, setLog] = useState<CrewLog[]>([])

  const reload = useCallback(async () => {
    if (demoMode) return
    const [t, c, a, s, l] = await Promise.all([
      check(supabase!.from("pit_crew_teams").select("*")),
      check(supabase!.from("pit_crew").select("*").order("id")),
      check(supabase!.from("pit_crew_applicants").select("*").order("id")),
      check(supabase!.from("crew_spend").select("*").eq("status", "queued").order("created_at")),
      check(supabase!.from("pit_crew_log").select("*").order("id", { ascending: false }).limit(200)),
    ])
    setTeams((t ?? []) as CrewTeam[])
    setCrew((c ?? []) as CrewRow[])
    setApplicants((a ?? []) as CrewPersonRow[])
    setSpend(((s ?? []) as CrewSpend[]).map((x) => ({ ...x, amount: Number(x.amount) })))
    setLog((l ?? []) as CrewLog[])
  }, [])

  // Demo: every AI team gets the starting crew the toolkit would make.
  useEffect(() => {
    if (!demoMode) return
    const snap = league.snapshot
    const rules = snap.championship.pitCrew
    if (!rules) return
    const names = demoNames([...snap.teams.flatMap((t) => t.staff.flatMap((s) => (s.person ? [s.person] : []))), ...league.freeAgents])
    if (!Object.keys(names).length) return
    const ai = snap.teams.filter((t) => !league.privateTeams[t.name]?.gameCrew)
    let id = 1
    const round = snap.championship.lastRace?.round ?? 0
    setTeams(ai.map((t) => ({ team: t.name, funding: 1, processed_round: round })))
    setCrew(ai.flatMap((t) => startingCrew("demo", t.name, rules.aiLevel, rules.roles, names, snap.gameDate, snap.championship.calendar.length)
      .map((c) => ({ ...crewRow(c), id: id++, team: t.name }))))
    setApplicants(ai.flatMap((t) => refillApplicants([], "demo", t.name, round, names, snap.gameDate).map((a) => ({ ...applicantRow(a), id: id++, team: t.name }))))
  }, [league])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("pit-crew")
    for (const table of ["pit_crew_teams", "pit_crew", "pit_crew_applicants", "crew_spend", "pit_crew_log"]) watchTable(channel, table, () => void reload())
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const value = useMemo<CrewState>(() => {
    const roles = league.snapshot.championship.pitCrew?.roles ?? []
    const demoLog = (message: string) => setLog((ls) => [{ id: Date.now(), team: me.team, round: league.snapshot.championship.lastRace?.round ?? null, message, created_at: new Date().toISOString() }, ...ls])
    const mine = () => crew.filter((c) => c.team === me.team).map((r) => ({ ...crewMember(r), id: r.id! }))
    const putMine = (list: CrewMember[]) => setCrew((cs) => [...cs.filter((c) => c.team !== me.team), ...list.map((c) => ({ ...crewRow(c), team: me.team }))])
    const rpc = async (fn: string, args: Record<string, unknown>) => { await check(supabase!.rpc(fn, args)); await reload() }
    return {
      teams,
      crewOf: (team) => crew.filter((c) => c.team === team).map((r) => ({ ...crewMember(r), id: r.id! })),
      applicantsOf: (team) => applicants.filter((a) => a.team === team).map((r) => ({ ...applicant(r), id: r.id! })),
      logOf: (team) => log.filter((l) => l.team === team),
      committed: (team) => spend.filter((s) => s.team === team && s.status === "queued").reduce((sum, s) => sum + s.amount, 0),
      setRole: async (id, role) => {
        if (!demoMode) return rpc("set_crew_role", { crew_id: id, role })
        if (role === RESERVE) throw new Error("Put someone else in that position instead")
        putMine(assignRole(mine(), id, role))
      },
      setFunding: async (level) => {
        if (!demoMode) return rpc("set_crew_funding", { level })
        setTeams((ts) => ts.map((t) => (t.team === me.team ? { ...t, funding: level } : t)))
      },
      sign: async (applicantId) => {
        if (!demoMode) return rpc("sign_crew_applicant", { applicant_id: applicantId })
        const a = applicants.find((x) => x.id === applicantId)
        if (!a) return
        if (mine().length >= CREW_SETTINGS.maxCrew) throw new Error(`Your crew is full (${CREW_SETTINGS.maxCrew} people); release someone first`)
        setApplicants((as) => as.filter((x) => x.id !== applicantId))
        setCrew((cs) => [...cs, { ...a, team: me.team, role: RESERVE, races_left: 2 * league.snapshot.championship.calendar.length + 1 }])
        setSpend((ss) => [...ss, { id: Date.now(), team: me.team, kind: "signon", description: `${a.first_name[0]}. ${a.last_name} - Sign On Fee`, amount: CREW_SETTINGS.signOnFee, status: "queued" }])
        demoLog(`Signed ${a.first_name} ${a.last_name}`)
      },
      release: async (id) => {
        if (!demoMode) return rpc("release_crew", { crew_id: id })
        const who = mine().find((c) => c.id === id)
        if (!who) return
        const rest = mine().filter((c) => c.id !== id)
        if (who.role !== RESERVE && !rest.some((c) => c.role === RESERVE)) throw new Error("Nobody in reserve to take that position; sign someone first")
        putMine(fillEmptyRoles(rest, roles))
        demoLog(`Released ${who.firstName} ${who.lastName}`)
      },
      renew: async (id) => {
        if (!demoMode) return rpc("renew_crew", { crew_id: id })
        throw new Error("Demo: renewals need the league database")
      },
    }
  }, [teams, crew, applicants, spend, log, me.team, league, reload])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
