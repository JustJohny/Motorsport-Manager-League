import { cn } from "@/lib/utils"
import { fmtNum, humanize } from "@/lib/format"

/** A 0–20 game stat as a labelled bar. */
export function StatBar({ label, value, max = 20 }: { label: string; value: number | null; max?: number }) {
  const pct = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100))
  return (
    <div className="grid grid-cols-[7.5rem_1fr_2.5rem] items-center gap-2 text-xs">
      <span className="truncate text-muted-foreground">{humanize(label)}</span>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", pct >= 75 ? "bg-primary" : pct >= 50 ? "bg-foreground/70" : "bg-foreground/35")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-right tabular-nums">{fmtNum(value)}</span>
    </div>
  )
}
