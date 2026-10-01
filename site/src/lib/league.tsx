import type { Session } from "@supabase/supabase-js"
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { demoMode, supabase } from "./supabase"
import type { LeagueMemberRow, LeagueState, Person, PublicSnapshot, TeamPrivate } from "./types"

export interface LoginRow {
  discord_username: string
  display_name: string | null
  last_seen: string
}

export interface League {
  snapshotId: number
  publishedAt: string
  snapshot: PublicSnapshot
  /** Team name -> private data. Members get their own team only; the organizer gets every team. */
  privateTeams: Record<string, TeamPrivate>
  freeAgents: Person[]
  members: LeagueMemberRow[]
  logins: LoginRow[]
}

type Status =
  | { kind: "loading" }
  | { kind: "signedOut" }
  | { kind: "notMember"; username: string }
  | { kind: "noSnapshot"; me: LeagueMemberRow }
  | { kind: "error"; message: string }
  | { kind: "ready"; me: LeagueMemberRow; league: League }

interface Ctx {
  status: Status
  session: Session | null
  signIn: () => Promise<void>
  signOut: () => Promise<void>
}

const LeagueContext = createContext<Ctx | null>(null)

export function useLeagueContext() {
  const ctx = useContext(LeagueContext)
  if (!ctx) throw new Error("useLeagueContext outside LeagueProvider")
  return ctx
}

/** For pages rendered only once the league has loaded. */
export function useLeague() {
  const { status } = useLeagueContext()
  if (status.kind !== "ready") throw new Error("league not loaded")
  return { me: status.me, league: status.league }
}

async function loadDemo(): Promise<Status> {
  const res = await fetch(`${import.meta.env.BASE_URL}demo-state.json`)
  if (!res.ok) return { kind: "error", message: "Demo mode: run `mmsave extract … -o site/public/demo-state.json` first." }
  const state = (await res.json()) as LeagueState
  const organizer = state.teams.find((t) => t.isPlayerTeam) ?? state.teams[0]
  const me: LeagueMemberRow = { discord_username: "demo", member: organizer.member ?? "organizer", team: organizer.name, role: "organizer" }
  const members = state.teams.filter((t) => t.member).map((t): LeagueMemberRow => ({
    discord_username: t.member!, member: t.member!, team: t.name, role: t.name === me.team ? "organizer" : "member",
  }))
  return {
    kind: "ready",
    me,
    league: {
      snapshotId: 0,
      publishedAt: state.extractedAt,
      snapshot: {
        extractedAt: state.extractedAt,
        gameDate: state.gameDate,
        championship: state.championship,
        teams: state.teams.map(({ budget: _b, hq: _h, parts: _p, design: _d, ...pub }) => pub),
      },
      // Older extracts have no design data.
      privateTeams: Object.fromEntries(state.teams.map((t) => [t.name, { budget: t.budget, hq: t.hq, parts: t.parts, design: t.design ?? null }])),
      freeAgents: state.freeAgents,
      members,
      logins: [],
    },
  }
}

async function loadLeague(): Promise<Status> {
  const sb = supabase!
  await sb.rpc("touch_login")
  const meRes = await sb.rpc("my_member")
  if (meRes.error) return { kind: "error", message: meRes.error.message }
  const me = meRes.data as LeagueMemberRow | null
  if (!me?.discord_username) {
    const { data } = await sb.auth.getUser()
    const name = String(data.user?.user_metadata?.name ?? "").split("#")[0] || "(unknown)"
    return { kind: "notMember", username: name.toLowerCase() }
  }

  const snap = await sb.from("snapshots").select("id, created_at, public").order("id", { ascending: false }).limit(1).maybeSingle()
  if (snap.error) return { kind: "error", message: snap.error.message }
  if (!snap.data) return { kind: "noSnapshot", me }

  const id = snap.data.id as number
  const [teams, market, members, logins] = await Promise.all([
    sb.from("team_snapshots").select("team, private").eq("snapshot_id", id),
    sb.from("market_snapshots").select("free_agents").eq("snapshot_id", id).maybeSingle(),
    sb.from("league_members").select("*"),
    sb.from("logins").select("discord_username, display_name, last_seen"),
  ])
  const err = teams.error ?? market.error ?? members.error ?? logins.error
  if (err) return { kind: "error", message: err.message }

  return {
    kind: "ready",
    me,
    league: {
      snapshotId: id,
      publishedAt: snap.data.created_at as string,
      snapshot: snap.data.public as PublicSnapshot,
      privateTeams: Object.fromEntries((teams.data ?? []).map((r) => [r.team as string, r.private as TeamPrivate])),
      freeAgents: (market.data?.free_agents ?? []) as Person[],
      members: (members.data ?? []) as LeagueMemberRow[],
      logins: (logins.data ?? []) as LoginRow[],
    },
  }
}

export function LeagueProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<Status>({ kind: "loading" })

  useEffect(() => {
    if (demoMode) {
      loadDemo().then(setStatus, (e: Error) => setStatus({ kind: "error", message: e.message }))
      return
    }
    let userId: string | undefined | null = null
    const { data } = supabase!.auth.onAuthStateChange((_event, s) => {
      setSession(s)
      // Token refreshes and tab refocus fire events too; only reload when the user changes.
      if (s?.user.id === userId) return
      userId = s?.user.id
      if (!s) return setStatus({ kind: "signedOut" })
      setStatus({ kind: "loading" })
      // Defer: supabase-js must not be called from inside its own auth callback.
      setTimeout(() => loadLeague().then(setStatus, (e: Error) => setStatus({ kind: "error", message: e.message })))
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const signIn = useCallback(async () => {
    await supabase?.auth.signInWithOAuth({
      provider: "discord",
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    })
  }, [])
  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
  }, [])

  return <LeagueContext.Provider value={{ status, session, signIn, signOut }}>{children}</LeagueContext.Provider>
}
