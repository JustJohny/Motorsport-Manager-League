import type { ChangeSet } from "../apply.ts";
import { carChanges, fetchCarChoices } from "../car-orders.ts";
import { crewChanges, crewSpendChanges, fetchCrewContext, fetchCrewSpend, markCrewSpendApplied, saveCrewUpdates } from "../crew-orders.ts";
import { engineSpendChanges, fetchEngineSpend, fetchSupplierContext, markEngineSpendApplied, supplierChanges } from "../engine-orders.ts";
import { equalizeChanges, fetchEqualize, markEqualizeApplied, resetCrews } from "../equalize-orders.ts";
import { cancelUnorderedChange, fetchHqContext, fetchQueuedOrders, hqChanges, markOrdersApplied } from "../hq-orders.ts";
import type { LeagueSettings } from "../league-rules.ts";
import { choiceChanges, designChanges, fetchPartsContext, markDesignsApplied, undoAiParts } from "../part-orders.ts";
import { fetchRegulationContext, recordVoteResults, regulationChanges } from "../rule-votes.ts";
import { fetchSponsorOrders, markSponsorOrders, sponsorChanges } from "../sponsor-orders.ts";
import { fetchRenewals, markRenewalsApplied, renewalChanges } from "../renewal-orders.ts";
import { fetchTeamLooks, teamLookChanges } from "../team-look-orders.ts";
import { rest, type SupabaseEnv } from "../supabase.ts";
import { fetchWindow, markApplied, windowChanges, winners } from "../transfers.ts";
import type { Log } from "./common.ts";

/** One area of members' decisions, as the TUI previews them. */
export interface PullSection {
  title: string;
  /** How many decisions (orders, choices, signings) the area has. */
  count: number;
  lines: string[];
}

export interface PullResult {
  set: ChangeSet;
  notes: string[];
  sections: PullSection[];
  /** Mark everything pulled as applied on the site (`--mark-applied`). */
  markApplied: (log: Log) => Promise<void>;
}

/**
 * Everything members decided since the last apply, as one change set: first what MM's AI did to
 * member teams is undone, then the organizer's equalization, members' orders and standing choices,
 * and, once its deadline has passed (or with `force`), the transfer window's signings.
 */
export async function pullDecisions(env: SupabaseEnv, opts: { force?: boolean }, log: Log): Promise<PullResult> {
  const sections: PullSection[] = [];
  // Lines go to the log as they come and into the current section for the preview.
  let current: PullSection = { title: "Overview", count: 0, lines: [] };
  sections.push(current);
  const section = (title: string, count: number) => { current = { title, count, lines: [] }; sections.push(current); };
  const say = (line: string) => { log(line); current.lines.push(line.replace(/^ {2}/, "")); };

  say(`Series "${env.series}"`);
  const [w, orders, [settings]] = await Promise.all([
    fetchWindow(env), fetchQueuedOrders(env), rest<LeagueSettings[]>(env, "GET", "league_settings?select=*"),
  ]);
  const changes: ChangeSet["changes"] = [];
  const notes: string[] = [];

  // First undo what the in-game AI did to member teams' HQ since the last apply.
  const ctx = await fetchHqContext(env);
  if (ctx.leagueStart && ctx.memberTeams.length) changes.push(cancelUnorderedChange(ctx.memberTeams, ctx.orders, ctx.leagueStart));
  // ...and to their parts: AI designs and AI-built parts go, refunded.
  const parts = await fetchPartsContext(env);
  if (ctx.leagueStart && ctx.memberTeams.length) changes.push(...undoAiParts(ctx.memberTeams, parts.orders, ctx.leagueStart));
  // Member teams (and the career team) are never promoted or relegated; AI teams still are. Takes
  // effect on a save from between season end and pre-season start.
  if (ctx.memberTeams.length) changes.push({ op: "protectTeams", teams: ctx.memberTeams });

  // The organizer's equalization: after undoing the AI, before members' own orders.
  const eq = await fetchEqualize(env);
  if (eq.row && eq.snapshot) {
    const teams = eq.snapshot.teams.map((t) => t.name);
    section("Equalize the field", teams.length);
    say(`Equalize the field: ${teams.length} teams (${Object.keys(eq.row.settings).join(", ")})`);
    changes.push(...equalizeChanges(eq.row, teams));
    notes.push("equalization");
  }

  section("HQ orders", orders.length);
  say(`HQ orders: ${orders.length}`);
  for (const o of orders) {
    say(`  ${o.team}: ${o.to_level === 1 ? "build" : "upgrade"} ${o.building_name}${o.to_level > 1 ? ` to level ${o.to_level}` : ""}`
      + ` for $${Number(o.cost).toLocaleString()} (${Math.round(o.weeks * Number(settings.hq_speed))} weeks)`);
  }
  changes.push(...hqChanges(orders, Number(settings.hq_speed)));

  section("Parts", parts.queued.length);
  say(`Part designs: ${parts.queued.length}`);
  for (const o of parts.queued) say(`  ${o.team}: ${o.part_type} with components ${o.components.join(", ")} for $${Number(o.cost).toLocaleString()}`);
  changes.push(...designChanges(parts.queued));
  // Fitting and improvement are standing choices: re-applied every time, after the designs.
  say(`Fitting choices: ${parts.fitting.length}, improvement choices: ${parts.improvement.length}`);
  changes.push(...choiceChanges(parts.fitting, parts.improvement));

  // Engine programme spending (founding, development, research, engines bought from members).
  const engineSpend = await fetchEngineSpend(env);
  section("Engine programmes", engineSpend.length);
  for (const r of engineSpend) say(`  Engine: ${r.team} ${r.description} $${Number(r.amount).toLocaleString()}${r.payee ? ` to ${r.payee}` : ""}`);
  changes.push(...engineSpendChanges(engineSpend));
  if (engineSpend.length) notes.push(`${engineSpend.length} engine payment${engineSpend.length > 1 ? "s" : ""}`);

  // Next season's suppliers: applied once MM's AI has started next year's design (pre-season).
  const suppliers = await fetchSupplierContext(env);
  const sc = supplierChanges(suppliers.rows, suppliers.cars, ctx.memberTeams);
  section("Next season's suppliers", sc.changes.length);
  changes.push(...sc.changes);
  if (sc.changes.length || sc.waiting.length) {
    say(`Next season's suppliers: ${sc.changes.length} team${sc.changes.length === 1 ? "" : "s"}${sc.waiting.length ? `, waiting for pre-season: ${sc.waiting.join(", ")}` : ""}`);
    for (const c of sc.changes) if (c.op === "setSuppliers") say(`  ${c.team}: ${Object.entries(c.suppliers).map(([t, id]) => `${t} ${id}`).join(", ")}`);
  }
  for (const u of sc.unavailable) say(`  WARNING: supplier no longer on offer, keeping current: ${u}`);
  if (sc.changes.length) notes.push(`next season's suppliers for ${sc.changes.length} team${sc.changes.length === 1 ? "" : "s"}`);

  // Next year's car: fund levels (every pull) and, at pre-season, chassis sliders (after the suppliers).
  const carCtx = await fetchCarChoices(env);
  const cc = carChanges(carCtx.chassis, carCtx.investment, suppliers.cars, ctx.memberTeams);
  section("Next season's car", cc.changes.length);
  if (carCtx.missing) say("  WARNING: no chassis_choices / car_investment tables on the site yet (run migration 017_chassis_investment.sql); skipped");
  for (const c of cc.changes) {
    if (c.op === "setCarInvestment") say(`  ${c.team}: car fund ${["Low", "Medium", "High"][c.level]}`);
    if (c.op === "setChassis") say(`  ${c.team}: chassis nose ${c.nose.toFixed(2)}, rear ${c.rear.toFixed(2)}`);
  }
  if (cc.waiting.length) say(`  Chassis waiting for pre-season: ${cc.waiting.join(", ")}`);
  changes.push(...cc.changes);
  if (cc.changes.some((c) => c.op === "setChassis")) notes.push("chassis designs");

  // Rule votes due before the next checkpoint, settled with the league's result instead of MM's;
  // then the organizer's choices for next season.
  const reg = await fetchRegulationContext(env);
  let voteResults: Awaited<ReturnType<typeof regulationChanges>>["results"] = [];
  const regs = reg.snapshot?.championship.regulations;
  if (reg.snapshot && regs) {
    const next = reg.snapshot.championship.calendar.find((e) => !e.ended)?.date ?? null;
    const r = regulationChanges(regs, reg.snapshot.championship.id, reg.snapshot.gameDate, next, reg.rows, reg.overrides, reg.decided);
    voteResults = r.results;
    section("Rule votes", r.results.length);
    for (const v of r.results) say(`  Rule vote ${v.rule_id}: ${v.accepted ? "accepted" : "rejected"} ${v.yes}-${v.no} (${v.abstained} abstained)`);
    say(`Rule votes settled: ${r.results.length}, next-season overrides: ${reg.overrides.filter((o) => o.season === regs.season).length}`);
    changes.push(...r.changes);
    if (r.results.length) notes.push(`${r.results.length} rule vote${r.results.length > 1 ? "s" : ""}`);
  }

  // Member pit crews: their skills into MM's per-task values (a standing choice, re-applied every
  // time), then their wages, funding and sign-on fees.
  let crewCtx = await fetchCrewContext(env);
  // An equalization restarts member crews at its skill (saved by markApplied).
  const crewReset = eq.row?.settings.pitCrew && eq.snapshot ? resetCrews(crewCtx, env.series!, eq.snapshot, eq.row.settings.pitCrew.skill) : [];
  if (crewReset.length) crewCtx = { ...crewCtx, crew: crewReset.flatMap((u) => u.crew.map((c) => ({ ...c, team: u.team }))) };
  const crewOps = crewChanges(crewCtx, reg.snapshot?.championship.pitCrew?.roles ?? []);
  const crewSpend = await fetchCrewSpend(env);
  section("Pit crews", crewOps.length + crewSpend.length);
  if (crewReset.length) say(`  Pit crews reset: ${crewReset.map((u) => u.team).join(", ")}`);
  for (const c of crewOps) if (c.op === "setPitCrew") say(`  Pit crew ${c.team}: ${c.tasks.map((x) => `task ${x.target} ${x.stat}/${x.confidence}`).join(", ")}`);
  changes.push(...crewOps);
  for (const r of crewSpend) say(`  Crew: ${r.team} ${r.description} $${Number(r.amount).toLocaleString()}`);
  changes.push(...crewSpendChanges(crewSpend));
  if (crewOps.length) notes.push(`${crewOps.length} pit crew${crewOps.length > 1 ? "s" : ""}`);
  if (crewSpend.length) notes.push(`${crewSpend.length} crew payment${crewSpend.length > 1 ? "s" : ""}`);

  // Sponsors: AI deals members dropped (upfront paid back), then the offers they signed.
  const sponsorCtx = await fetchSponsorOrders(env);
  const sponsors = sponsorChanges(sponsorCtx.orders, sponsorCtx.gameDate);
  section("Sponsors", sponsors.applied.length);
  if (sponsorCtx.missing) say("  WARNING: no sponsor_orders table on the site yet (run migration 016_sponsors.sql); sponsors skipped");
  for (const o of sponsors.applied) {
    say(`  Sponsor: ${o.team} ${o.kind === "sign" ? "signs" : "drops"} ${o.sponsor_name} (slot ${o.slot})${Number(o.amount) ? `, upfront $${Number(o.amount).toLocaleString()}${o.kind === "drop" ? " paid back" : ""}` : ""}`);
  }
  for (const o of sponsors.expired) say(`  WARNING: ${o.team}'s offer from ${o.sponsor_name} lapsed on ${o.expires?.slice(0, 10)}; left out`);
  changes.push(...sponsors.changes);
  if (sponsors.applied.length) notes.push(`${sponsors.applied.length} sponsor choice${sponsors.applied.length > 1 ? "s" : ""}`);

  // Contract renewals: before the transfer window, so a renewed person's new terms are in place.
  const renewals = await fetchRenewals(env);
  section("Contract renewals", renewals.rows.length);
  if (renewals.missing) say("  WARNING: no contract_renewals table on the site yet (run migration 018_contract_renewals.sql); renewals skipped");
  for (const r of renewals.rows) {
    say(`  Renewal: ${r.team} renews ${r.kind} ${r.person_name} at $${Number(r.yearly_wage).toLocaleString()}/yr until ${r.new_end.slice(0, 10)}`
      + `${Number(r.sign_on_fee) ? `, sign-on fee $${Number(r.sign_on_fee).toLocaleString()}` : ""}`);
  }
  changes.push(...renewalChanges(renewals.rows));
  if (renewals.rows.length) notes.push(`${renewals.rows.length} contract renewal${renewals.rows.length > 1 ? "s" : ""}`);

  // Team colours and livery: a standing choice, re-applied every time (MM re-rolls AI liveries
  // each season). The colours only show with the team mod installed (mmsave team-mod).
  const looks = await fetchTeamLooks(env);
  section("Team identity", looks.rows.length);
  if (looks.missing) say("  WARNING: no team_looks table on the site yet (run migration 019_team_identity.sql); skipped");
  for (const r of looks.rows) say(`  Look: ${r.team} colour row ${r.color_id} (${r.primary_colour}), livery ${r.livery_id}`);
  if (looks.rows.length) say("  Colours need the current team mod in MM_Data/Modding: run mmsave team-mod if a look or logo changed");
  changes.push(...teamLookChanges(looks.rows));
  if (looks.rows.length) notes.push(`${looks.rows.length} team look${looks.rows.length > 1 ? "s" : ""}`);

  let windowDone = false;
  const won = w ? winners(w.auctions, w.bids, w.settings) : [];
  section("Transfer window", w ? won.length : 0);
  if (!w) say("Transfer window: none waiting");
  else if (new Date(w.window.closes_at) > new Date() && !opts.force) {
    say(`Transfer window #${w.window.id}: still open until ${new Date(w.window.closes_at).toLocaleString()}, skipped (--force to include)`);
    current.count = 0;
  } else {
    say(`Transfer window #${w.window.id}: ${w.auctions.length} auctions, ${won.length} signings`);
    for (const s of won) {
      say(`  ${s.team}: ${s.person.name}${s.fromTeam ? ` from ${s.fromTeam}` : ""} for $${s.wage.toLocaleString()}/yr x${s.years}, replacing ${s.replacingName}`
        + ` (fee $${s.signOnFee.toLocaleString()}${s.buyout ? `, buyout $${s.buyout.toLocaleString()}` : ""})`);
    }
    changes.push(...windowChanges(w.window.id, w.gameDate, w.auctions, w.bids, w.settings).changes);
    notes.push(`transfer window #${w.window.id}`);
    windowDone = true;
  }
  if (orders.length) notes.push(`${orders.length} HQ order${orders.length > 1 ? "s" : ""}`);
  if (parts.queued.length) notes.push(`${parts.queued.length} part design${parts.queued.length > 1 ? "s" : ""}`);

  return {
    set: { description: notes.join(" + ") || "nothing to apply", changes },
    notes,
    sections: sections.filter((s) => s.lines.length || s.count),
    markApplied: async (out: Log) => {
      await markOrdersApplied(env, orders.map((o) => o.id));
      await markDesignsApplied(env, parts.queued.map((o) => o.id));
      await recordVoteResults(env, voteResults);
      await markEngineSpendApplied(env, engineSpend.map((r) => r.id));
      await markCrewSpendApplied(env, crewSpend.map((r) => r.id));
      await markSponsorOrders(env, sponsors.applied.map((o) => o.id), sponsors.expired.map((o) => o.id));
      await markRenewalsApplied(env, renewals.rows.map((r) => r.id));
      if (eq.row) {
        await saveCrewUpdates(env, crewReset);
        await markEqualizeApplied(env, eq.row.id);
      }
      if (windowDone && w) await markApplied(env, w.window.id);
      out(`marked as applied: ${notes.join(" + ") || "nothing"}`);
    },
  };
}
