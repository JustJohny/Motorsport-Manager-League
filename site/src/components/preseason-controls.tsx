import { CalendarClock, Loader2, Lock } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { usePreseason } from "@/lib/preseason"

/** The organizer opens the league's pre-season before the first race and closes it once applied. */
export function PreseasonControls() {
  const pre = usePreseason()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const teams = new Set(pre.moves.map((m) => m.team))
  const toggle = async () => {
    setBusy(true); setError(null)
    try { await pre.setOpen(!pre.open) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Pre-season
          <Badge variant={pre.open ? "default" : "secondary"}>{pre.open ? <CalendarClock /> : <Lock />} {pre.open ? "Open" : "Closed"}</Badge>
        </CardTitle>
        <CardDescription>
          Open it on the save a few days before round 1: members sign free agents, rearrange their teams and pick this season's
          suppliers, all free. Pull and apply as usual, then close it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <span className="text-muted-foreground">
          Waiting for the next pull: {pre.moves.length} move{pre.moves.length === 1 ? "" : "s"} from {teams.size} team{teams.size === 1 ? "" : "s"}
        </span>
        <Button className="self-start" variant={pre.open ? "outline" : "default"} disabled={busy} onClick={() => void toggle()}>
          {busy ? <Loader2 className="animate-spin" /> : pre.open ? <Lock /> : <CalendarClock />} {pre.open ? "Close the pre-season" : "Open the pre-season"}
        </Button>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  )
}
