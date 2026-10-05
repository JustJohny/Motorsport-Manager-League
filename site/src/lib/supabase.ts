import { createClient, type RealtimeChannel } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Without Supabase settings the site runs in demo mode on public/demo-state.json. */
export const demoMode = !url || !key

/**
 * The series (one MM save each) every request is for. The database's views show only that
 * series' rows, so it goes on every request as the x-series header.
 */
let currentSeries: string | null = null
export const setSeries = (id: string | null) => { currentSeries = id }

export const supabase = demoMode
  ? null
  : createClient(url!, key!, {
      // PKCE returns ?code= instead of #access_token=, which would clash with the hash router.
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
      global: {
        fetch: (input, init) => {
          const headers = new Headers(init?.headers)
          if (currentSeries) headers.set("x-series", currentSeries)
          return fetch(input, { ...init, headers })
        },
      },
    })

/**
 * Live changes to a league table in the current series. Realtime reads the tables in the `league`
 * schema (the public views can't be watched), filtered to the series.
 */
export function watchTable(channel: RealtimeChannel, table: string, onChange: () => void) {
  return channel.on("postgres_changes", { event: "*", schema: "league", table, filter: `series=eq.${currentSeries}` }, onChange)
}

export const seriesId = () => currentSeries

/**
 * A file in a public Storage bucket ("liveries", "team-logos"). Demo mode serves them from
 * public/<bucket>/ (gitignored; copy out/liveries there to see livery previews).
 */
export function assetUrl(bucket: string, path: string) {
  if (demoMode) return `${import.meta.env.BASE_URL}${bucket}/${path}`
  return `${url!.replace(/\/$/, "")}/storage/v1/object/public/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`
}
