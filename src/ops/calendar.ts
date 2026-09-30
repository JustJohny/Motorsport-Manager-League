import type { Json } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";

/** The game's queue of future calendar events, kept sorted by triggerDate. */
export function delayedEvents(save: Save): Json[] {
  return save.g.rawList(save.data.calendar.mDelayedEvents);
}

export function insertByDate(save: Save, ev: Obj, date: string) {
  const list = delayedEvents(save);
  const i = list.findIndex((e) => (save.g.deref<Obj>(e).triggerDate as string) > date);
  list.splice(i < 0 ? list.length : i, 0, save.g.ref(ev));
}

/** Game date plus a number of days, in the save's C# format ("2016-09-21T06:00:00.0000000"). */
export function addDays(date: string, days: number): string {
  const t = Date.parse(date.slice(0, 19) + "Z") + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 19) + ".0000000";
}
