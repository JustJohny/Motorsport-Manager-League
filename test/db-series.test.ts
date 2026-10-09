import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { extractLeague } from "../src/extract.ts";
import type { LeagueState } from "../src/league-types.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { leagueDb } from "./db.ts";

const SAVE = process.env.MM_TEST_SAVE ?? join(defaultSavesDir(), "SaveJonatan Sulik - Tatra Racing 2 (3).sav");
// The same save in two series: same team names, different members.
const open = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};
const endurance = {
  members: [
    { member: "alice", team: "Octane Racing", discord: "alice", organizer: true },
    { member: "carol", team: "Garuda Racing", discord: "carol" },
  ],
};

describe.skipIf(!existsSync(SAVE))("database: several series", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  let state: LeagueState;
  const publish = (cfg: typeof open, series: string, name: string) => {
    const s = extractLeague(save, cfg);
    return t.service("select public.publish_snapshot($1, $2, $3)", [JSON.stringify(memberRows(cfg, s)), JSON.stringify(splitSnapshot(s)), name], series);
  };
  let save: Save;
  const teams = async (who: string, series: string | null) =>
    (await t.member(who, series).query<{ team: string }>("select team from team_snapshots order by team")).rows.map((r) => r.team);

  beforeAll(async () => {
    save = Save.load(SAVE);
    state = extractLeague(save, open);
    t = await leagueDb();
    expect((await publish(open, "open", "Open-wheel league")).error).toBeNull();
    expect((await publish(endurance, "endurance", "Endurance league")).error).toBeNull();
    await t.db.query(`update league.team_snapshots set private = jsonb_set(private, '{budget}', '90000000')`);
  }, 120_000);

  it("lists each member's series and their team in each", async () => {
    expect((await t.member("alice", null).query("select * from public.my_series()")).rows).toEqual([
      { id: "open", name: "Open-wheel league", team: "Garuda Racing", role: "member" },
      { id: "endurance", name: "Endurance league", team: "Octane Racing", role: "organizer" },
    ]);
    expect((await t.member("bob", null).query("select id from public.my_series()")).rows).toEqual([{ id: "open" }]);
  });

  it("scopes every read to the series in the header", async () => {
    expect(await teams("alice", "open")).toEqual(["Garuda Racing"]);
    // An organizer in endurance sees every team there.
    expect((await teams("alice", "endurance")).length).toBe(state.teams.length);
    expect(await teams("bob", "endurance")).toEqual([]);
    expect(await teams("alice", null)).toEqual([]);
    expect((await t.member("alice", "open").query("select count(*)::int as n from snapshots")).rows).toEqual([{ n: 1 }]);
    // Realtime reads the tables without a header: only rows of the member's own series and team pass.
    const base = (await t.member("bob", null).query<{ series: string; team: string }>("select series, team from league.team_snapshots")).rows;
    expect(base).toEqual([{ series: "open", team: "Octane Racing" }]);
  });

  it("keeps orders and choices in their own series", async () => {
    const order = (series: string) => t.member("alice", series).query("select public.order_hq(0)");
    expect((await order("open")).error).toBeNull();
    expect((await t.member("alice", "open").query("select team from hq_orders")).rows).toEqual([{ team: "Garuda Racing" }]);
    expect((await t.member("alice", "endurance").query("select team from hq_orders")).rows).toEqual([]);
    // The same building can be ordered in the other series, for that series' team.
    expect((await order("endurance")).error).toBeNull();
    expect((await t.member("carol", "endurance").query("select team from hq_orders")).rows).toEqual([]);
    expect((await t.member("alice", "endurance").query("select team from hq_orders")).rows).toEqual([{ team: "Octane Racing" }]);
    // Not in a series: refused.
    expect((await t.member("bob", "endurance").query("select public.order_hq(0)")).error).toMatch(/not in the league/);
  });

  it("exports a series, and restores it after it was ended", async () => {
    const backup = (await t.service<{ b: any }>("select public.export_series() as b", [], "open")).rows[0].b;
    expect(backup.series).toMatchObject({ id: "open", name: "Open-wheel league" });
    expect(backup.tables.hq_orders).toHaveLength(1);
    expect(backup.tables.snapshots[0].series).toBeUndefined();
    // `mmsave archive` reads the same rows a page at a time.
    for (const [table, rows] of Object.entries(backup.tables) as [string, unknown[]][]) {
      const paged: unknown[] = [];
      for (let skip = 0; ; skip++) {
        const page = (await t.service<{ r: unknown[] }>("select public.export_series_rows($1, $2, 1) as r", [table, skip], "open")).rows[0].r;
        if (!page.length) break;
        paged.push(...page);
      }
      expect(paged, table).toEqual(rows);
    }
    expect((await t.service("select public.export_series_rows('series', 0, 1)", [], "open")).error).toMatch(/Not a series table/);
    expect((await t.service("select public.import_series($1)", [JSON.stringify(backup)], null)).error).toMatch(/already exists/);
    expect((await t.service("select public.end_series('open')", [], null)).error).toBeNull();
    expect((await t.service("select public.import_series($1)", [JSON.stringify(backup)], null)).error).toBeNull();
    const again = (await t.service<{ b: any }>("select public.export_series() as b", [], "open")).rows[0].b;
    expect(again.tables).toEqual(backup.tables);
    expect(await teams("alice", "open")).toEqual(["Garuda Racing"]);
    // New rows after a restore don't collide with restored ids.
    await t.db.query("insert into league.league_members values ('dave', 'dave', 'Tatra Racing', 'member', 'open')");
    expect((await t.member("dave", "open").query("select public.order_hq(0)")).error).toBeNull();
  });

  it("ends a series and everything in it, leaving the others", async () => {
    expect((await t.service("select public.end_series('open')", [], null)).error).toBeNull();
    for (const table of ["series", "league.league_members", "league.snapshots", "league.team_snapshots", "league.hq_orders", "league.league_settings"]) {
      const col = table === "series" ? "id" : "series";
      const rows = (await t.db.query<{ s: string }>(`select distinct ${col} as s from ${table === "series" ? "public.series" : table}`)).rows.map((r) => r.s);
      expect(rows, table).toEqual(["endurance"]);
    }
    expect((await t.member("alice", null).query("select id from public.my_series()")).rows).toEqual([{ id: "endurance" }]);
    expect((await t.service("select public.end_series('open')", [], null)).error).toMatch(/No series/);
  });
});

describe.skipIf(!existsSync(SAVE))("database: migrating to series", () => {
  it("puts the existing league in the series \"main\"", async () => {
    const state = extractLeague(Save.load(SAVE), open);
    const t = await leagueDb({ before: "013" });
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(open, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    await t.db.query(`update public.team_snapshots set private = jsonb_set(private, '{budget}', '90000000')`);
    expect((await t.member("alice").query("select public.order_hq(0)")).error).toBeNull();
    await t.migrate();
    expect((await t.db.query("select id, name from public.series")).rows).toEqual([{ id: "main", name: state.championship.name }]);
    const alice = t.member("alice", "main");
    expect((await alice.query("select team from hq_orders")).rows).toEqual([{ team: "Garuda Racing" }]);
    expect((await alice.query("select count(*)::int as n from snapshots")).rows).toEqual([{ n: 1 }]);
    expect((await alice.query("select sign_on_fee_pct from league_settings")).rows.length).toBe(1);
    expect((await t.member("alice", "other").query("select team from hq_orders")).rows).toEqual([]);
  }, 120_000);
});
