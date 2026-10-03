// The organizer's race cycle, shared by the site's race guide and the TUI cockpit.
// Only type imports: the site bundles this file.
import type { CalendarEvent, Championship } from "./league-types.ts";

/** Two checkpoints per race: A after the last race, B at the start of the next race weekend. */
export type Checkpoint = "after" | "before";

/**
 * The organizer's files for a series: its league file, its changes file, and the prefix of its MM
 * save names, so two series never share a save or a changes.json. The league from before series
 * existed ("main") keeps its "League …" save names.
 */
export function seriesFiles(series: { id: string; name: string }) {
  return {
    league: `league-${series.id}.json`,
    changes: `changes-${series.id}.json`,
    prefix: series.id === "main" ? "League" : series.name.replace(/[^\w .-]/g, "").trim() || series.id,
  };
}

const DAY = 86_400_000;
const time = (d: string) => Date.parse(d.slice(0, 19) + "Z");

/**
 * Where the league is in the race cycle, from a game date: a save made at the start of the next
 * race weekend is checkpoint B (before the race), anything earlier is A (after the last race).
 */
export function cycleOf(ch: Pick<Championship, "calendar">, gameDate: string) {
  const next: CalendarEvent | null = ch.calendar.find((e) => !e.ended) ?? null;
  const last: CalendarEvent | null = [...ch.calendar].reverse().find((e) => e.ended) ?? null;
  const current: Checkpoint = next && time(gameDate) >= time(next.date) - DAY ? "before" : "after";
  const lastRound = last?.round ?? 0;
  return { last, next, current, lastRound, nextRound: next?.round ?? lastRound + 1 };
}

/** The save names the race guide uses around a race. */
export function cycleSaves(prefix: string, lastRound: number, nextRound: number) {
  return { post: `${prefix} R${lastRound} Post`, pre: `${prefix} R${nextRound} Pre` };
}
