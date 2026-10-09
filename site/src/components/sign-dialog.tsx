import { Loader2, UserPlus } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ageAt, fmtMoney } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { SEAT_LABEL, usePreseason } from "@/lib/preseason"
import { contractEnd, minWage } from "@/lib/rules"
import { useTransfers } from "@/lib/transfers"
import type { Person } from "@/lib/types"
import { signingBonusText } from "../../../src/development.ts"

const JOB_FOR: Record<string, string> = { Driver: "Driver", Engineer: "EngineerLead", Mechanic: "Mechanic" }
const EMPTY = "empty"

/** Sign a free agent in the league's pre-season: straight away, no fees, at the market's opening wage. */
export function SignDialog({ person, trigger }: { person: Person; trigger: React.ReactNode }) {
  const { me, league } = useLeague()
  const { settings } = useTransfers()
  const pre = usePreseason()
  const [open, setOpen] = useState(false)
  const [seat, setSeat] = useState<string>("")
  const [years, setYears] = useState("1")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seats = (pre.lineup(me.team)?.seats ?? []).filter((s) => s.job === JOB_FOR[person.kind] && s.role !== "other")
  // An empty seat (or one being released) is filled first; otherwise someone is replaced.
  const emptySeat = seats.find((s) => !s.person)
  const wage = minWage(person, settings)

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await pre.sign(person.guid, seat === EMPTY ? null : seat, Number(years))
      setOpen(false)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) { setSeat(emptySeat ? EMPTY : ""); setError(null) } }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign {person.name}</DialogTitle>
          <DialogDescription>
            Pre-season signing: they join straight away, first come wins. No sign-on fee; the wage is the market's opening price.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>Seat</Label>
            <Select value={seat} onValueChange={setSeat}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>
                {emptySeat && (
                  <SelectItem value={EMPTY}>
                    {SEAT_LABEL[emptySeat.role]}: empty{emptySeat.leaving ? ` (${emptySeat.leaving.name} leaving)` : ""}
                  </SelectItem>
                )}
                {seats.filter((s) => s.person).map((s) => (
                  <SelectItem key={s.person!.guid} value={s.person!.guid}>{SEAT_LABEL[s.role]}: replace {s.person!.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {seat && seat !== EMPTY && <p className="text-xs text-muted-foreground">The person replaced becomes a free agent.</p>}
          </div>
          <div className="grid gap-2">
            <Label>Contract</Label>
            <Select value={years} onValueChange={setYears}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Array.from({ length: settings.max_contract_years }, (_, i) => i + 1).map((y) => (
                  <SelectItem key={y} value={String(y)}>{y} season{y > 1 ? "s" : ""} (until {contractEnd(league.snapshot.gameDate, y).slice(0, 4)})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border p-3 text-sm tabular-nums">
            <span className="text-muted-foreground">Yearly wage</span><span className="text-right">{fmtMoney(wage)}</span>
            <span className="text-muted-foreground">Sign-on fee</span><span className="text-right">{fmtMoney(0)}</span>
          </div>
          {person.kind === "Driver" && league.snapshot.championship.game === "ff20" && (
            <p className="text-xs text-muted-foreground">League bonus on signing: {signingBonusText(ageAt(person.dateOfBirth, league.snapshot.gameDate))}.</p>
          )}
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={!seat || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="animate-spin" /> : <UserPlus />} Sign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
