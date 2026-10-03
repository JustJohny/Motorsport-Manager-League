import type { Json } from "../codec/sav.ts";
import type { Obj } from "../graph.ts";
import type { SponsorDeal, SponsorOffer, SponsorOnCar, SponsorTerms, TeamSponsorship } from "../league-types.ts";
import { numOrNull, type Save } from "../model.ts";
import { addDays, delayedEvents, insertByDate } from "./calendar.ts";

// MM's sponsor rules (SponsorController, ContractSponsor and Sponsor in Assembly-CSharp).
// See docs/save-schema.md, "Sponsors".

/** Sponsor.Category. */
const CATEGORIES = [
  "Alcoholic Drinks", "Appliances", "Automotive", "Banking", "Clothing", "Fashion", "Food",
  "Games", "Media", "Oil", "Security", "Technology", "Telecoms", "Travel",
];
/** Contract.ContractStatus. */
const ON_GOING = 1;
const TERMINATED = 3;
/** CalendarEvent text "Sponsorship Deal Ends With <sponsor>". */
const TEXT_DEAL_ENDS = "PSG_10009158";

export interface SignSponsorOp {
  op: "signSponsor";
  team: string | number;
  /** 0..5 (SponsorSlot.SlotType). */
  slot: number;
  /** The offering sponsor's GUID. */
  sponsorId: string;
}

export interface DropSponsorOp {
  op: "dropSponsor";
  team: string | number;
  slot: number;
  /** The sponsor expected in the slot (a guard against stale orders). */
  sponsorId: string;
}

function controller(save: Save, team: Obj): Obj {
  return save.g.deref<Obj>(team.sponsorController);
}

function slotObj(save: Save, sc: Obj, slot: number): Obj {
  const s = save.g.list<Obj>(sc.mSlots)[slot];
  if (!s) throw new Error(`No sponsor slot ${slot}`);
  return s;
}

/** The raw offer list for a slot (sponsorOffers is a Map<SlotType, List<ContractSponsor>>). */
function offerList(save: Save, sc: Obj, slot: number): Json[] {
  const map = save.g.deref<Obj>(sc.sponsorOffers);
  const i = save.g.rawList(map.mKeys).findIndex((k) => k === slot);
  return i < 0 ? [] : save.g.rawList(save.g.rawList(map.mValues)[i]);
}

function onCar(save: Save, slot: number, sponsor: Obj): SponsorOnCar {
  return { slot, sponsor: sponsor.name as string, category: CATEGORIES[sponsor.category as number] ?? "Other", prestige: sponsor.prestigeLevel as number };
}

function terms(save: Save, slot: number, c: Obj): SponsorTerms {
  const sponsor = save.g.deref<Obj>(c.mSponsor);
  return {
    ...onCar(save, slot, sponsor),
    sponsorId: sponsor.id as string,
    upfront: c.upfrontValue as number,
    perRace: c.perRacePayment as number,
    bonus: c.bonusValuePerRace as number,
    bonusTarget: c.bonusTarget as number,
    homeBonus: numOrNull(sponsor.homeBonusMultiplier) ?? 1,
    length: c.contractTotalRaces as number,
    offerDate: c.offerDate as string,
  };
}

/** A team's sponsors for the extract: what's on the car (public) and the money terms and offers (private). */
export function teamSponsors(save: Save, team: Obj): { onCar: SponsorOnCar[]; sponsorship: TeamSponsorship } | null {
  if (!team.sponsorController) return null;
  const sc = controller(save, team);
  const deals: SponsorDeal[] = [];
  save.g.list<Obj>(sc.mSlots).forEach((s, slot) => {
    const deal = s.sponsorshipDeal ? save.g.deref<Obj>(s.sponsorshipDeal) : null;
    const c = deal?.contract ? save.g.deref<Obj>(deal.contract) : null;
    if (!c) return;
    deals.push({ ...terms(save, slot, c), left: c.contractRacesLeft as number, end: c.mEndDate as string, earned: c.historyTotalBonus as number });
  });
  const offers: SponsorOffer[] = [];
  for (let slot = 0; slot < 6; slot++) {
    for (const raw of offerList(save, sc, slot)) {
      const c = save.g.deref<Obj>(raw);
      const daysLeft = c.offerRacesLeft as number;
      offers.push({ ...terms(save, slot, c), daysLeft, expires: addDays(save.now.slice(0, 10) + "T00:00:00.0000000", daysLeft) });
    }
  }
  return { onCar: deals.map(({ slot, sponsor, category, prestige }) => ({ slot, sponsor, category, prestige })), sponsorship: { deals, offers } };
}

/** Give a new object the runtime type of an existing one, so `$type` annotation knows it. */
function typedLike<T extends Obj>(save: Save, o: T, template: Obj | undefined): T {
  const rt = template && save.types.runtime.get(template);
  if (!rt) throw new Error("No object in the save to copy the type from");
  save.types.runtime.set(o, rt);
  return o;
}

/** Any sponsorship deal in the save, as a type template for new ones. */
function anyDeal(save: Save): Obj | undefined {
  for (const t of save.teams()) {
    if (!t.sponsorController) continue;
    const d = save.g.list<Obj>(controller(save, t).mSponsorshipDeals)[0];
    if (d) return d;
  }
  return undefined;
}

/** Sponsor.IgnoreTeam: no new offer to this team until the sponsor's cooldown has passed. */
function ignoreTeam(save: Save, sponsor: Obj, team: Obj) {
  if (!Array.isArray(sponsor.mTeamsIgnored)) sponsor.mTeamsIgnored = []; // an empty dictionary is saved as {}
  const list = sponsor.mTeamsIgnored as Obj[];
  const i = list.findIndex((e) => save.g.same(e.Key, team));
  if (i >= 0 && (list[i].Value as string) > save.now) return;
  if (i >= 0) list.splice(i, 1); // expired: IsTeamIgnored drops it
  const template = save.g.list<Obj>(save.data.sponsorManager.mEntities)
    .flatMap((s) => (Array.isArray(s.mTeamsIgnored) ? (s.mTeamsIgnored as Obj[]) : []))[0];
  list.push(typedLike(save, { Key: save.g.ref(team), Value: addDays(save.now, sponsor.offerCooldown as number) }, template));
}

/** Sponsor.RemoveCalendarEvent. */
function removeEvent(save: Save, c: Obj) {
  if (!c.calendarEvent) return;
  const ev = save.g.deref<Obj>(c.calendarEvent);
  const list = delayedEvents(save);
  const i = list.findIndex((e) => save.g.deref(e) === ev);
  if (i >= 0) list.splice(i, 1);
  c.calendarEvent = null;
}

/** ContractSponsor.SetContractExpiryDate: the race `left` races on (next season's calendar past the end) + 7 hours. */
function contractEnd(save: Save, team: Obj, left: number): string {
  const ch = save.g.deref<Obj>(team.championship);
  const cal = save.g.list<Obj>(ch.calendar);
  const next = save.g.list<Obj>(ch.nextYearsCalendar ?? []);
  const remaining = cal.length - (ch.mEventNumber as number);
  const ev = left <= remaining ? cal[(ch.mEventNumber as number) + left - 1]
    : next.length ? next[left - remaining - 1 < next.length ? left - remaining - 1 : 0] : null;
  if (!ev) return addDays(save.now, 30 + 7 / 24);
  const races = save.g.list<Obj>(ev.mRaceSessions ?? []);
  const race = races.find((r) => !r.mHasEnded) ?? races.at(-1);
  return addDays((race?.mSessionDateTime ?? ev.eventDate) as string, 7 / 24);
}

/** A copy of MM's "Sponsorship Deal Ends With X" event, from another deal in the save. */
function addEndEvent(save: Save, team: Obj, c: Obj, end: string) {
  const g = save.g;
  const queued = new Set(delayedEvents(save).map((e) => g.deref(e)));
  let template: Obj | null = null;
  let templateName = "";
  for (const t of save.teams()) {
    if (!t.sponsorController) continue;
    for (const d of g.list<Obj>(controller(save, t).mSponsorshipDeals)) {
      const dc = d?.contract ? g.deref<Obj>(d.contract) : null;
      const ev = dc?.calendarEvent ? g.deref<Obj>(dc.calendarEvent) : null;
      if (ev && queued.has(ev) && ev.mDynamicDescription?.textID === TEXT_DEAL_ENDS) {
        template = ev;
        templateName = g.deref<Obj>(dc!.mSponsor).name as string;
        break;
      }
    }
    if (template) break;
  }
  if (!template) return; // Only the notification is missing: MM ends deals by their months left.
  const ev = g.clone(template);
  const type = save.types.runtime.get(template);
  if (type) save.types.runtime.set(ev, type);
  if (ev.displayEffect) ev.displayEffect.team = g.ref(team);
  const isPlayer = g.same(save.data.player.mPlayerTeam, team);
  ev.showOnCalendar = isPlayer;
  ev.interruptGameTime = isPlayer;
  ev.triggerDate = end;
  ev.triggerCacheDayDate = end.slice(0, 10) + "T00:00:00.0000000";
  const name = g.deref<Obj>(c.mSponsor).name as string;
  const texts = ev.mDynamicDescription?.translatedText ?? {};
  for (const lang of Object.keys(texts)) texts[lang] = String(texts[lang]).split(templateName).join(name);
  insertByDate(save, ev, end);
  c.calendarEvent = g.ref(ev);
}

/**
 * SponsorController.AcceptOffer → AddSponsor: the offer becomes the slot's deal, every offer for
 * the slot is withdrawn (each sponsor ignores the team for its cooldown), the contract starts and
 * gets MM's end date and "deal ends" event. The upfront money is a separate `adjustBudget`
 * (MM's UI pays it as its own transaction).
 */
export function signSponsor(save: Save, op: SignSponsorOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const sc = controller(save, team);
  const slot = slotObj(save, sc, op.slot);
  if (slot.sponsorshipDeal) throw new Error(`${team.name}'s slot ${op.slot} already has a sponsor`);
  const list = offerList(save, sc, op.slot);
  const idx = list.findIndex((o) => g.deref<Obj>(g.deref<Obj>(o).mSponsor).id === op.sponsorId);
  if (idx < 0) throw new Error(`${team.name} has no offer from sponsor ${op.sponsorId} for slot ${op.slot}`);
  const raw = list[idx];
  const c = g.deref<Obj>(raw);
  const sponsor = g.deref<Obj>(c.mSponsor);

  // RemoveSponsorOffer + ClearSponsorOffersForSlot (the offer was still a proposal, so withdrawn too).
  for (const o of list.splice(0).map((x) => g.deref<Obj>(x))) {
    ignoreTeam(save, g.deref<Obj>(o.mSponsor), team);
    removeEvent(save, o);
  }

  const template = anyDeal(save);
  const objective = (): Obj => typedLike(save, {
    mConditionType: 0, mFinancialReward: 0, mTargetResult: 0, mObjectiveExpired: false, mLastObjectiveCompleted: false,
    mSponsorshipDeal: null, $version: "v0",
  }, template && g.deref<Obj>(template.qualifyingObjective));
  const deal = typedLike(save, { qualifyingObjective: objective(), raceObjective: objective(), contract: raw, $version: "v0" } as Obj, template);
  slot.sponsorshipDeal = deal;
  g.rawList(sc.mSponsorshipDeals).push(g.ref(deal));

  // ContractSponsor.Setup(payUpfront: false).
  c.mContractStatus = ON_GOING;
  c.historyTotalBonus = (c.historyTotalBonus as number) + (c.upfrontValue as number);
  c.mEndDate = contractEnd(save, team, c.contractRacesLeft as number);
  g.rawList(sc.mUniqueSponsors).push(g.ref(sponsor));
  addEndEvent(save, team, c, c.mEndDate as string);
  return `${team.name}: ${sponsor.name} signed for slot ${op.slot} (${c.contractTotalRaces} months, ends ${(c.mEndDate as string).slice(0, 10)})`;
}

/** SponsorController.RemoveSponsorshipDeal: the deal ends now and the sponsor ignores the team for its cooldown. */
export function dropSponsor(save: Save, op: DropSponsorOp): string {
  const g = save.g;
  const team = save.team(op.team);
  const sc = controller(save, team);
  const slot = slotObj(save, sc, op.slot);
  const deal = slot.sponsorshipDeal ? g.deref<Obj>(slot.sponsorshipDeal) : null;
  if (!deal) throw new Error(`${team.name}'s slot ${op.slot} has no sponsor`);
  const c = g.deref<Obj>(deal.contract);
  const sponsor = g.deref<Obj>(c.mSponsor);
  if (sponsor.id !== op.sponsorId) throw new Error(`${team.name}'s slot ${op.slot} has ${sponsor.name}, not sponsor ${op.sponsorId}`);

  c.mContractStatus = TERMINATED;
  ignoreTeam(save, sponsor, team);
  removeEvent(save, c);
  slot.sponsorshipDeal = null;
  const deals = g.rawList(sc.mSponsorshipDeals);
  const di = deals.findIndex((d) => g.deref(d) === deal);
  if (di >= 0) deals.splice(di, 1);
  const unique = g.rawList(sc.mUniqueSponsors);
  const ui = unique.findIndex((s) => g.deref(s) === sponsor);
  if (ui >= 0) unique.splice(ui, 1);
  // MM keeps a dropped deal as the weekend sponsor until the next event; don't let it pay out.
  if (sc.mWeekendSponsorship && g.deref(sc.mWeekendSponsorship) === deal) sc.mWeekendSponsorship = null;
  return `${team.name}: ${sponsor.name} dropped from slot ${op.slot}`;
}
