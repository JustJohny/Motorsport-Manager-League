import { Loader2 } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useLeague } from "@/lib/league"
import { fmtCountdown, useNow, useTransfers } from "@/lib/transfers"

/** "2026-10-03T20:00" for a datetime-local input, in local time. */
function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function WindowControls() {
  const { league } = useLeague()
  const t = useTransfers()
  const now = useNow()
  const w = t.transferWindow
  const [deadline, setDeadline] = useState(() => localInput(new Date(Date.now() + 3 * 86400_000)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const active = w?.status === "open"
  const stale = active && w.snapshot_id !== league.snapshotId

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Transfer window</CardTitle>
        <CardDescription>
          {!active ? "No window open. Set a deadline and open one; bidding runs until then."
            : t.isOpen ? `Open, closes ${new Date(w.closes_at).toLocaleString()} (${fmtCountdown(Date.parse(w.closes_at) - now)}).`
            : "Bidding closed. Run `mmsave pull -o changes.json --mark-applied`, then `mmsave apply`."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="deadline">{active ? "New deadline" : "Deadline"}</Label>
            <Input id="deadline" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {!active && (
              <Button disabled={busy} onClick={() => void run(() => t.openWindow(new Date(deadline)))}>
                {busy && <Loader2 className="animate-spin" />} Open window
              </Button>
            )}
            {active && (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void run(() => t.setDeadline(new Date(deadline)))}>Move deadline</Button>
                {t.isOpen && <Button variant="destructive" disabled={busy} onClick={() => void run(() => t.setDeadline(new Date()))}>Close bidding now</Button>}
              </>
            )}
          </div>
          {stale && (
            <Alert><AlertDescription>
              This window uses snapshot #{w.snapshot_id}, but #{league.snapshotId} is newer. Prices and budgets come from the window's snapshot.
            </AlertDescription></Alert>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  )
}
