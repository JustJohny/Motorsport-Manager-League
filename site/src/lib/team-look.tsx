import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { useLeague } from "./league"
import { assetUrl, demoMode, seriesId, supabase, watchTable } from "./supabase"
import type { TeamColours } from "./types"

/** A team's chosen look (migration 019). Applied at the next race; shows in game with the team mod. */
export interface TeamLookRow {
  team: string
  primary_colour: string
  secondary_colour: string
  tertiary_colour: string
  trim_colour: string
  livery_id: number
  color_id: number
  updated_at: string
}

export interface TeamLogoRow {
  id: number
  team: string
  path: string
  status: "pending" | "approved" | "rejected" | "withdrawn" | "replaced"
  note: string | null
  created_at: string
  reviewed_at: string | null
}

export const LOGO_TYPES = ["image/png", "image/webp", "image/jpeg"]
export const LOGO_MAX_BYTES = 1024 * 1024

interface TeamLookState {
  /** Every team's saved look in this series (looks are public, like the cars). */
  looks: TeamLookRow[]
  /** Approved logos of every team, plus the member's own pending and rejected ones (the organizer sees all). */
  logos: TeamLogoRow[]
  /** The colours a team shows: its saved look, else what the save has. */
  coloursOf: (team: string) => TeamColours | null
  logoUrl: (logo: TeamLogoRow) => string
  approvedLogo: (team: string) => TeamLogoRow | undefined
  save: (colours: TeamColours, liveryId: number) => Promise<void>
  uploadLogo: (file: File) => Promise<void>
  withdrawLogo: (id: number) => Promise<void>
  reviewLogo: (id: number, approve: boolean, note?: string) => Promise<void>
}

const Ctx = createContext<TeamLookState | null>(null)

export function useTeamLook() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error("useTeamLook outside TeamLookProvider")
  return ctx
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

export const lookColours = (r: TeamLookRow): TeamColours =>
  ({ primary: r.primary_colour, secondary: r.secondary_colour, tertiary: r.tertiary_colour, trim: r.trim_colour })

export function TeamLookProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [looks, setLooks] = useState<TeamLookRow[]>([])
  const [logos, setLogos] = useState<TeamLogoRow[]>([])
  // Demo mode keeps uploads as object URLs.
  const [demoFiles] = useState(() => new Map<string, string>())

  const reload = useCallback(async () => {
    if (demoMode) return
    const [l, g] = await Promise.all([
      check(supabase!.from("team_looks").select("*").order("team")),
      check(supabase!.from("team_logos").select("*").in("status", ["pending", "approved", "rejected"]).order("created_at")),
    ]).catch((e: Error) => {
      // Before migration 019 the tables don't exist: no looks yet.
      if (/team_looks|team_logos|schema cache/.test(e.message)) return [[], []] as [TeamLookRow[], TeamLogoRow[]]
      throw e
    })
    setLooks((l ?? []) as TeamLookRow[])
    setLogos((g ?? []) as TeamLogoRow[])
  }, [])

  useEffect(() => {
    if (demoMode) return
    void reload()
    const channel = supabase!.channel("team-look")
    watchTable(channel, "team_looks", () => void reload())
    watchTable(channel, "team_logos", () => void reload())
    channel.subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload])

  const value: TeamLookState = {
    looks,
    logos,
    coloursOf: (team) => {
      const row = looks.find((r) => r.team === team)
      if (row) return lookColours(row)
      return league.snapshot.teams.find((t) => t.name === team)?.look?.colours ?? null
    },
    logoUrl: (logo) => demoFiles.get(logo.path) ?? assetUrl("team-logos", logo.path),
    approvedLogo: (team) => logos.find((l) => l.team === team && l.status === "approved"),
    save: async (c, liveryId) => {
      if (demoMode) {
        const prev = looks.find((r) => r.team === me.team)
        const colorId = prev?.color_id ?? 129 + looks.length
        const row: TeamLookRow = {
          team: me.team, primary_colour: c.primary, secondary_colour: c.secondary, tertiary_colour: c.tertiary, trim_colour: c.trim,
          livery_id: liveryId, color_id: colorId, updated_at: new Date().toISOString(),
        }
        return setLooks((ls) => [...ls.filter((r) => r.team !== me.team), row])
      }
      await check(supabase!.rpc("set_team_look", {
        primary_colour: c.primary, secondary_colour: c.secondary, tertiary_colour: c.tertiary, trim_colour: c.trim, livery_id: liveryId,
      }))
      await reload()
    },
    uploadLogo: async (file) => {
      if (!LOGO_TYPES.includes(file.type)) throw new Error("Use a PNG (best, with a transparent background), WebP or JPEG image")
      if (file.size > LOGO_MAX_BYTES) throw new Error("The logo must be 1 MB or smaller")
      const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg"
      const path = `${seriesId() ?? "demo"}/${crypto.randomUUID()}.${ext}`
      if (demoMode) {
        demoFiles.set(path, URL.createObjectURL(file))
        const row: TeamLogoRow = { id: Date.now(), team: me.team, path, status: "pending", note: null, created_at: new Date().toISOString(), reviewed_at: null }
        return setLogos((ls) => [...ls.map((l) => (l.team === me.team && l.status === "pending" ? { ...l, status: "withdrawn" as const } : l)), row])
      }
      await check(supabase!.storage.from("team-logos").upload(path, file, { contentType: file.type }))
      await check(supabase!.rpc("submit_team_logo", { path }))
      await reload()
    },
    withdrawLogo: async (id) => {
      if (demoMode) return setLogos((ls) => ls.filter((l) => l.id !== id))
      await check(supabase!.rpc("withdraw_team_logo", { logo_id: id }))
      await reload()
    },
    reviewLogo: async (id, approve, note) => {
      if (demoMode) {
        const l = logos.find((x) => x.id === id)
        return setLogos((ls) => ls.map((x) =>
          x.id === id ? { ...x, status: approve ? "approved" : "rejected", note: note ?? null, reviewed_at: new Date().toISOString() }
          : approve && x.team === l?.team && x.status === "approved" ? { ...x, status: "replaced" } : x))
      }
      await check(supabase!.rpc("review_team_logo", { logo_id: id, approve, note: note || null }))
      await reload()
    },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
