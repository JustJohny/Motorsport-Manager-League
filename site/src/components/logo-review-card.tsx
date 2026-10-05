import { Check, Shield, X } from "lucide-react"
import { useState } from "react"
import { seriesFiles } from "../../../src/race-cycle.ts"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { CopyCommand } from "@/components/race-cycle"
import { useLeague } from "@/lib/league"
import { useTeamLook } from "@/lib/team-look"

/** Members' logo uploads waiting for approval, and the command that builds the game mod. */
export function LogoReviewCard() {
  const { current } = useLeague()
  const tl = useTeamLook()
  const pending = tl.logos.filter((l) => l.status === "pending")
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const review = async (id: number, approve: boolean) => {
    setBusy(id); setError(null)
    try { await tl.reviewLogo(id, approve, notes[id]) } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Shield className="size-4" /> Team identity</CardTitle>
        <CardDescription>
          Logos members uploaded, waiting for your approval. Colours and livery patterns need no approval; pull applies them to the save.
          After a look or logo changes, build the game mod and copy its files into <code>MM_Data/Modding</code>, then switch the staging
          mod on in MM's Workshop screen (MM forgets that switch at every start).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {pending.length === 0 && <span className="text-muted-foreground">No logos waiting.</span>}
        {pending.map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 rounded-md border p-2">
            <div className="flex h-16 w-48 items-center justify-center rounded bg-neutral-900">
              <img src={tl.logoUrl(l)} alt={`${l.team} logo upload`} className="max-h-14 max-w-[90%] object-contain" />
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1">
              <span className="font-medium">{l.team}</span>
              <span className="text-xs text-muted-foreground">Uploaded {new Date(l.created_at).toLocaleString()}</span>
              <Input placeholder="Note for a rejection (optional)" value={notes[l.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [l.id]: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy === l.id} onClick={() => void review(l.id, true)}><Check /> Approve</Button>
              <Button size="sm" variant="outline" disabled={busy === l.id} onClick={() => void review(l.id, false)}><X /> Reject</Button>
            </div>
          </div>
        ))}
        {error && <span className="text-destructive">{error}</span>}
        <span className="text-muted-foreground">
          Build the mod (every series' colours and approved logos). <code>--logos-base</code> is your copy of the game's original
          {" "}<code>Images/teamlogos</code>; <code>--python</code> a Python with UnityPy.
        </span>
        <CopyCommand command={`npx tsx src/cli.ts team-mod --league ${seriesFiles(current).league} --logos-base <original teamlogos> --python <python with UnityPy>`} />
      </CardContent>
    </Card>
  )
}
