const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const moneyShort = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 })

export const fmtMoney = (v: number | null | undefined) => (v == null ? "—" : money.format(v))
export const fmtMoneyShort = (v: number | null | undefined) => (v == null ? "—" : moneyShort.format(v))

/** Game dates look like "2016-08-11T06:00:00.0000000". */
export function fmtDate(d: string | null | undefined) {
  if (!d || d.startsWith("0001")) return "—"
  return new Date(d.slice(0, 19) + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
}

export function ageAt(dateOfBirth: string, gameDate: string) {
  const b = new Date(dateOfBirth.slice(0, 10)), n = new Date(gameDate.slice(0, 10))
  let age = n.getUTCFullYear() - b.getUTCFullYear()
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) age--
  return age
}

/** Seconds -> "1:18:49.223" or "2:19.257". */
export function fmtTime(s: number | null | undefined) {
  if (!s) return "—"
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`)
export const fmtNum = (v: number | null | undefined, digits = 1) => (v == null ? "—" : v.toFixed(digits))

/** "FrontWing" -> "Front wing", "EngineerLead" -> "Lead engineer". */
export function humanize(s: string) {
  if (s === "EngineerLead") return "Lead engineer"
  const words = s.replace(/(GET|GT)$/, " $1").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1).replace(/ (get|gt)$/, (x) => x.toUpperCase())
}

export function statAverage(stats: Record<string, number | null>) {
  const v = Object.values(stats).filter((x): x is number => x != null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0
}

/** Game country keys: "SouthKorea" -> "South Korea". */
export const fmtCountry = (key: string | null | undefined) => (key ? key.replace(/([a-z])([A-Z])/g, "$1 $2") : "—")
