import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import { applyChanges } from "../src/apply.ts";
import type { LeagueState } from "../src/league-types.ts";
import { bidCost, buyout, DEFAULT_SETTINGS, minWage, nextHqStep, nextMinBid, unorderedProject } from "../src/league-rules.ts";
import { cancelUnorderedChange, hqChanges, type HqOrderRow } from "../src/hq-orders.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { windowChanges, winners, type AuctionRow, type BidRow, type WindowRow } from "../src/transfers.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
const BUDGET = 20_000_000;
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: snapshots and staff auction", () => {
  let state: LeagueState;
  let t: Awaited<ReturnType<typeof leagueDb>>;
  const org = () => t.member("org"), alice = () => t.member("alice"), bob = () => t.member("bob"), eve = () => t.member("eve");
  const staffOf = (team: string, job: string) => state.teams.find((x) => x.name === team)!.staff.filter((s) => s.job === job && s.person).map((s) => s.person!);
  const freeDriver = () => state.freeAgents.filter((p) => p.kind === "Driver").sort((a, b) => b.contract.yearlyWages - a.contract.yearlyWages)[5];
  const openWindow = (who = org()) => who.query<{ id: number }>("select public.open_window(now() + interval '1 day') as id");
  const openAuction = (who: ReturnType<typeof org>, guid: string) => who.query<{ id: number }>("select public.open_auction($1) as id", [guid]);
  const bid = (who: ReturnType<typeof org>, auction: number, wage: number, years: number, replacing: string) =>
    who.query("select public.place_bid($1, $2, $3, $4) as id", [auction, wage, years, replacing]);

  beforeAll(async () => {
    state = extractLeague(Save.load(SAVE), league);
    t = await leagueDb();
    const r = await t.service("select public.publish_snapshot($1, $2) as id", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))]);
    expect(r.error).toBeNull();
    for (const who of ["org", "alice", "bob", "eve"]) await t.member(who).query("select public.touch_login()");
    // Real budgets vary (Garuda is in debt in the base save); give member teams a known one.
    await t.service(`update team_snapshots set private = jsonb_set(private, '{budget}', '${BUDGET}')
                     where team in ('Tatra Racing', 'Garuda Racing', 'Octane Racing')`);
  }, 120_000);

  it("hides other teams' private data and everything from non-members", async () => {
    expect((await alice().query("select team from team_snapshots")).rows).toEqual([{ team: "Garuda Racing" }]);
    expect((await org().query("select team from team_snapshots")).rows).toHaveLength(state.teams.length);
    expect((await eve().query("select id from snapshots")).rows).toEqual([]);
    expect((await alice().query("select public.publish_snapshot('[]', '{}')")).error).toMatch(/permission denied/);
  });

  it("only lets the organizer open one window", async () => {
    expect((await openWindow(alice())).error).toMatch(/Only the organizer/);
    expect((await openWindow()).error).toBeNull();
    expect((await openWindow()).error).toMatch(/already open/);
  });

  it("prices an auction like the site does", async () => {
    const p = freeDriver();
    const { rows, error } = await openAuction(alice(), p.guid);
    expect(error).toBeNull();
    const a = (await alice().query<{ min_wage: string; buyout: string; from_team: string | null }>(
      "select min_wage, buyout, from_team from auctions where id = $1", [rows[0].id])).rows[0];
    expect(Number(a.min_wage)).toBe(minWage(p, DEFAULT_SETTINGS));
    expect(Number(a.buyout)).toBe(0);
    expect(a.from_team).toBeNull();
    // Opening the same person again returns the same auction.
    expect((await openAuction(bob(), p.guid)).rows[0].id).toBe(rows[0].id);
  });

  it("enforces minimum bids, steps, roles and who can bid", async () => {
    const p = freeDriver();
    const id = (await openAuction(alice(), p.guid)).rows[0].id;
    const min = minWage(p, DEFAULT_SETTINGS);
    const [aliceDriver] = staffOf("Garuda Racing", "Driver");
    const [bobDriver] = staffOf("Octane Racing", "Driver");
    const [aliceMechanic] = staffOf("Garuda Racing", "Mechanic");

    expect((await bid(alice(), id, min - 1000, 1, aliceDriver.guid)).error).toMatch(/minimum bid/);
    expect((await bid(alice(), id, min, 1, aliceMechanic.guid)).error).toMatch(/Choose a driver/);
    expect((await bid(alice(), id, min, 1, bobDriver.guid)).error).toMatch(/Choose a driver/);
    expect((await bid(alice(), id, min, 4, aliceDriver.guid)).error).toMatch(/1 to 3/);
    expect((await bid(eve(), id, min, 1, aliceDriver.guid)).error).toMatch(/not in the league/);
    expect((await bid(alice(), id, min, 2, aliceDriver.guid)).error).toBeNull();
    expect((await bid(alice(), id, min * 2, 2, aliceDriver.guid)).error).toMatch(/already the highest/);

    const step = nextMinBid(min, min, DEFAULT_SETTINGS);
    expect((await bid(bob(), id, step - 1000, 1, bobDriver.guid)).error).toMatch(/minimum bid/);
    expect((await bid(bob(), id, step, 1, bobDriver.guid)).error).toBeNull();

    const a = (await alice().query<{ leading_team: string; leading_wage: string; bid_count: number }>(
      "select leading_team, leading_wage, bid_count from auctions where id = $1", [id])).rows[0];
    expect(a).toMatchObject({ leading_team: "Octane Racing", bid_count: 2 });
    expect(Number(a.leading_wage)).toBe(step);
  });

  it("shows every bid, but who a team would release only to that team and the organizer", async () => {
    const history = (await alice().query("select * from bid_history")).rows;
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(history[0])).not.toContain("replacing_guid");
    expect((await alice().query<{ team: string }>("select team from bids")).rows.every((r) => r.team === "Garuda Racing")).toBe(true);
    expect((await org().query("select team from bids")).rows.length).toBe(history.length);
    expect((await eve().query("select * from bid_history")).rows).toEqual([]);
  });

  it("allows AI teams' staff with a buyout, but not member teams' staff", async () => {
    const aiTeam = state.teams.find((x) => !x.member)!;
    const aiDriver = staffOf(aiTeam.name, "Driver")[0];
    const { rows, error } = await openAuction(bob(), aiDriver.guid);
    expect(error).toBeNull();
    const a = (await bob().query<{ buyout: string; from_team: string }>("select buyout, from_team from auctions where id = $1", [rows[0].id])).rows[0];
    expect(a.from_team).toBe(aiTeam.name);
    expect(Number(a.buyout)).toBe(buyout(aiDriver, state.gameDate));
    expect(Number(a.buyout)).toBeGreaterThan(0);

    // Bob buys the AI driver out, releasing his second driver to the AI team.
    const bobSecond = staffOf("Octane Racing", "Driver")[1];
    expect((await bid(bob(), rows[0].id, minWage(aiDriver, DEFAULT_SETTINGS), 2, bobSecond.guid)).error).toBeNull();

    expect((await openAuction(bob(), staffOf("Garuda Racing", "Driver")[0].guid)).error).toMatch(/member team/);
    expect((await openAuction(bob(), staffOf("Octane Racing", "Driver")[0].guid)).error).toMatch(/already works for you/);
  });

  it("prices every AI staff member like the site: MM's buyout (≤6 months) and at least their wage", async () => {
    const staff = state.teams.filter((x) => !x.member).flatMap((x) => x.staff.filter((s) => s.person).map((s) => s.person!));
    expect(staff.length).toBeGreaterThan(20);
    for (const p of staff) {
      const r = (await t.service<{ open: string; buyout: string }>("select public.min_wage($1) as open, public.buyout($1, $2) as buyout",
        [JSON.stringify(p), state.gameDate])).rows[0];
      expect(Number(r.open), p.name).toBe(minWage(p, DEFAULT_SETTINGS));
      expect(Number(r.buyout), p.name).toBe(buyout(p, state.gameDate));
      expect(Number(r.open)).toBeGreaterThanOrEqual(p.contract.yearlyWages);
      // At most 6 months at FF20's yearly wage / 8.
      expect(Number(r.buyout)).toBeLessThanOrEqual(Math.round(p.contract.yearlyWages * 6 / 8 / 1000) * 1000 + 1000);
    }
  });

  it("won't let one person be replaced by two leading bids", async () => {
    const [p1, p2] = state.freeAgents.filter((p) => p.kind === "Mechanic").slice(0, 2);
    const [m] = staffOf("Octane Racing", "Mechanic");
    const a1 = (await openAuction(bob(), p1.guid)).rows[0].id;
    const a2 = (await openAuction(bob(), p2.guid)).rows[0].id;
    expect((await bid(bob(), a1, minWage(p1, DEFAULT_SETTINGS), 1, m.guid)).error).toBeNull();
    expect((await bid(bob(), a2, minWage(p2, DEFAULT_SETTINGS), 1, m.guid)).error).toMatch(/already being replaced/);
  });

  it("checks the budget against fees, buyouts and the rest of this season's wages", async () => {
    const budget = BUDGET;
    const p = state.freeAgents.filter((x) => x.kind === "Engineer")[0];
    const [eng] = staffOf("Garuda Racing", "EngineerLead");
    const id = (await openAuction(alice(), p.guid)).rows[0].id;
    // The smallest wage (in $1K steps) whose cost is over the budget.
    const cost = (w: number) => bidCost(w, 0, eng.contract.yearlyWages, state.gameDate, DEFAULT_SETTINGS).total;
    let tooMuch = 1_000_000;
    while (cost(tooMuch) <= budget) tooMuch *= 2;
    for (let lo = tooMuch / 2; tooMuch - lo > 1000; ) {
      const mid = Math.round((lo + tooMuch) / 2000) * 1000;
      if (cost(mid) > budget) tooMuch = mid; else lo = mid;
    }
    expect((await bid(alice(), id, tooMuch, 1, eng.guid)).error).toMatch(/Not enough budget/);
    expect((await bid(alice(), id, tooMuch - 1000, 1, eng.guid)).error).toBeNull();
    // Leading with that bid leaves no room for another.

    const other = state.freeAgents.filter((x) => x.kind === "Driver")[20];
    const other_id = (await openAuction(alice(), other.guid)).rows[0].id;
    const [driver] = staffOf("Garuda Racing", "Driver");
    expect((await bid(alice(), other_id, minWage(other, DEFAULT_SETTINGS), 1, driver.guid)).error).toMatch(/Not enough budget/);

    const row = (await alice().query<{ cost: string }>("select cost from bids where auction_id = $1", [id])).rows[0];
    expect(Number(row.cost)).toBe(cost(tooMuch - 1000));
  });

  it("takes HQ orders at MM's price with prerequisites, one per building", async () => {
    const tatra = state.teams.find((x) => x.name === "Tatra Racing")!;
    const b = (name: string) => tatra.hq.find((x) => x.name === name)!;
    const order = (who: ReturnType<typeof org>, type: number) => who.query<{ id: number }>("select public.order_hq($1) as id", [type]);
    const wind = b("Wind Tunnel");
    const { rows, error } = await order(org(), wind.type);
    expect(error).toBeNull();
    const row = (await org().query<{ cost: string; weeks: number; to_level: number }>("select cost, weeks, to_level from hq_orders where id = $1", [rows[0].id])).rows[0];
    const step = nextHqStep(wind)!;
    expect({ cost: Number(row.cost), weeks: row.weeks, to_level: row.to_level }).toEqual({ cost: step.cost, weeks: step.weeks, to_level: step.toLevel });

    expect((await order(org(), wind.type)).error).toMatch(/already has a queued order/);
    const busy = tatra.hq.find((x) => x.state === "Upgrading" || x.state === "BuildingInProgress")!;
    expect((await order(org(), busy.type)).error).toMatch(/under construction/);
    const blocked = tatra.hq.find((x) => x.state === "NotBuilt" && x.dependencies.some((d) => {
      const req = tatra.hq.find((y) => y.type === d.buildingType)!;
      return (req.state === "BuildingInProgress" ? 0 : req.level) < d.requiredLevel;
    }))!;
    expect((await order(org(), blocked.type)).error).toMatch(/needs .* level/);
    expect((await order(eve(), wind.type)).error).toMatch(/not in the league/);
  });

  it("lets a member order over a project the AI started after the league began", async () => {
    const tatra = state.teams.find((x) => x.name === "Tatra Racing")!;
    const busy = tatra.hq.find((x) => x.state === "BuildingInProgress")!;
    const order = () => org().query<{ id: number }>("select public.order_hq($1) as id", [busy.type]);
    // Started before the league (the base save's own project): it blocks.
    expect((await order()).error).toMatch(/under construction/);
    // Pretend the AI started it after the league began.
    const later = "2016-08-20T00:00:00.0000000";
    await t.service(`update team_snapshots set private = jsonb_set(private, '{hq}',
      (select jsonb_agg(case when (b ->> 'type')::int = ${busy.type} then jsonb_set(b, '{progressStart}', '"${later}"') else b end)
       from jsonb_array_elements(private -> 'hq') b)) where team = 'Tatra Racing'`);
    expect(unorderedProject({ ...busy, progressStart: later }, [], state.gameDate)).toBe(true);
    const { rows, error } = await order();
    expect(error).toBeNull();
    const o = (await org().query<{ to_level: number; cost: string }>("select to_level, cost from hq_orders where id = $1", [rows[0].id])).rows[0];
    expect({ to_level: o.to_level, cost: Number(o.cost) }).toEqual({ to_level: 1, cost: busy.initialCost });
    // Keep the e2e below consistent with the real save: withdraw it and restore the snapshot.
    expect((await org().query("select public.cancel_hq($1)", [rows[0].id])).error).toBeNull();
    await t.service(`update team_snapshots set private = jsonb_set(private, '{hq}',
      (select jsonb_agg(case when (b ->> 'type')::int = ${busy.type} then jsonb_set(b, '{progressStart}', to_jsonb($1::text)) else b end)
       from jsonb_array_elements(private -> 'hq') b)) where team = 'Tatra Racing'`, [busy.progressStart]);
  });

  it("keeps HQ orders private, cancellable, and inside the budget together with bids", async () => {
    const tatra = state.teams.find((x) => x.name === "Tatra Racing")!;
    const order = (type: number) => org().query<{ id: number }>("select public.order_hq($1) as id", [type]);
    const committed = async () => (await org().query<{ cost: string }>("select cost from hq_orders where status = 'queued'")).rows
      .reduce((sum, r) => sum + Number(r.cost), 0);
    // Affordable orders whose prerequisites are met, cheapest first, until one no longer fits.
    const open = tatra.hq.filter((x) => x.state !== "Upgrading" && x.state !== "BuildingInProgress" && x.name !== "Wind Tunnel" && nextHqStep(x)
      && x.dependencies.every((d) => { const r = tatra.hq.find((y) => y.type === d.buildingType)!; return (r.state === "BuildingInProgress" ? 0 : r.level) >= d.requiredLevel; }))
      .sort((a, b) => nextHqStep(a)!.cost - nextHqStep(b)!.cost);
    let refused: string | null = null;
    for (const x of open) {
      const fits = (await committed()) + nextHqStep(x)!.cost <= BUDGET;
      const { error } = await order(x.type);
      if (fits) expect(error).toBeNull();
      else { refused = error; break; }
    }
    expect(refused).toMatch(/Not enough budget/);

    const mine = (await org().query<{ id: number; cost: string }>("select id, cost from hq_orders where status = 'queued' order by cost desc")).rows;
    expect((await alice().query("select * from hq_orders")).rows).toEqual([]);
    expect((await alice().query("select public.cancel_hq($1)", [mine[0].id])).error).toMatch(/No queued order/);
    expect((await org().query("select public.cancel_hq($1)", [mine[0].id])).error).toBeNull();

    // A bid can't spend what queued HQ orders already commit.
    const left = BUDGET - (await committed());
    const p = state.freeAgents.filter((x) => x.kind === "Driver")[30];
    const id = (await openAuction(org(), p.guid)).rows[0].id;
    const [driver] = staffOf("Tatra Racing", "Driver");
    const tooMuch = Math.ceil(left / DEFAULT_SETTINGS.sign_on_fee_pct / 1000) * 1000 + 1000;
    expect((await bid(org(), id, tooMuch, 1, driver.guid)).error).toMatch(/HQ orders/);
  });

  it("refuses bids after the deadline", async () => {
    const p = state.freeAgents.filter((x) => x.kind === "Mechanic")[5];
    const id = (await openAuction(alice(), p.guid)).rows[0].id;
    expect((await org().query("select public.set_window_deadline(now() - interval '1 second')")).error).toBeNull();
    const [m] = staffOf("Garuda Racing", "Mechanic");
    expect((await bid(alice(), id, minWage(p, DEFAULT_SETTINGS), 1, m.guid)).error).toMatch(/closed/);
    expect((await openAuction(alice(), state.freeAgents[0].guid)).error).toMatch(/closed/);
  });

  it("turns the winners into save changes that apply to the real save", async () => {
    const q = async <T>(sql: string) => (await t.service<T>(sql)).rows;
    const [w] = await q<WindowRow>("select * from transfer_windows where status = 'open'");
    const auctions = await q<AuctionRow>(`select * from auctions where window_id = ${w.id} order by id`);
    const bids = await q<BidRow>("select id, auction_id, team, yearly_wage, years, replacing_guid, replacing_name, created_at::text from bids order by id");
    const orders = await q<HqOrderRow>("select * from hq_orders where status = 'queued' order by created_at");
    expect(orders.length).toBeGreaterThan(0);
    const changes = windowChanges(w.id, state.gameDate, auctions, bids, DEFAULT_SETTINGS);
    changes.changes.unshift(
      // As pull does: first undo unordered HQ projects on member teams (none in the base save).
      cancelUnorderedChange(["Tatra Racing", "Garuda Racing", "Octane Racing"], orders, state.gameDate),
      ...hqChanges(orders, 1),
    );
    const won = winners(auctions, bids, DEFAULT_SETTINGS);
    expect(won.map((x) => `${x.team}: ${x.person.name}`)).toHaveLength(4);

    const save = Save.load(SAVE);
    applyChanges(save, changes);
    save.prepareForWrite();
    expect(save.g.validate()).toEqual([]);
    const after = extractLeague(save, league);
    const team = (name: string) => after.teams.find((x) => x.name === name)!;
    const has = (name: string, guid: string) => team(name).staff.some((s) => s.person?.guid === guid);
    for (const x of won) {
      expect(has(x.team, x.person.guid)).toBe(true);
      const hired = team(x.team).staff.find((s) => s.person?.guid === x.person.guid)!.person!;
      expect(hired.contract.yearlyWages).toBe(x.wage);
      expect(hired.contract.end.slice(0, 4)).toBe(String(Number(state.gameDate.slice(0, 4)) + x.years - 1));
      if (x.fromTeam) {
        // Swap: the released person now drives for the AI team.
        const released = state.teams.find((tm) => tm.name === x.team)!.staff.find((s) => s.person?.guid === x.bid.replacing_guid)!.person!;
        expect(has(x.fromTeam, released.guid)).toBe(true);
      }
    }
    for (const o of orders) {
      const b = team(o.team).hq.find((x) => x.type === o.building_type)!;
      expect(b.state, o.building_name).toBe(o.to_level === 1 ? "BuildingInProgress" : "Upgrading");
    }
    const tatraBefore = state.teams.find((x) => x.name === "Tatra Racing")!.budget!;
    expect(team("Tatra Racing").budget).toBeCloseTo(tatraBefore - orders.filter((o) => o.team === "Tatra Racing").reduce((sum, o) => sum + Number(o.cost), 0), 0);
    const paid = (name: string) => won.filter((x) => x.team === name).reduce((sum, x) => sum + x.signOnFee + x.buyout, 0);
    for (const name of ["Garuda Racing", "Octane Racing"]) {
      const before = state.teams.find((x) => x.name === name)!.budget!;
      expect(team(name).budget).toBeCloseTo(before - paid(name), 0);
    }
  }, 120_000);
});
