import { useEffect, useState } from "react"
import type { RaceData, RaceDataPrivate } from "@/lib/types"
import { demoMode, supabase } from "@/lib/supabase"

/**
 * FIRE Fantasy 20's exported race data for one round (migration 020, src/race-data.ts): public laps
 * and results, and the private lap data (tyre wear, fuel, setup, form, stamina) of the teams the
 * member may see: their own, or every team for the organizer. Demo mode reads
 * public/race-data-demo.json ({ "<round>": { data, private } }, gitignored).
 */
export interface RaceDataView {
  data: RaceData | null
  /** Team name -> that team's private lap data. */
  teams: Record<string, RaceDataPrivate>
  loading: boolean
}

export function useRaceData(round: number | null): RaceDataView {
  const [view, setView] = useState<RaceDataView>({ data: null, teams: {}, loading: round != null })
  useEffect(() => {
    if (round == null) return
    let live = true
    setView({ data: null, teams: {}, loading: true })
    const load = async (): Promise<Omit<RaceDataView, "loading">> => {
      if (demoMode) {
        const res = await fetch(`${import.meta.env.BASE_URL}race-data-demo.json`).catch(() => null)
        const all = res?.ok ? await res.json() as Record<string, { data: RaceData; private: Record<string, RaceDataPrivate> }> : {}
        return { data: all[round]?.data ?? null, teams: all[round]?.private ?? {} }
      }
      const [pub, priv] = await Promise.all([
        supabase!.from("race_data").select("data").eq("round", round).maybeSingle(),
        supabase!.from("race_data_private").select("team, data").eq("round", round),
      ])
      // Before migration 020 the tables don't exist: no race data.
      return {
        data: (pub.data?.data as RaceData | undefined) ?? null,
        teams: Object.fromEntries((priv.data ?? []).map((r) => [r.team as string, r.data as RaceDataPrivate])),
      }
    }
    load().then((v) => live && setView({ ...v, loading: false }))
    return () => { live = false }
  }, [round])
  return view
}

/** A lap's time: the third sector's running time. */
export interface LapRow { lap: number; time: number | null; s1: number | null; s2: number | null; s3: number | null; position: number | null; gap: number | null; compound: string; flag: string; topSpeed: number | null }

/** Per-lap rows of one driver from the sector rows (sectorTime counts up within the lap). */
export function lapsOf(d: RaceData["laps"][number]): LapRow[] {
  const v = d.values
  const out: LapRow[] = []
  for (let i = 0; i < d.lap.length; i++) {
    if (d.sector[i] !== 3) continue
    const t1 = d.sector[i - 2] === 1 ? v.sectorTime[i - 2] : null
    const t2 = d.sector[i - 1] === 2 ? v.sectorTime[i - 1] : null
    const t3 = v.sectorTime[i]
    const speeds = [v.topSpeed[i - 2], v.topSpeed[i - 1], v.topSpeed[i]].filter((x): x is number => x != null)
    out.push({
      lap: d.lap[i], time: t3, position: v.standingPos[i], gap: v.gapToLeader[i], compound: d.compound[i], flag: d.flag[i],
      s1: t1, s2: t1 != null && t2 != null ? t2 - t1 : null, s3: t2 != null && t3 != null ? t3 - t2 : null,
      topSpeed: speeds.length ? Math.max(...speeds) : null,
    })
  }
  return out
}

/** Stints: consecutive laps on one compound; a change of compound is a pit stop. */
export function stintsOf(laps: LapRow[]): { compound: string; from: number; to: number }[] {
  const out: { compound: string; from: number; to: number }[] = []
  for (const l of laps) {
    const last = out.at(-1)
    if (last && last.compound === l.compound) last.to = l.lap
    else out.push({ compound: l.compound, from: l.lap, to: l.lap })
  }
  return out
}
