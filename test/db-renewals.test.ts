import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { applyChanges } from "../src/apply.ts";
import { extractLeague } from "../src/extract.ts";
import { Save } from "../src/model.ts";
import { defaultSavesDir } from "../src/paths.ts";
import { memberRows, splitSnapshot } from "../src/publish.ts";
import { renewalChanges, type RenewalRow } from "../src/renewal-orders.ts";
import { leagueDb } from "./db.ts";

const SAVE = join(defaultSavesDir(), "SaveLeague Test 10.sav");
const league = {
  members: [
    { member: "org", team: "Tatra Racing", discord: "org", organizer: true },
    { member: "alice", team: "Garuda Racing", discord: "alice" },
    { member: "bob", team: "Octane Racing", discord: "bob" },
  ],
};

const renewal = (guid: string, name: string, extra: Record<string, unknown> = {}) => ({
  guid, name, kind: "Driver", slotID: 0, wage: 1000000, end: "2016-12-31T00:00:00.0000000", monthsLeft: 3,
  askingWage: 1500000, signOnFee: 200000, preferredYears: 2, refusal: null, ...extra,
});

describe.skipIf(!existsSync(SAVE))("database: contract renewals", () => {
  let t: Awaited<ReturnType<typeof leagueDb>>;
  let save: Save;
  let real: ReturnType<typeof renewal>;
  const alice = () => t.member("alice"), bob = () => t.member("bob"), org = () => t.member("org");
  const rows = async (who = alice()) => (await who.query<RenewalRow>("select * from contract_renewals order by id")).rows;
  const setContracts = (team: string, contracts: unknown, budget: number) =>
    t.service(`update team_snapshots set private = jsonb_set(jsonb_set(private, '{contracts}', $1::jsonb), '{budget}', $2::jsonb) where team = $3`,
      [JSON.stringify(contracts), String(budget), team]);

  beforeAll(async () => {
    save = Save.load(SAVE);
    const state = extractLeague(save, league);
    t = await leagueDb();
    expect((await t.service("select public.publish_snapshot($1, $2)", [JSON.stringify(memberRows(league, state)), JSON.stringify(splitSnapshot(state))])).error).toBeNull();
    // A real Garuda driver, so the pulled change applies to the save; plus a refuser.
    const garuda = save.team("Garuda Racing");
    const slot = save.slots(garuda).find((s) => s.jobType === 0 && s.personHired)!;
    const p = save.g.deref<any>(slot.personHired);
    real = renewal(p.id, p.name, { end: save.contract(p).mEndDate, wage: Number(save.contract(p).yearlyWages) });
    await setContracts("Garuda Racing", { deadline: "2099-12-13T06:00:00.0000000", renewals: [real, renewal("no", "Grumpy Driver", { refusal: "Morale too low" })] }, 10_000_000);
    await setContracts("Octane Racing", { deadline: "2099-12-13T06:00:00.0000000", renewals: [renewal("poor", "Costly Driver", { signOnFee: 5_000_000 })] }, 100_000);
  }, 120_000);

  it("keeps renewal terms private", async () => {
    expect((await bob().query("select private -> 'contracts' from team_snapshots where team = 'Garuda Racing'")).rows).toEqual([]);
  });

  it("renews at MM's terms for 1..3 seasons, once per person", async () => {
    expect((await alice().query("select public.renew_contract($1, 4)", [real.guid])).error).toMatch(/1 to 3 seasons/);
    expect((await alice().query("select public.renew_contract($1, 2)", [real.guid])).error).toBeNull();
    expect((await alice().query("select public.renew_contract($1, 1)", [real.guid])).error).toMatch(/already renewed/);
    expect((await alice().query("select public.renew_contract('nobody', 1)")).error).toMatch(/isn't up for renewal/);
    const [r] = await rows();
    expect(r).toMatchObject({ team: "Garuda Racing", person_guid: real.guid, years: 2, status: "queued" });
    expect(Number(r.yearly_wage)).toBe(1500000);
    expect(Number(r.sign_on_fee)).toBe(200000);
    expect(r.new_end).toBe(`${Number(real.end.slice(0, 4)) + 2}-12-31T00:00:00.0000000`);
    // Rivals don't see it; the organizer does.
    expect(await rows(bob())).toEqual([]);
    expect((await rows(org())).length).toBe(1);
  });

  it("refuses people MM says won't talk, fees over budget, the career team, and after the deadline", async () => {
    expect((await alice().query("select public.renew_contract('no', 1)")).error).toMatch(/won't renew: Morale too low/);
    expect((await bob().query("select public.renew_contract('poor', 1)")).error).toMatch(/Not enough budget/);
    expect((await org().query("select public.renew_contract('x', 1)")).error).toMatch(/career team renews/);
    await setContracts("Octane Racing", { deadline: "2000-01-01T00:00:00.0000000", renewals: [renewal("poor", "Costly Driver", { signOnFee: 0 })] }, 100_000);
    expect((await bob().query("select public.renew_contract('poor', 1)")).error).toMatch(/pre-season began/);
  });

  it("cancels a queued renewal, and pull turns renewals into a renewed contract and the fee", async () => {
    expect((await alice().query("select public.renew_contract('no', 1)")).error).toBeTruthy();
    const [r] = await rows();
    const changes = renewalChanges([r]);
    expect(changes.map((c) => c.op)).toEqual(["renewContract", "adjustBudget"]);
    const budget = Number(save.finance(save.team("Garuda Racing")).currentBudget);
    applyChanges(save, { changes });
    const c = save.contract(save.person(real.guid));
    expect(c.mEndDate).toBe(r.new_end);
    expect(Number(c.yearlyWages)).toBe(1500000);
    expect(Number(save.finance(save.team("Garuda Racing")).currentBudget)).toBe(budget - 200000);

    expect((await alice().query("select public.cancel_renewal($1)", [r.id])).error).toBeNull();
    expect((await alice().query("select public.cancel_renewal($1)", [r.id])).error).toMatch(/No such queued renewal/);
    expect((await rows())[0].status).toBe("cancelled");
  });
});
