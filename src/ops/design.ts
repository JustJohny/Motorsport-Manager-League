import type { Json } from "../codec/sav.ts";
import { float, num } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import { NULL_DATE, PART_TYPES, type PartType, type Save } from "../model.ts";
import { planDesign, type DesignComponent, type DesignContext, type DesignPlan } from "../part-design.ts";
import { addDays, delayedEvents, insertByDate } from "./calendar.ts";
import { findBuilding } from "./hq.ts";
import { adjustBudget } from "./finance.ts";
import { fitPart } from "./parts.ts";

/** Single-seater part types that can be designed, with the carPartDesign field of their components. */
const COMPONENT_LISTS: Partial<Record<PartType, string>> = {
  Brakes: "brakeComponents", Engine: "engineComponents", FrontWing: "frontWingComponents",
  Gearbox: "gearboxComponents", RearWing: "rearWingComponents", Suspension: "suspensionComponents",
};
const ENGLISH_NAME: Partial<Record<PartType, string>> = {
  Brakes: "Brakes", Engine: "Engine", FrontWing: "Front Wing", Gearbox: "Gearbox", RearWing: "Rear Wing", Suspension: "Suspension",
};
const STAGE = { Idle: 0, Designing: 1 } as const;
const BUILDING = { DesignCentre: 0, Factory: 1 } as const;
const IMPROVE = { Reliability: 1, Performance: 3 } as const;
// "Designing <part> Finished".
const TEXT_DESIGN_DONE = "PSG_10009151";

function designable(type: string): PartType {
  if (!COMPONENT_LISTS[type as PartType]) throw new Error(`Part type ${type} can't be designed (single-seater types only)`);
  return type as PartType;
}

export function carPartDesign(save: Save, team: Obj): Obj {
  return save.g.deref(save.g.deref<Obj>(team.carManager).carPartDesign);
}

function isPlayerTeam(save: Save, team: Obj): boolean {
  return save.g.same(save.data.player.mPlayerTeam, team) || save.data.player.mPlayerTeam === team;
}

function isBuilt(b: Obj): boolean {
  return b.state !== 0 && b.state !== 1; // NotBuilt, BuildingInProgress
}

function partSettings(save: Save, team: Obj, type: PartType): Obj {
  const champ = save.championship(team).championshipID;
  const byChamp = (save.data.partSettingsManager.championshipPartSettings as Obj[]).find((e) => e.Key === champ);
  const entry = byChamp && (byChamp.Value as Obj[]).find((e) => e.Key === PART_TYPES.indexOf(type));
  if (!entry) throw new Error(`No part settings for ${type} in championship ${champ}`);
  return save.g.deref(entry.Value);
}

/** CarPartUnlockRequirement.IsLocked; only the HQ building kind exists in the data. */
function isLocked(save: Save, team: Obj, req: Json): boolean {
  const r = save.g.deref<Obj>(req);
  if (!r) return false;
  if ("buildingType" in r) {
    const b = save.buildings(team).find((b) => save.buildingInfo(b).type === r.buildingType);
    return !!b && (!isBuilt(b) || b.currentLevel < r.buildingLevel);
  }
  throw new Error(`Unknown unlock requirement ${r.$type ?? JSON.stringify(Object.keys(r))}`);
}

function leadEngineer(save: Save, team: Obj): Obj | null {
  const slot = save.slots(team).find((s) => s.jobType === 3 && s.personHired);
  return slot ? save.g.deref(slot.personHired) : null;
}

export function toDesignComponent(save: Save, c: Obj): DesignComponent {
  return {
    id: c.id,
    level: c.level,
    engineer: c.componentType === 1,
    statBoost: num(c.statBoost),
    maxStatBoost: num(c.maxStatBoost),
    reliabilityBoost: num(c.reliabilityBoost),
    maxReliabilityBoost: num(c.maxReliabilityBoost),
    cost: num(c.cost),
    days: num(c.productionTime),
    risk: num(c.riskLevel),
    bonuses: (c.mBonuses ?? []).map((b: Json) => save.g.deref<Obj>(b)).map((b: Obj) => ({ type: b.$type ?? "", value: num(b.bonusValue ?? 0) })),
    summary: String(c.mCustomComponentName ?? ""),
  };
}

export interface DesignOptions {
  ctx: DesignContext;
  /** Components the team may choose now, with their game objects. */
  available: { component: DesignComponent; obj: Obj }[];
  /** Highest component level the team's HQ allows (1..5). */
  maxLevel: number;
}

/**
 * What a team can design for one part type, as MM's design screen shows it: this season's
 * component list (3 per level), the lead engineer's own components, and the levels the part's
 * development building unlocks.
 */
export function designOptions(save: Save, team: Obj, type: PartType): DesignOptions {
  designable(type);
  const g = save.g;
  const cpd = carPartDesign(save, team);
  const settings = partSettings(save, team, type);
  const unlocks: Json[] = settings.unlockRequirements ?? [];
  const levelOpen = (i: number) => !isLocked(save, team, unlocks[Math.min(i, unlocks.length - 1)]);
  const engineer = leadEngineer(save, team);
  const engineerComps: Json[] = engineer?.availableComponents ?? [];

  const available: DesignOptions["available"] = [];
  let maxLevel = 0;
  for (const entry of cpd[COMPONENT_LISTS[type]!] as Obj[]) {
    const i = entry.Key as number;
    if (!levelOpen(i)) continue;
    maxLevel = Math.max(maxLevel, i + 1);
    const list = [...g.list<Obj>(entry.Value)];
    if (engineerComps[i]) list.unshift(g.deref<Obj>(engineerComps[i]));
    for (const obj of list) {
      if (!obj || (obj.unlockRequirements ?? []).some((r: Json) => isLocked(save, team, r))) continue;
      available.push({ component: toDesignComponent(save, obj), obj });
    }
  }

  // GetNumberOfSlots: highest part level of this type + 1 (+1 after a "levelled up" dilemma).
  const highest = Math.max(0, ...save.parts(team, type).map((p) => Number(p.mStats?.level ?? 0)));
  const levelledUp: Json[] = save.data.dilemmaSystem?.carPartsLeveledUp ?? [];
  const slots = Math.min(5, Math.max(1, highest + 1 + (levelledUp.includes(PART_TYPES.indexOf(type)) ? 1 : 0)));
  const dc = findBuilding(save, team, BUILDING.DesignCentre);
  const isPlayer = isPlayerTeam(save, team);
  const ctx: DesignContext = {
    settings: {
      materialsCost: num(settings.materialsCost),
      buildTimeDays: num(settings.buildTimeDays),
      costPerLevel: (settings.costPerLevel as Json[]).map(num),
      timePerLevel: (settings.timePerLevel as Json[]).map(num),
    },
    slots: cpd.mAllPartsUnlocked ? 5 : slots,
    designCentreLevel: isBuilt(dc) ? dc.currentLevel : null,
    isPlayer,
    // Player.designPartTimeModifier: only the ex-engineer backstory (PlayerBackStoryType 1) has it.
    playerTimeModifierDays: isPlayer && save.data.player?.mPlayerBackStory?.mBackStory === 1
      ? timeSpanDays(save.data.player.mPlayerBackStory.mPartDesignTimeModifier) : 0,
  };
  return { ctx, available, maxLevel };
}

/** A C# TimeSpan as FullSerializer writes it ("1.00:00:00" or "00:00:00") in days. */
function timeSpanDays(v: Json): number {
  if (typeof v !== "string") return 0;
  const m = /^(-)?(?:(\d+)\.)?(\d+):(\d+):(\d+)/.exec(v);
  if (!m) return 0;
  const d = Number(m[2] ?? 0) + Number(m[3]) / 24 + Number(m[4]) / 1440 + Number(m[5]) / 86400;
  return m[1] ? -d : d;
}

export interface StartDesignOp {
  op: "startDesign";
  team: string | number;
  type: PartType;
  /** Component ids, as in the team's design options. */
  components: number[];
}

/** Work out a design without changing the save (used by `startDesign`, pull and tests). */
export function previewDesign(save: Save, team: Obj, type: PartType, ids: number[]): DesignPlan & { objs: Map<number, Obj> } {
  const opts = designOptions(save, team, type);
  const objs = new Map<number, Obj>();
  const chosen = ids.map((id) => {
    const a = opts.available.find((x) => x.component.id === id);
    if (!a) throw new Error(`${team.name}: component ${id} isn't available for ${type}`);
    objs.set(id, a.obj);
    return a.component;
  });
  if (!chosen.length) throw new Error("Choose at least one component");
  return { ...planDesign(opts.ctx, chosen), objs };
}

/**
 * Start designing a part the way MM's design screen does (InitializeNewPart, AddComponent,
 * StartDesigning). The game finishes it itself: the calendar event calls PartComplete, which
 * builds the part(s) with MM's own stats. Cost is not taken here (see adjustBudget).
 */
export function startDesign(save: Save, op: StartDesignOp): string {
  const type = designable(op.type);
  const g = save.g;
  const team = save.team(op.team);
  const cpd = carPartDesign(save, team);
  if (cpd.mStage !== STAGE.Idle) {
    const current = cpd.mCarPart ? g.deref<Obj>(cpd.mCarPart) : null;
    throw new Error(`${team.name} is already designing ${current?.$type ?? "a part"} (MM designs one part at a time)`);
  }
  const plan = previewDesign(save, team, type, op.components);
  const ref = (id: number | null) => (id == null ? null : g.ref(plan.objs.get(id)!));

  // The part being designed: a new entity cloned from one of the team's parts of this type.
  const inventory = save.parts(team, type);
  if (!inventory.length) throw new Error(`${team.name} has no ${type} part to use as a template`);
  const template = inventory.find((p) => !p.isFitted) ?? inventory[0];
  const part = g.clone({ ...template, fittedCar: null, isFitted: false, components: [] });
  part.components = [...plan.slots, ...plan.bonusSlots.map((b) => b.component)].map(ref);
  part.name = `${type[0]}-${Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
  part.buildDate = NULL_DATE;
  part.isBanned = false;
  part.developmentVariance = float(0);
  const s = part.mStats;
  // Only a preview: PartComplete re-applies the components to the parts it builds.
  s.level = plan.level;
  s.mStat = float(Number(seasonStartStat(save, team, type)) + [...plan.objs.values()].reduce((sum, c) => sum + num(c.statBoost), 0));
  s.mPerformance = float(0);
  s.mReliability = float(0);
  s.rulesRisk = float(0);
  if (s.partCondition) s.partCondition.mCondition = float(0);
  g.rawList(save.data.entityManager.mEntities).push(g.ref(part));

  const start = save.now;
  const end = addDays(start, plan.days);
  cpd.componentSlots = plan.slots.map(ref);
  cpd.componentBonusSlots = plan.bonusSlots.map((b) => ref(b.component));
  cpd.componentBonusSlotsLevel = plan.bonusSlots.map((b) => b.level);
  cpd.mCarPart = g.ref(part);
  cpd.mStage = STAGE.Designing;
  cpd.mExtraCopies = plan.extraCopies;
  cpd.mComponentTimeDaysBonus = float(0);
  cpd.mRandomComponent = null;
  cpd.mImidiateFinish = false;
  cpd.startDate = start;
  cpd.endDate = end;
  cpd.mCalendarEvent = g.ref(addDesignEvent(save, team, cpd, type, end));

  const copies = plan.extraCopies ? ` x${1 + plan.extraCopies}` : "";
  return `${team.name}: designing ${type}${copies} (level ${plan.level}, components ${op.components.join(",")}), done ${end.slice(0, 10)} (${plan.days.toFixed(1)} days)`;
}

function seasonStartStat(save: Save, team: Obj, type: PartType): number {
  const e = (carPartDesign(save, team).seasonPartStartingStat as Obj[]).find((x) => x.Key === PART_TYPES.indexOf(type));
  return e ? num(e.Value) : 0;
}

/** The calendar event StartDesigning adds: PartComplete on this design at its end date. */
function addDesignEvent(save: Save, team: Obj, cpd: Obj, type: PartType, end: string): Obj {
  const g = save.g;
  const events = delayedEvents(save).map((e) => g.deref<Obj>(e)).filter((e) => e?.OnEventTrigger);
  const designEvents = events.filter((e) => e.OnEventTrigger.methodNames?.[0] === "PartComplete");
  const typeOf = (e: Obj) => {
    const d = g.deref<Obj>(e.OnEventTrigger.targets?.[0]);
    const p = d?.mCarPart ? g.deref<Obj>(d.mCarPart) : null;
    return p ? PART_TYPES.find((t) => `${t}Part` === p.$type) : undefined;
  };
  const template = designEvents.find((e) => typeOf(e) === type) ?? designEvents[0];
  if (!template) throw new Error("No part design in progress anywhere in the save to copy the calendar event from");

  const ev = g.clone({ ...template, OnEventTrigger: { ...template.OnEventTrigger, targets: [] }, OnButtonClick: null });
  const runtime = save.types.runtime.get(template);
  if (runtime) save.types.runtime.set(ev, runtime);
  ev.OnEventTrigger.targets = [g.ref(cpd)];
  ev.OnEventTrigger.methodNames = ["PartComplete"];
  if (ev.displayEffect) ev.displayEffect.team = g.ref(team);
  const isPlayer = isPlayerTeam(save, team);
  ev.showOnCalendar = isPlayer;
  ev.interruptGameTime = isPlayer;
  ev.triggerDate = end;
  ev.triggerCacheDayDate = end.slice(0, 10) + "T00:00:00.0000000";
  const from = typeOf(template);
  if (ev.mDynamicDescription) {
    ev.mDynamicDescription.textID = TEXT_DESIGN_DONE;
    if (from && from !== type) {
      // Different part: swap the English name in (other languages keep the template's name).
      const texts = ev.mDynamicDescription.translatedText ?? {};
      for (const lang of Object.keys(texts)) texts[lang] = String(texts[lang]).split(ENGLISH_NAME[from]!).join(ENGLISH_NAME[type]!);
    }
  }
  insertByDate(save, ev, end);
  return ev;
}

export interface CancelDesignOp {
  op: "cancelDesign";
  team: string | number;
  /** Give back what MM charged when the design started (default true). */
  refund?: boolean;
  reason?: string;
}

/** Stop the design in progress, as if it never started, and refund what the game charged. */
export function cancelDesign(save: Save, op: CancelDesignOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const cpd = carPartDesign(save, team);
  if (cpd.mStage !== STAGE.Designing || !cpd.mCarPart) throw new Error(`${team.name} isn't designing a part`);
  const part = g.deref<Obj>(cpd.mCarPart);
  const type = PART_TYPES.find((t) => `${t}Part` === part.$type);
  const price = type ? chargedPrice(save, team, type, part) : 0;

  const events = delayedEvents(save);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = g.deref<Obj>(events[i]);
    if (e?.OnEventTrigger?.methodNames?.[0] === "PartComplete" && g.deref(e.OnEventTrigger.targets?.[0]) === cpd) events.splice(i, 1);
  }
  const entities = g.rawList(save.data.entityManager.mEntities);
  const at = entities.findIndex((e) => g.deref(e) === part);
  if (at >= 0) entities.splice(at, 1);
  // CarPartDesign.Reset
  cpd.mStage = STAGE.Idle;
  cpd.mExtraCopies = 0;
  cpd.mComponentTimeDaysBonus = float(0);
  cpd.mImidiateFinish = false;
  cpd.mCarPart = null;
  cpd.mCalendarEvent = null;
  cpd.startDate = save.now;
  cpd.endDate = save.now;

  let msg = `${team.name}: cancelled designing ${type ?? part.$type}`;
  if (op.refund !== false && price > 0) {
    msg += "; " + adjustBudget(save, { op: "adjustBudget", team: op.team, delta: price, reason: op.reason ?? `Refund: ${ENGLISH_NAME[type!] ?? "part"} design (not ordered on the league site)` });
  }
  return msg;
}

/** GetDesignCost for a part's components, as MM charged the team (AI teams pay 10 % of materials). */
function chargedPrice(save: Save, team: Obj, type: PartType, part: Obj): number {
  if (!COMPONENT_LISTS[type]) return 0;
  const s = partSettings(save, team, type);
  const comps = save.g.list<Obj>(part.components).filter(Boolean);
  const compCost = comps.reduce((sum, c) => sum + (num(c.cost) !== 0 ? num(c.cost) : c.componentType === 1 ? 0 : num(s.costPerLevel[c.level - 1])), 0);
  return Math.round(Math.max(0, num(s.materialsCost) * (isPlayerTeam(save, team) ? 1 : 0.1) + compCost));
}

const componentIds = (save: Save, part: Obj) => save.g.list<Obj>(part.components ?? []).filter(Boolean).map((c) => c.id as number);
const sameSet = (a: number[], b: number[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

export interface RemoveUnorderedPartsOp {
  op: "removeUnorderedParts";
  teams: (string | number)[];
  /** Designs the league ordered (any number of parts may come from one). */
  keep: { team: string; type: PartType; components: number[] }[];
  /** League start; parts built before it are left alone. */
  since: string;
}

/**
 * Parts the in-game AI designed *and* finished on member teams between checkpoints: remove
 * them and refund their price (once per design: copies built the same day share it). A fitted
 * one is replaced on the car by the team's best other part of that type first.
 */
export function removeUnorderedParts(save: Save, op: RemoveUnorderedPartsOp): string[] {
  const log: string[] = [];
  for (const key of op.teams) {
    const team = save.team(key);
    for (const type of Object.keys(COMPONENT_LISTS) as PartType[]) {
      const unordered = save.parts(team, type).filter((p) => {
        if (String(p.buildDate) <= op.since) return false;
        const ids = componentIds(save, p);
        return !op.keep.some((k) => k.team === team.name && k.type === type && sameSet(k.components, ids));
      });
      const refunded = new Set<string>();
      for (const part of unordered) {
        if (part.isFitted) {
          const car = save.cars(team).findIndex((c) => save.g.same(c, part.fittedCar) || c === save.g.deref(part.fittedCar));
          const spare = save.parts(team, type)
            .filter((p) => !p.isFitted && !unordered.includes(p))
            .sort((a, b) => num(b.mStats.mStat) + num(b.mStats.mPerformance) - num(a.mStats.mStat) - num(a.mStats.mPerformance))[0];
          if (!spare) { log.push(`${team.name}: kept ${part.name}, the only ${type} left for car ${car}`); continue; }
          log.push(fitPart(save, { op: "fitPart", team: team.name, type, part: spare.id, car: car as 0 | 1 }));
        }
        const list = save.partList(team, type);
        list.splice(list.findIndex((p) => save.g.deref(p) === part), 1);
        const entities = save.g.rawList(save.data.entityManager.mEntities);
        const at = entities.findIndex((e) => save.g.deref(e) === part);
        if (at >= 0) entities.splice(at, 1);
        let msg = `${team.name}: removed ${type} ${part.name} (built by the AI, not ordered on the league site)`;
        const design = `${String(part.buildDate).slice(0, 10)}|${componentIds(save, part).sort().join()}`;
        const price = chargedPrice(save, team, type, part);
        if (!refunded.has(design) && price > 0) {
          refunded.add(design);
          msg += "; " + adjustBudget(save, { op: "adjustBudget", team: team.name, delta: price, reason: `Refund: ${ENGLISH_NAME[type]} built by the AI` });
        }
        log.push(msg);
      }
    }
  }
  return log.length ? log : ["No unordered parts on member teams"];
}

export interface CancelUnorderedDesignsOp {
  op: "cancelUnorderedDesigns";
  /** Member teams: the league site decides their designs. */
  teams: (string | number)[];
  /** Designs the league ordered: the part type and its components. */
  keep: { team: string; type: PartType; components: number[] }[];
  /** League start (first published game date); older designs are left alone. */
  since: string;
}

/** Cancel and refund designs the in-game AI started on member teams. */
export function cancelUnorderedDesigns(save: Save, op: CancelUnorderedDesignsOp): string[] {
  const g = save.g;
  const log: string[] = [];
  for (const key of op.teams) {
    const team = save.team(key);
    const cpd = carPartDesign(save, team);
    if (cpd.mStage !== STAGE.Designing || !cpd.mCarPart || String(cpd.startDate) <= op.since) continue;
    const part = g.deref<Obj>(cpd.mCarPart);
    const ids = componentIds(save, part);
    const ordered = op.keep.some((k) => k.team === team.name && `${k.type}Part` === part.$type && sameSet(k.components, ids));
    if (!ordered) log.push(cancelDesign(save, { op: "cancelDesign", team: team.name }));
  }
  return log.length ? log : ["No part designs to cancel on member teams"];
}

export interface SetImprovementOp {
  op: "setImprovement";
  team: string | number;
  /** Part GUIDs the mechanics work on, per stat. */
  performance: string[];
  reliability: string[];
  /** Share of the mechanics on performance, 0..1 (MM's slider). */
  split?: number;
}

/** Number of parts per improvement list: 2/4/6/8 for Factory level 0-3 (GetPartSlotsCount). */
export function improvementSlots(save: Save, team: Obj): number {
  const factory = findBuilding(save, team, BUILDING.Factory);
  return Math.round(2 + (8 - 2) * (factory.currentLevel / 3));
}

/** Choose the parts the mechanics improve, as MM's car screen does (AddPartToImprove, SplitMechanics). */
export function setImprovement(save: Save, op: SetImprovementOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const pi = g.deref<Obj>(g.deref<Obj>(team.carManager).partImprovement);
  const max = improvementSlots(save, team);
  const all = PART_TYPES.flatMap((t) => { try { return save.parts(team, t); } catch { return []; } });
  const notes: string[] = [];
  const lists: Record<number, Obj[]> = {};
  for (const [stat, guids] of [[IMPROVE.Performance, op.performance], [IMPROVE.Reliability, op.reliability]] as const) {
    if (guids.length > max) throw new Error(`${team.name}: at most ${max} parts per improvement list (Factory level)`);
    lists[stat] = [];
    for (const guid of guids) {
      const p = all.find((x) => x.id === guid);
      if (!p) { notes.push(`part ${guid} is gone`); continue; }
      const st = p.mStats;
      const done = stat === IMPROVE.Reliability ? num(st.mReliability) >= num(st.maxReliability) : num(st.mPerformance) >= num(st.maxPerformance);
      if (p.isBanned || done) { notes.push(`${p.name} ${p.isBanned ? "is banned" : "is already at its max"}`); continue; }
      lists[stat].push(p);
    }
  }
  for (const e of pi.partsToImprove as Obj[]) {
    if (!(e.Key in lists)) continue;
    const before = g.list<Obj>(e.Value);
    const after = lists[e.Key as number];
    if (before.length === after.length && before.every((p, i) => p === after[i])) continue;
    e.Value = after.map((p) => g.ref(p));
    const start = (pi.partWorkStartDate as Obj[]).find((x) => x.Key === e.Key);
    if (start) start.Value = save.now;
  }
  // UpdateMechanicsDistribution with the member's slider as the preference.
  const pref = Math.min(1, Math.max(0, op.split ?? num(pi.mPlayerMechanicsPreference ?? 0.5)));
  const split = !lists[IMPROVE.Performance].length && lists[IMPROVE.Reliability].length ? 0
    : lists[IMPROVE.Performance].length && !lists[IMPROVE.Reliability].length ? 1 : pref;
  const total = Number(findBuilding(save, team, BUILDING.Factory).mStaffNumber ?? 0);
  const onPerf = Math.round(split * total);
  for (const m of pi.mechanics as Obj[]) {
    if (m.Key === IMPROVE.Performance) m.Value = onPerf;
    if (m.Key === IMPROVE.Reliability) m.Value = total - onPerf;
  }
  pi.mNormalizedMechanicDistribution = float(split);
  pi.mPlayerMechanicsPreference = float(pref);
  pi.mRefreshEndDate = true;

  const names = (l: Obj[]) => l.map((p) => p.name).join(", ") || "none";
  let msg = `${team.name}: improving performance [${names(lists[IMPROVE.Performance])}], reliability [${names(lists[IMPROVE.Reliability])}], ${Math.round(split * 100)}% of ${total} mechanics on performance`;
  if (notes.length) msg += ` (skipped: ${notes.join("; ")})`;
  return msg;
}
