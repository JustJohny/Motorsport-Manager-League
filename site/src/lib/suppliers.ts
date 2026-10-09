import { BatteryCharging, Disc3, Fan, Fuel, Layers, Zap, type LucideIcon } from "lucide-react"
import type { SupplierOffer } from "./types"

export const TYPE_ICONS: Record<string, LucideIcon> = {
  Engine: Fan, Brakes: Disc3, Fuel: Fuel, Materials: Layers, Battery: BatteryCharging, ERSAdvanced: Zap,
}
export const TYPE_LABELS: Record<string, string> = { ERSAdvanced: "ERS" }

/** MM has several deals per supplier (Micronix Racing makes every brake): number repeated names, cheapest first. */
export function dealNames(options: SupplierOffer[]) {
  const sorted = [...options].sort((a, b) => a.price - b.price || a.id - b.id)
  const count = new Map<string, number>(), seen = new Map<string, number>()
  for (const o of sorted) count.set(o.name, (count.get(o.name) ?? 0) + 1)
  return sorted.map((o) => {
    const n = (seen.get(o.name) ?? 0) + 1
    seen.set(o.name, n)
    return { o, name: count.get(o.name)! > 1 ? `${o.name} · deal ${n}` : o.name }
  })
}
