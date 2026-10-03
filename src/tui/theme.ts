// Colours and symbols for the TUI. Plain Unicode only (no Nerd Font): every symbol here renders
// in any monospace font.

export const C = {
  accent: "#e10600", // the site's red
  accent2: "cyan",
  ok: "green",
  warn: "yellow",
  bad: "red",
  dim: "gray",
  money: "greenBright",
  border: "gray",
  focus: "#e10600",
} as const;

export const S = {
  flag: "⚑",
  pointer: "▸",
  dot: "●",
  ring: "○",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  star: "★",
  starEmpty: "☆",
  arrow: "→",
  up: "▲",
  down: "▼",
  save: "▤",
  series: "◆",
  cloud: "☁",
  gear: "⚙",
  pull: "⇣",
  push: "⇡",
  apply: "⟴",
  refresh: "⟳",
  team: "◈",
  clock: "◷",
  money: "$",
  bar: "│",
  hq: "▦",
  part: "◩",
  crew: "◎",
  sponsor: "◉",
  window: "⇄",
  vote: "⚖",
  engine: "⛭",
  log: "≡",
  soon: "…",
} as const;

export const money = (v: number | null | undefined) => (v == null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`);

export function moneyShort(v: number | null | undefined) {
  if (v == null) return "—";
  const a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${a}`;
}

/** A game date ("2016-03-01T00:00:00.0000000") as "1 Mar 2016". */
export function gameDate(d: string | null | undefined) {
  if (!d) return "—";
  const t = new Date(d.slice(0, 19) + "Z");
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function ago(d: Date | string) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Cut or pad to a width, for table columns. */
export function fit(s: string, w: number, align: "left" | "right" = "left") {
  if (w <= 0) return "";
  const t = s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s;
  return align === "right" ? t.padStart(w) : t.padEnd(w);
}
