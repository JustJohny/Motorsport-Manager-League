import { CalendarClock, Gauge, Info, Lightbulb, Scale, UserCheck, UserX, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { fmtDate } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ContractRenewal } from "@/lib/types"

const pts = (v: number) => Math.round(v * 100)
const signed = (v: number, digits = 0) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(digits)}`

/** How MM reached its renewal answer, and what would change it. */
export function RenewalWhy({ r }: { r: ContractRenewal }) {
  const why = r.why
  if (!why) return null
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground"><Info /> Why?</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {r.refusal ? <UserX className="size-4 text-destructive" /> : <UserCheck className="size-4" />}
            {r.name}: {r.refusal ?? "willing to renew"}
          </DialogTitle>
          <DialogDescription>MM's own renewal check, worked out from the published save.</DialogDescription>
        </DialogHeader>

        {why.morale && (
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-medium"><Gauge className="size-4 text-muted-foreground" /> Morale as MM counts it</h4>
            <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
              <Row label="Their own morale" value={String(pts(why.morale.base))} />
              {why.morale.traits.map((t, i) => (
                <div key={i} className="flex items-start justify-between gap-3">
                  <span className="flex flex-col">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {t.via && <Users className="size-3.5 text-muted-foreground" />}
                      {t.via ? `${t.via}'s ${t.name}` : t.name}
                      {t.temporary && <Badge variant="outline" className="gap-1"><CalendarClock className="size-3" />{t.until ? `until ${fmtDate(t.until)}` : "temporary"}</Badge>}
                    </span>
                    {t.condition && !t.temporary && <span className="text-xs text-muted-foreground">only {t.condition}</span>}
                  </span>
                  <span className={cn("tabular-nums", t.value < 0 ? "text-red-500" : "text-emerald-500")}>{signed(pts(t.value))}</span>
                </div>
              ))}
              <div className="mt-1 border-t pt-1"><Row label="Morale (0–100)" value={String(pts(why.morale.total))} strong /></div>
            </div>
            <p className="text-xs text-muted-foreground">At 20 or below a driver won't talk about a new contract at all.</p>
          </section>
        )}

        {why.score && (
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-medium"><Scale className="size-4 text-muted-foreground" /> MM's renewal score</h4>
            <div className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
              {why.score.parts.map((p) => (
                <Row key={p.label} label={p.label} value={signed(p.value, Number.isInteger(p.value) ? 0 : 1)} tone={p.value > 0 ? "bad" : p.value < 0 ? "good" : undefined} />
              ))}
              <div className="mt-1 border-t pt-1">
                <Row label={`Total (they talk below ${why.score.threshold})`} value={why.score.total.toFixed(Number.isInteger(why.score.total) ? 0 : 1)} strong
                  tone={why.score.total < why.score.threshold ? "good" : "bad"} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Points above zero push them away; below zero keep them.</p>
          </section>
        )}

        {why.tips.length > 0 && (
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-medium"><Lightbulb className="size-4 text-muted-foreground" /> What would change it</h4>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {why.tips.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: "good" | "bad" }) {
  return (
    <div className={cn("flex items-center justify-between gap-3", strong && "font-medium")}>
      <span>{label}</span>
      <span className={cn("tabular-nums", tone === "good" && "text-emerald-500", tone === "bad" && "text-red-500")}>{value}</span>
    </div>
  )
}
