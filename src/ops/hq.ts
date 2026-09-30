import type { Obj } from "../graph.ts";
import { BUILDING_STATES, NULL_DATE, type Save } from "../model.ts";
import { float, num } from "../codec/sav.ts";
import { adjustBudget } from "./finance.ts";
import { addDays, delayedEvents, insertByDate } from "./calendar.ts";

export interface SetBuildingOp {
  op: "setBuilding";
  team: string | number;
  /** Building name ("Wind Tunnel") or its info.type number. */
  building: string | number;
  /** 0 = not built, otherwise the in-game level (1..maxLevel). */
  level: number;
}

export function findBuilding(save: Save, team: Obj, key: string | number): Obj {
  const b = save.buildings(team).find((b) => {
    const info = save.buildingInfo(b);
    return info.type === key || info.name === key;
  });
  if (!b) throw new Error(`Team ${team.name} has no building ${JSON.stringify(key)}`);
  return b;
}

/** Put a building at a finished level, cancelling any construction or upgrade in progress. */
export function setBuilding(save: Save, op: SetBuildingOp): string {
  const team = save.team(op.team);
  const b = findBuilding(save, team, op.building);
  const info = save.buildingInfo(b);
  const max = info.maxLevel + 1;
  if (op.level < 0 || op.level > max) throw new Error(`${info.name}: level must be 0..${max}`);

  const built = op.level > 0;
  b.state = BUILDING_STATES.indexOf(built ? "Constructed" : "NotBuilt");
  b.currentLevel = built ? op.level - 1 : 0;
  b.normalizedProgress = float(0);
  b.mDateProgressStarted = NULL_DATE;
  b.mDateProgressEnd = NULL_DATE;
  b.mStaffNumber = built ? info.workerCapacity?.[b.currentLevel] ?? b.mStaffNumber : 0;
  let msg = `${team.name}: ${info.name} -> level ${op.level}`;
  // The game gates buildings behind others; setting a level directly bypasses that, so flag it.
  for (const dep of built ? info.dependencies ?? [] : []) {
    const req = findBuilding(save, team, dep.buildingType);
    const reqLevel = req.state === 0 ? 0 : req.currentLevel + 1;
    if (reqLevel < dep.requiredLevel) {
      msg += ` (WARNING: needs ${save.buildingInfo(req).name} level ${dep.requiredLevel}, has ${reqLevel})`;
    }
  }
  return msg;
}

export interface StartBuildingOp {
  op: "startBuilding";
  team: string | number;
  /** Building name ("Wind Tunnel") or its info.type number. */
  building: string | number;
  /** Multiplier on MM's build time; 1 (default) is the game's own duration. */
  speed?: number;
}

/**
 * Start building (level 0 -> 1) or upgrading a building the way the game's BeginBuilding /
 * BeginUpgrade do: MM times are in weeks (buildTime / upgradeTime[level] x 7 days). The game then
 * advances progress in Team.Update and finishes the building itself; the calendar event is the
 * one MM adds for the "building complete" notification. Cost is not taken here (see adjustBudget).
 */
export function startBuilding(save: Save, op: StartBuildingOp): string {
  const team = save.team(op.team);
  const b = findBuilding(save, team, op.building);
  const info = save.buildingInfo(b);
  const state = BUILDING_STATES[b.state];
  if (state === "BuildingInProgress" || state === "Upgrading") throw new Error(`${info.name} is already under construction`);
  const isNew = state === "NotBuilt";
  if (!isNew && b.currentLevel >= info.maxLevel) throw new Error(`${info.name} is at its highest level`);
  const weeks: number = isNew ? info.buildTime : info.upgradeTime?.[b.currentLevel];
  if (!weeks) throw new Error(`${info.name} can't be ${isNew ? "built" : "upgraded"}`);

  const start = save.now;
  const end = addDays(start, weeks * 7 * (op.speed ?? 1));
  b.state = BUILDING_STATES.indexOf(isNew ? "BuildingInProgress" : "Upgrading");
  b.normalizedProgress = float(0);
  b.mDateProgressStarted = start;
  b.mDateProgressEnd = end;
  addProgressEvent(save, team, b, isNew, end);

  const level = isNew ? 1 : b.currentLevel + 2;
  let msg = `${team.name}: ${isNew ? "building" : "upgrading"} ${info.name} to level ${level}, done ${end.slice(0, 10)} (${weeks} weeks)`;
  for (const dep of info.dependencies ?? []) {
    const req = findBuilding(save, team, dep.buildingType);
    const reqLevel = req.state === 0 || req.state === 1 ? 0 : req.currentLevel + 1;
    if (reqLevel < dep.requiredLevel) msg += ` (WARNING: needs ${save.buildingInfo(req).name} level ${dep.requiredLevel}, has ${reqLevel})`;
  }
  return msg;
}

// MM's texts for these events: "Built <building>" and "Upgraded <building>".
const TEXT_BUILT = "PSG_10009159";
const TEXT_UPGRADED = "PSG_10009160";

/** Add the calendar event MM creates in HQsBuilding.GenerateCalendarEvent, copied from one in the save. */
function addProgressEvent(save: Save, team: Obj, b: Obj, isNew: boolean, end: string) {
  const g = save.g;
  const textID = isNew ? TEXT_BUILT : TEXT_UPGRADED;
  const candidates = delayedEvents(save).map((e) => g.deref<Obj>(e))
    .filter((e) => e?.OnEventTrigger?.methodNames?.[0] === "UpdateProgress");
  const typeOf = (e: Obj) => save.buildingInfo(g.deref<Obj>(e.OnEventTrigger.targets[0])).type;
  const info = save.buildingInfo(b);
  // Prefer an event for the same building type: its texts already name it in every language.
  const template = candidates.find((e) => e.mDynamicDescription?.textID === textID && typeOf(e) === info.type)
    ?? candidates.find((e) => e.mDynamicDescription?.textID === textID)
    ?? candidates[0];
  if (!template) return; // The game still finishes the building in Team.Update; only the notification is missing.

  const ev = g.clone({ ...template, OnEventTrigger: { ...template.OnEventTrigger, targets: [] } });
  // Cloned from a spread copy, so carry the template's runtime type over for $type annotation.
  const type = save.types.runtime.get(template);
  if (type) save.types.runtime.set(ev, type);
  ev.OnEventTrigger.targets = [g.ref(b)];
  for (const cmd of ev.OnButtonClick?.targets ?? []) if (cmd && "focusEntity" in cmd) cmd.focusEntity = g.ref(b);
  if (ev.displayEffect) ev.displayEffect.team = g.ref(team);
  const isPlayer = g.same(save.data.player.mPlayerTeam, team);
  ev.showOnCalendar = isPlayer;
  ev.interruptGameTime = isPlayer;
  ev.triggerDate = end;
  ev.triggerCacheDayDate = end.slice(0, 10) + "T00:00:00.0000000";
  if (ev.mDynamicDescription) {
    ev.mDynamicDescription.textID = textID;
    const templateInfo = save.buildingInfo(g.deref<Obj>(template.OnEventTrigger.targets[0]));
    if (templateInfo.type !== info.type) {
      // Different building: swap the English name in (other languages keep the template's name).
      const texts = ev.mDynamicDescription.translatedText ?? {};
      for (const lang of Object.keys(texts)) texts[lang] = String(texts[lang]).split(templateInfo.name).join(info.name);
    }
  }
  insertByDate(save, ev, end);
}

export interface CancelBuildingOp {
  op: "cancelBuilding";
  team: string | number;
  building: string | number;
  /** Give back the price the game charged when the construction started (default true). */
  refund?: boolean;
  reason?: string;
}

/** Stop a construction or upgrade in progress, as if it never started, and refund its price. */
export function cancelBuilding(save: Save, op: CancelBuildingOp): string {
  const team = save.team(op.team);
  const b = findBuilding(save, team, op.building);
  const info = save.buildingInfo(b);
  const state = BUILDING_STATES[b.state];
  if (state !== "BuildingInProgress" && state !== "Upgrading") throw new Error(`${info.name} is not under construction`);
  const isNew = state === "BuildingInProgress";
  // MM charges the full price when construction starts (e.g. "Wind Tunnel - Build").
  const price = num(isNew ? info.initialCost : info.upgradeCost?.[b.currentLevel]);

  b.state = BUILDING_STATES.indexOf(isNew ? "NotBuilt" : "Constructed");
  b.normalizedProgress = float(0);
  b.mDateProgressStarted = NULL_DATE;
  b.mDateProgressEnd = NULL_DATE;
  const list = delayedEvents(save);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = save.g.deref<Obj>(list[i]);
    if (e?.OnEventTrigger?.methodNames?.[0] === "UpdateProgress" && save.g.deref(e.OnEventTrigger.targets?.[0]) === b) list.splice(i, 1);
  }

  let msg = `${team.name}: cancelled ${isNew ? "building" : "upgrading"} ${info.name}`;
  if (op.refund !== false && price > 0) {
    msg += "; " + adjustBudget(save, { op: "adjustBudget", team: op.team, delta: price, reason: op.reason ?? `Refund: ${info.name} (not ordered on the league site)` });
  }
  return msg;
}

export interface CancelUnorderedHqOp {
  op: "cancelUnorderedHq";
  /** Member teams: the league site decides their HQ. */
  teams: (string | number)[];
  /** Constructions the league ordered: building type and the level it's heading to. */
  keep: { team: string; building: number; toLevel: number }[];
  /** League start (first published game date); older constructions are left alone. */
  since: string;
}

/**
 * Between races the in-game AI also runs member teams and starts HQ projects with their money.
 * Cancel and refund every construction on a member team that the league didn't order.
 */
export function cancelUnorderedHq(save: Save, op: CancelUnorderedHqOp): string[] {
  const log: string[] = [];
  for (const key of op.teams) {
    const team = save.team(key);
    for (const b of save.buildings(team)) {
      const state = BUILDING_STATES[b.state];
      if (state !== "BuildingInProgress" && state !== "Upgrading") continue;
      if (String(b.mDateProgressStarted) <= op.since) continue;
      const info = save.buildingInfo(b);
      const toLevel = state === "BuildingInProgress" ? 1 : b.currentLevel + 2;
      if (op.keep.some((k) => k.team === team.name && k.building === info.type && k.toLevel === toLevel)) continue;
      log.push(cancelBuilding(save, { op: "cancelBuilding", team: team.name, building: info.type }));
    }
  }
  return log.length ? log : ["No HQ projects to cancel on member teams"];
}
