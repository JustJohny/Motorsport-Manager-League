import { createClient } from "@supabase/supabase-js"

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Without Supabase settings the site runs in demo mode on public/demo-state.json. */
export const demoMode = !url || !key

export const supabase = demoMode
  ? null
  : createClient(url!, key!, {
      // PKCE returns ?code= instead of #access_token=, which would clash with the hash router.
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
    })
