# Handoff: MM League Toolkit

_Last updated 2026-10-09 (engine programme calibrated for FF20; renewal refusals explained on the site, teammate-trait morale bug fixed; league pre-season built: free signings, line-up moves, this season's suppliers, migration 022 run; third-party mods: Enzoli 2016 liveries, sponsor decals, track movies and facepack ported into the staging mod, AI teams' real 2016 looks, Enhanced Graphics checked; promotions: member teams protected, AI teams move; game patch: player team retires at the start, verified in game; team identity: colours, livery and logo on the site, migration 019; pre-season saves checked; sponsors built; pit crews built; auction, HQ orders, part development, organizer race guide and grey-area parts live; regulations, engine programmes and illegal engines designed, not built). Read this first in a new session, then `README.md` and `docs/save-schema.md`._

## The goal
Run a **Motorsport Manager 1 (v1.53)** online league the way F1 Manager 24 community leagues run:
- Members manage their team on a **website** between races: bid on staff, upgrade HQ buildings, develop parts.
- The organizer (the user) exports those decisions into a **save file**, plays and streams the race in MM, and uploads the results back to the site.

MM1 has better management depth than F1M24 but almost no tooling, which is why this project exists.

## Decisions made with the user
- **Members take over existing AI teams** in one championship (currently the ERS in the test save). During races their teams run on MM's AI strategy, with the parts, staff and HQ the members chose, as in F1M24 leagues.
- **The site is the source of truth.** Between races the AI also changes member teams. The `syncTeam` op overwrites member teams' HQ, parts, staff and budget from the site state, and only results, finances and wear are imported back.
- **Stack:** TypeScript on Node 26 (the user had no preference), so the same save codec can later run in the website.
- **First prototype** (the user's pick): the save toolkit CLI. **It is done and verified in game.**
- **Website (decided 2026-09-30):**
  - Vite + React + TS + **shadcn/ui**, hosted on **GitHub Pages**.
  - **Supabase** backend, **Discord** login.
  - `mmsave publish` uploads the data, and a later `mmsave pull` will download decisions as `changes.json`.
  - Game rules for later phases:
    - Staff market: a **live auction with a fixed window**. Bids are open, and all auctions close at one deadline before the race.
    - Parts: a **formula from team assets**, i.e. best part + a gain from Design Centre level and lead engineer stats + a small random roll.
    - HQ upgrades take **N race weekends**.
  - Build order: **read-only site first**, then auction, then HQ, then parts.
  - Rival teams' budget, HQ and parts are private, as in game. Staff line-ups are public.

## Current status: toolkit works end-to-end in game ✅
Verified by the user in MM on 2026-09-30:
1. A tool-edited save loads.
2. On the player's own team, Tatra Racing, these all show correctly:
   - HQ level (Wind Tunnel 1, Scouting Facility 2)
   - the budget ($50M), with a transaction note
   - a new front wing with stat 60, fitted to a car
   - the new lead engineer and mechanic
3. On AI teams, staff and driver changes show. MM's UI doesn't show rival HQ, parts or budget at all.
4. **Full cycle:** practice → qualifying → race → advance to next weekend. Everything persisted through MM's own saves ("League Test 3" and "League Test 4"). `mmsave diff` showed the game only changed normal gameplay state.

20 automated tests pass (`npm test`).

### Game crashes found and fixed (all in `src/ops/staff.ts` / `src/graph.ts` / `src/schema.ts`)
1. **"Save failed to load"** (`failed to convert parameters`).
   - Cause: FullSerializer writes `$type` only when the runtime type differs from the field's declared type, and moving object definitions broke that.
   - Fix: `schema/mm-1.53.json` (generated from `Assembly-CSharp.dll` by `tools/gen-schema.ts`) plus `Types.annotate()` before every write.
2. **Crash at practice start.**
   - Cause: a hired mechanic had no `mDictDriversRelationships` entries.
   - Fix: create zeroed entries for every mechanic × driver.
3. **Crash when qualifying ended.**
   - Cause: a hired free agent had an empty `careerHistory`.
   - Fix: open a career entry on hire and close it on release.
4. **Preventive:** contract-end calendar events are now created on hire and removed on release. Objects referenced for the first time get an `$id` (`Graph.ref`).

## Website v1 (read only): built, not yet deployed
- `site/`: Vite + React + shadcn. Pages: My team (staff / HQ / parts, and the organizer can pick any team), Standings, Calendar & results, Teams, Staff market, Organizer. Dark by default, with a light toggle.
- `src/league-types.ts`: import-free data shapes, shared by the toolkit and the site. `extract.ts` is annotated against them.
- `src/publish.ts` + `mmsave publish`: split into public and private data, then upload through the `publish_snapshot` RPC with the service key from `.env`.
- `supabase/migrations/001_init.sql`: tables, RLS and functions.
  - RLS was checked in PGlite with stubbed `auth` (scratch script, not in the repo). Only the service role can publish, members see only their own team's private data, the organizer sees all, and non-members see nothing.
  - **Verified with real Supabase and Discord (2026-09-30):** `current_discord_username()` gets the **@ handle** from `user_metadata.name` (the user's handle is `codecoffe`; their display name `JustJohny` is in `custom_claims.global_name`). `league.json` needs the handle, not the display name.
- The real league config is `league.json` in the repo root. It is **gitignored** because the repo is public and it holds Discord handles. `examples/league.json` holds placeholders.
- `publish` uploads over HTTP/1.1 (`node:https`). Node 26's `fetch` used HTTP/2, and large uploads to Supabase failed intermittently on the user's connection with "bad record mac" or `ERR_HTTP2_INVALID_SESSION`.
- **Demo mode:** without `VITE_SUPABASE_*` the site loads `site/public/demo-state.json` (a gitignored extract). It was verified by screenshots of every page, with no console errors.
- `.github/workflows/pages.yml`: builds `site/` on push to master/main, with `BASE_PATH=/<repo>/`.

### One-time setup the user still has to do
1. **Supabase:** create a project, then run `supabase/migrations/001_init.sql` in the SQL editor. Copy the URL, publishable (anon) key and secret key.
2. **Discord:** create an app at discord.com/developers → OAuth2. Add the redirect `https://<project>.supabase.co/auth/v1/callback`. In Supabase → Authentication → Providers → Discord, paste the client ID and secret.
3. **Supabase Auth URL config:** Site URL `https://<user>.github.io/<repo>/`. Also add `http://localhost:5173/` to the redirect URLs for dev.
4. **GitHub:** create the repo and push. It must be public for free Pages. Set Pages source to "GitHub Actions". Add secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. **Locally:** copy `.env.example` to `.env` with the secret key. Add `discord` @handles to `league.json`, then run `mmsave publish "<save>" --league league.json`.

Steps 1–5 are done: Supabase is set up, Pages is deployed, and snapshots are published. Remaining: confirm the user's login lands on Tatra Racing, and test with a second Discord account.

## Phase 2: staff auction, live and verified in game
**Rules agreed with the user:**
- A bid is a yearly wage plus a 25% sign-on fee.
- The opening price comes from a stats formula.
- Members can bid on free agents and on AI teams' staff. AI staff cost a buyout and swap with the released person.
- The bidder names who is replaced.
- Each bid beats the leader by at least 5%.
- Contracts run 1–3 seasons, chosen by the bidder.
- The budget must cover fees, buyouts and the rest of this season's extra wages.
- There is one fixed-deadline window at a time.

**Where it lives:**
- `supabase/migrations/002_auctions.sql`: `league_settings` (tunable), `transfer_windows`, `auctions` (the leader is stored on the row, so realtime works under RLS), and `bids`. The latter is private: only the own team and the organizer see it. The public `bid_history` view leaves out who is replaced. RPCs: `open_window`, `set_window_deadline`, `open_auction`, `place_bid`.
- `src/league-rules.ts`: the same price and cost formulas for the site. `test/db.test.ts` checks that both agree.
- `src/transfers.ts` + `mmsave pull`: winners → `hire` (with `yearlyWages` and `endDate`) + `adjustBudget` (fee, buyout).
- Site: `/transfers` page, market nominate button, AI-staff tab, bid dialog with a cost breakdown, organizer window controls. Demo mode simulates auctions in memory (`site/src/lib/demo-transfers.ts`).
- Tests: `test/db.ts` runs every migration in PGlite with a stubbed Supabase `auth` schema. `test/db.test.ts` covers the RLS and every auction rule, then pull → apply on the real base save.

**A toolkit bug found and fixed along the way:** a `hire` swap with a rival team corrupted the other team's seats. See docs/save-schema.md, hiring pitfalls. It never happened in game, because swaps hadn't been played yet.

**To go live:** run `002_auctions.sql` in the Supabase SQL editor, then commit and push (Pages redeploys). Open a window on the Organizer page.

**Organizer loop:**
1. `mmsave publish` (between races).
2. Open a window; members bid.
3. After the deadline, `mmsave pull -o changes.json --mark-applied`, then `mmsave apply "<save>" changes.json -o "<saves>/SaveLeague Test N.sav" --name …`.
4. Play the race, then publish again.

**Verified in game (2026-09-30, "League Test 5"):** window #1 was pulled and applied. Tatra signed Björn Daouadji (free-agent engineer) and Sergio Arbeloa, bought out from Eastwood, with André Zoom swapped to Eastwood. The user reports it all works in game.

**Nominating = the opening bid (user's UX request, 2026-10-01):**
- The market's "Nominate with an opening bid" button opens the same `BidDialog` (with `person` instead of `auction`).
- It calls the `nominate` RPC (`supabase/migrations/006_nominate.sql`), which runs `open_auction` + `place_bid` in one transaction, so a refused bid leaves no empty auction. Nominating someone already in auction becomes a normal bid.
- Test: `test/db-nominate.test.ts`. Migration 006 was run on Supabase, and the user verified it live (2026-10-01).

**Transfer window page:** it shows auctions only while bidding runs. After the deadline it's cleared, and the results move to the History tab (every window, "Awaiting organizer" until `pull --mark-applied`). Bidding closes on a timer set to the exact deadline, not on a polling clock.

## Phase 3: HQ orders, live and verified in game
**Rules agreed with the user:**
- The game builds it, at MM's real times. The user chose this after learning the times are 20–116 weeks, i.e. multi-season projects. `league_settings.hq_speed` (default 1) can scale them.
- Full MM price paid upfront.
- Unlimited parallel projects.
- Orders any time between races.

**Where it lives:**
- `startBuilding` op (`src/ops/hq.ts`, see docs/save-schema.md "HQ construction").
- `supabase/migrations/003_hq_orders.sql`: `hq_orders` (private), `order_hq` (price, weeks, prerequisites, one per building, budget together with leading bids), `cancel_hq`. `place_bid` also counts queued HQ orders now.
- `src/hq-orders.ts` + `pull`: orders → `startBuilding` + `adjustBudget`. `pull` now collects HQ orders and, once past the deadline, the transfer window, and no longer fails when there's no window.
- Site: HQ tab with an Order/Cancel column, a budget strip (budget − HQ orders − leading bids), and completion dates. The bid dialog also counts HQ orders.
- Extract: buildings now carry `buildWeeks` and `upgradeWeeks`, so **publish again** after deploying. Older snapshots lack them: the HQ tab used to crash to a black page (fixed 2026-10-01, such buildings just aren't orderable; the site also has an error boundary now).

**AI projects on member teams (the user's decision: cancel and refund):**
- `pull` always emits `cancelUnorderedHq` first, with member teams, keep = applied and queued orders, and since = the first published game date.
- `cancelBuilding` reverts the building and refunds MM's price; the AI pays upfront.
- Migration 004: `order_hq` accepts a building with an AI project on it (`unordered_project`), and `league_start()`.
- The site marks such projects "AI project · cancelled at next apply".
- Projects older than the league are kept.

**Verified in game (2026-10-01, "League Test 6"):** a Design Centre ordered on the site was pulled and applied, the save loads, and MM shows it as just begun construction.

**Also verified in game (2026-10-01):** the build progresses over days. A construction started by hand in MM ("League Test 7", standing in for an AI project) showed on the site as "AI project · cancelled at next apply", and after pull + apply ("League Test 8") it was reverted and refunded, while the ordered Design Centre kept building. Not yet seen: a build reaching completion (20+ weeks).

## Real 2016 F1 names (2026-10-01)
- `renamePerson` op (`src/ops/people.ts`): by team + slotID, it sets the name and optionally nationality, birth date and gender. See docs/save-schema.md, "Person names".
- `examples/f1-2016-names.json` renames all 11 WMC teams in "SaveF1 League R1 Pre" (SPEC Racing, the user's spectator team, is left as is). It was applied to "SaveF1 League R1 2016" ("F1 League R1 2016" in MM's load menu). **Not yet loaded in game.**
- Mapping: Steinmann = Mercedes, Rossini = Ferrari, Panther = Red Bull, Windsor = Williams, Kitano = McLaren, Van Dort = Force India, Rezzato = Toro Rosso, Thornton = Renault, Vélan = Sauber, Asia Road Racing = Haas, Cortossi = Manor.
- **Team names, countries and engines (2026-10-02):** `examples/f1-2016-teams.json`, applied to "SaveF1 League R1 2016" → `SaveF1 League R1 2016 Teams.sav` ("F1 League R1 2016 Teams"). **Not yet loaded in game.**
  - `renameTeam` (`src/ops/team.ts`): `name` + `mShortName`, e.g. "Scuderia Ferrari" / "Ferrari".
  - `setTeamCountry`: licence flag (`nationality`) and HQ country (`locationID`), e.g. Red Bull = Austria / UK, Force India = India / UK, Haas = United States.
  - `renameSupplier` (`src/ops/suppliers.ts`): every tier copy of a supplier, optional 50% works discount. Steinmann = Mercedes, Rossini = Ferrari, Kitano = Honda, Mersault = Renault (works discount for Renault), Hammer = "Ferrari 2015" (the user's pick for the fifth make).
  - `setCurrentSupplier`: swaps the supplier on this season's cars and shifts chassis stats by the supplier-stat difference. Engine parts keep their stats (MM adds the engine level modifier only in `NextYearCarDesign.DesignCompleted`), and no money moves (this career has no supplier payments; MM charges at next year's design start). 2016 deals: Mercedes → Mercedes, Williams, Force India, Manor; Ferrari → Ferrari, Sauber, Haas; Honda → McLaren; Renault → Renault, Red Bull; Ferrari 2015 → Toro Rosso (and SPEC Racing, unchanged).
  - Engine logos (`logoIndex`) are still MM's fictional ones. Next season MM's AI picks engines again.
- **Feeder series and free agents (2026-10-02, user's choices):** `examples/f1-2016-feeder.json`, applied to "F1 League R1 2016 Teams" → `SaveF1 League R1 2016 Full.sav` ("F1 League R1 2016 Full"). **Not yet loaded in game.**
  - Asia-Pacific Super Cup = 2016 GP2 (11 real teams + Status Grand Prix). European Racing Series = the 7 GP3 teams + 5 European F3 teams. Junior copies of GP2 teams get a suffix ("ART Grand Prix GP3", "DAMS GP3", "Trident GP3", "Arden GP3", "Carlin F3") so names stay unique.
  - Real teams were matched to MM teams by strength (two best drivers + lead designer), and each team's best 2016 driver takes its stronger race seat. Seats whose real driver is already a WMC reserve (Gasly, Lynn, Marciello, King, Ferrucci) went to 2016 part-timers and 2015 GP2 drivers.
  - Staff: only publicly known team principals (13); other staff keep MM's names. Free agents: 89 real 2016 drivers (ex-F1, IndyCar, WEC, FE, Formula V8 3.5, juniors, women racing in 2016) and 15 engineers without a 2016 F1 job, each on the MM free agent closest in age (same gender first; a few change gender). Free-agent mechanics keep MM's names.
  - Birth dates come from Wikidata (checked by occupation); people with no reliable date keep MM's.
  - Charles Leclerc, Stefano Coletti and Stéphane Richelmi are Monégasque: the save had no Monaco, so `renamePerson` now adds countries from MM's own list (see docs/save-schema.md, "Person names").
- **"2016 Full" is the wrong base (2026-10-03).** The rename chain started from a "Pre" saved 2026-10-01, but the user re-saved "Pre" in game on 2026-10-02 (it kept full team names, countries and engine deals, but not short names or engine maker names), and the equalized "Pre (league) (league)" ($42M budgets, higher HQ) was built from that. "Full" therefore had the old budgets and HQ, and a member's queued design no longer fit its Design Centre slots, which crashed the site's parts tab ("No free slot for level 2 component 35"). **Fixed:** `SaveF1 League R1 2016 League.sav` ("F1 League R1 2016 League") = "Pre (league) (league)" + WMC short names + engine maker names (Renault works discount → Kubica GrandPrix, team 7) + `examples/f1-2016-feeder.json`. Budgets and design slots match the league save. The parts tab now shows a warning on a queued design that no longer fits instead of crashing.
- **Week-skip crash (2026-10-04):** "2016 League (league)" crashed on the first day skip in `Mechanic.IncreaseDriverRelationships`. The feeder renames of two free agents sharing a name with GT drivers had also renamed those GT drivers' mechanic keys (see docs/save-schema.md, "Namesakes"). `renamePerson` is fixed. The repaired copy is `SaveF1 League R1 2016 League Fixed.sav` ("F1 League R1 2016 League Fixed"), with the two keys put back. "Full", "League" and "Pre Full" still carry the bug. **Not yet loaded in game.**
- **Practice crash (2026-10-04):** "F1 R1 2016 Pre" crashed entering practice in Doha: every circuit in the F1 career has blank session start times (an older save format; see docs/save-schema.md, "Circuits from an older save format"). New op `repairCircuits`. Repaired copies: `SaveF1 R1 2016 Pre Circuits.sav` and `SaveF1 League R1 2016 League Fixed Circuits.sav`. **Not yet loaded in game.** Every later F1 save made from the unrepaired files needs `repairCircuits` too.
- **Other empty fields (2026-10-04):** a field-by-field comparison with healthy 1.53 saves found three more gaps in the F1 career: championships without banned locations, race counts (6–20) and GT promotions, and an AI driver level preference of 0 (MM's default is 8; it makes the player's part designs about 25 % stronger). New op `repairOldFormat` (runs `repairCircuits` too; `examples/repair-old-format.json`). Repaired copies: `SaveF1 R1 2016 Pre Repaired.sav` and `SaveF1 League R1 2016 League Fixed Repaired.sav` (from the "Circuits" copies). **Not yet loaded in game.** Use `repairOldFormat` instead of `repairCircuits` on any older F1 save.
- **Engine shown on the site (2026-10-02):** the extract adds a public `engine` (this season's supplier name and stats) to every team. The Teams page lists it on each card, and the team page has an "Engine" stat with the supplier's stats. Read only. Needs a new `publish` to appear.

## How to work with it
```sh
npm test                                   # codec round-trip on all saves + operation tests
npx tsx src/cli.ts                         # usage
npx tsx src/cli.ts teams "<save name>"
npx tsx src/cli.ts extract "<save>" --league examples/league.json -o out/state.json
npx tsx src/cli.ts apply "<save>" changes.json -o "<saves dir>/SaveLeague Test 5.sav" --name "League Test 5"
npx tsx src/cli.ts diff "<a>" "<b>" --team "Tatra Racing"
npx tsx src/cli.ts validate "<save>"
```
- **Saves dir (Wine):** `~/.wine/drive_c/users/justjohny/AppData/LocalLow/Playsport Games/Motorsport Manager/Cloud/Saves/`. A bare save name (without `.sav`) is looked up there.
- **The name in MM's load menu** comes from the header (`--name`), not the file name. Files must be named `Save*.sav`.
- **Game install:** `~/Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/`.
- **Crash log:** `MM_Data/output_log.txt` in that folder. Always read it when the user reports a failure; it gives the exact C# method.
- To reverse-engineer game code: `monodis "<game>/MM_Data/Managed/Assembly-CSharp.dll" > asm.il`, then grep for `end of method Class::Method`. Mono is installed.
- To see what the game does for an action: copy a save, do one thing in game, save, then `mmsave diff before after --team X`.

### Test saves in the saves folder
| Save (load-menu name) | What it is |
|---|---|
| `SaveJonatan Sulik - Tatra Racing 2 (3).sav` | **Base test save**: ERS round 6 (Munich), made during the race weekend. The user's career team is Tatra Racing (teamID 27). |
| `SaveLeague Test.sav` ("League Test") | Base + `examples/changes.example.json`: Garuda/Octane AI-team edits, including **driver hires and a driver swap. Not yet played through a race.** |
| `SaveLeague Test 2.sav` ("League Test 2") | Base + `examples/changes.player-team-test.json` (Tatra edits). Verified. |
| `SaveLeague Test 3.sav` / `4.sav` | Made by the game after playing Test 2: after the race / at the next weekend. |

## Code map
- `src/codec/lz4.ts`, `src/codec/sav.ts`: the `mm2s` container, LZ4 blocks, and **lossless** FullSerializer JSON (float text, NaN/Infinity, `\uXXXX` escaping in values but not keys). Round-trips byte-identically.
- `src/graph.ts`: the `$id`/`$ref` graph (`deref`, `list`, `ref`, `clone`, `normalizeRefOrder`, `validate`).
- `src/schema.ts` + `schema/mm-1.53.json`: declared C# types, runtime-type tracking, and `$type` annotation.
- `src/model.ts`: the `Save` class and navigation (teams, slots, buildings, parts, people, contracts). `Save.write()` normalizes, annotates, validates, then writes.
- `src/extract.ts`: site-ready league JSON (teams, HQ, parts, staff, free agents, calendar, standings, last race).
- `src/ops/*.ts`: `setBuilding`, `setBudget`, `addPart`/`fitPart`/`removePart`, `hire` (free agent, or a swap between teams), `syncTeam`. Dispatched by `src/apply.ts`.
- `src/cli.ts`: the `mmsave` CLI.
- `src/league-types.ts`, `src/publish.ts`: the website data shapes and the publish/split code.
- `site/`: the website (see `site/README.md`). `supabase/`: the database migration.
- `docs/save-schema.md`: **all save-format findings, pitfalls and open questions. Keep it updated.**

## Known gaps / not yet verified in game
- Driver signings, driver swaps between teams, and edits to AI teams, through a full race (use the "League Test" save).
- `syncTeam` and `removePart` (no in-game test yet).
- Starting from a save made between race weekends (all tests so far used a save made during a race weekend).
- Part semantics: whether the +5 `mPerformance` shows in the UI, and how `level` maps to design tiers. Part names never show in the UI, so the site should identify parts by GUID.
- Contract money (sign-on fees, buyouts) isn't simulated. The site or league rules must handle it (e.g. via `setBudget`).
- HQ upgrades are applied instantly, bypassing build time and cost. The site should model time and cost itself. `setBuilding` warns on unmet prerequisites.

## Next steps
1. **Phase 3 (done):** only left to see a toolkit-started build complete in game, which happens naturally as the league plays on.
2. **Phase 2 (done):** test with a second real member.
   - **Auction tuning, agreed 2026-10-01 (migration `007_auction_tuning.sql`, run on Supabase and checked by the user the same day):**
     - The buyout is MM's `ContractPerson.GetContractTerminationCost`: the months of wage left, clamped to 1..6. It was the whole rest of the contract (Tanvir Jha: $18.2M → $4.1M).
     - AI staff open at no less than their current wage.
     - The formula's bases are recalibrated to the median AI wage per skill in the ERS: Driver $2.24M, Engineer $0.74M, Mechanic $0.37M (were 1.5M / 0.25M / 0.3M).
     - Test: every AI staff member's price matches between SQL and `src/league-rules.ts`.
3. **Phase 4: part development (done, verified by the user 2026-10-01: the site works and the applied save reflects the changes in game).** Rules agreed with the user (2026-10-01), replacing the earlier "formula from team assets" idea:
   - **The game builds it**, like HQ: the site sends the design, the toolkit starts it in MM, and MM finishes it with its own stats and time.
   - **Components from MM's real list**, per part type, with MM's unlock rules (Design Centre level, designer).
   - **Parts the AI designs on member teams are cancelled and refunded**, as with HQ projects.
   - **Members choose fitting** (which part goes on car 1 and car 2).
   - **One design at a time per team, as in MM.** MM has a single design slot per team, so the earlier "one per part type" choice was dropped (2026-10-01).
   - **Two cars: like MM.** One part per design; a second copy only comes from a lead-engineer component with `BonusCreateTwoParts`. This replaces the earlier "both cars in one order" choice, which MM doesn't support.
   - **Paid upfront at the player price** (full `materialsCost` + components, not the AI's 10 %), with money reserved on order and paid at apply, as with HQ.
   - **Two checkpoints per race cycle** (the user's plan, as in vanilla MM, where you fit new parts before the next race):
     1. After the race: publish, members act, then pull + apply. The organizer advances in MM to just before the next race, and parts get built.
     2. Before the race: publish again, members act, then pull + apply, then the race is played.
     - Members can do **everything** at both checkpoints: designs, fitting, HQ and bids. Orders placed before the race start at that apply.
     - **No fitting submitted = keep their last fitting.** The AI refits while the organizer advances, so every pull re-emits each member team's stored fitting. New parts stay in inventory.
   - **Part improvement chosen by members:** as in vanilla MM, the parts to improve for performance and for reliability, with **MM's slot count: 2/4/6/8 per list for Factory level 0–3**. Any inventory part qualifies. Members also set the **mechanics split slider**. Like fitting, the last choice is kept and re-emitted on every pull, so the AI's picks never last.
   - **Step 1 (toolkit) built 2026-10-01:**
     - `src/part-design.ts`: pure slot, cost and time rules, shared with the site later.
     - `src/ops/design.ts`: `startDesign`, `cancelDesign`, `cancelUnorderedDesigns`, `setImprovement`, plus `designOptions` / `previewDesign`.
     - Tests: our time matches every running AI design in the save, and our cost matches their transactions. MM's transaction amounts are rounded to thousands.
     - **In-game test save "League Test 9"** (from LT8, `out/design-test.json`):
       - Tatra designs a level-3 Front Wing (components 200, 67, 20, 14), using the engineer's "Take No Time" component with its extra slot; $1.22M, done 2016-10-07.
       - Garuda's AI Front Wing design is cancelled and refunded, and a league Brakes design is started, done 2016-10-06.
       - Tatra improves performance on F-LEAGUE.
     - **Verified in game (2026-10-01, "League Test 10"):** the user reports that it all works. Garuda's league Brakes design (B-ZWEM, components 10+25, level 2) was built on 2016-10-06 as planned, and the AI fitted it straight away. The cancelled AI design was gone. Tatra's wing was still designing in that save (due 10-07); the user saw it in game.
   - **Step 2 (extract) built 2026-10-01:**
     - Each team's private data now has `design` (`TeamDesign` in `src/league-types.ts`):
       - per part type, MM's design context (slots, settings, Design Centre, player flag), the components it can choose now, the open level and what unlocks the next ones
       - the current design (type, components, start, end)
       - improvement (lists, split, Factory slots, mechanics)
     - Parts carry `componentIds`. That's about 14 KB per team, private only.
     - **Component names:** MM has none. A component's text ID is its stats summary (`Modding`-less game: localisation CSVs live in `resources.assets`, and the component DB rows are `PSG_2000xxxx,"<b>Performance:</b> +15",...`). The site shows the summary, as MM does.
   - **Step 3 (database + pull) built 2026-10-01. Migration `005_parts.sql` was run on Supabase by the user the same day.**
     - `design_orders`: one queued per team.
       - `order_design` checks the team's own components and MM's slot rules, and prices it in SQL (`design_cost`, the same formula as `planDesign`; a test checks they agree).
       - It refuses while the team's design runs (unless the AI started it after the league began, see `unordered_design`) or was applied after the latest publish.
       - Budget counts HQ orders and leading bids: `hq_committed` now includes queued designs, so `order_hq` and `place_bid` count them too.
     - `part_fitting` (team, car, type → guid) and `part_improvement` (lists + split) are standing choices.
       - `set_fitting` won't take a part off the other car unless that car gets another.
       - `set_improvement` caps the lists at the Factory slot count.
     - `src/part-orders.ts` + `pull`: undo the AI (cancel designs, remove AI-built parts), then HQ, designs, `setFitting` and `setImprovement` for every member, then transfers.
     - Tests: `test/db-parts.test.ts`.
     - Careful: the next real `pull` also removes parts the AI built on member teams since the league start. Tatra's test wing from "League Test 9" was started by the toolkit, not ordered on the site, so it counts as unordered too.
   - **Step 4 (site) built 2026-10-01:** `site/src/components/parts-tab.tsx` + `site/src/lib/parts.tsx` (provider, realtime, demo mode).
     - Design card:
       - the running design (or "AI design · cancelled at next apply")
       - the queued order with Cancel
       - the designer: part type tabs, the team's components by level with what unlocks the locked levels, slots that fill live (bonus slots too), and live level, boosts, time and cost from `planDesign`
     - Improvement card: list counts against Factory slots, and the mechanics slider (locked when only one list has parts, as MM does).
     - Part tables: Car 1/2 fitting buttons (never strips the other car), P/R improvement toggles (disabled at max or when the list is full), and an "AI-built · removed at next apply" marker.
     - The budget strip, HQ strip and bid dialog count the queued design.
     - Checked in demo mode with headless Chromium: designer, order, fitting, improvement, phone width; no console errors.
     - **Spec parts shown, greyed out (user request 2026-10-01):** `TeamDesign.specParts` lists them. The designer shows every part type in MM's order, with spec ones disabled, marked "Spec", and a note. The part tables mark them too, with improvement disabled. Republish to get `specParts` (older snapshots just hide spec types).
     - **Spec parts:** `championship.rules.specParts` (ERS: Engine 1, Gearbox 3) can't be designed in MM. They're excluded from the design options and refused by `startDesign`.
     - **User feedback round 1 (2026-10-01), fixed:**
       - Engineer components of a level the facility doesn't unlock were selectable. They're no longer offered: their own level must be open, like every other component of that tier.
       - Locked tiers show a lock and the building they need, and components that can't fit a free slot are greyed out.
       - The designer shows the starting point (MM's `SetBaseStats`) next to the estimated new part (`predictPart`). Performance and max performance match MM's own design parts exactly; max reliability is within MM's ±10 % roll.
       - The Parts tab is split into the sub-tabs "Design a new part" and "Your parts: fitting & improvement", so the mechanics slider can't be mistaken for part of the design.
       - Lucide icons throughout (the user wants game-like icons, never emoji): part types, stats, tier stars in rarity colours (Basic to Legendary), component summary lines, slots, cost and time.
     - **Live and verified (2026-10-01):** the user published, used the Parts tab, then pulled and applied. The save reflects the changes in game.
     - Still to see in a real league cycle: the two-checkpoint rhythm (order, pull, apply, advance, publish, fit, pull, apply, race), and AI-built parts being removed on a member team.
     - **AI-finished parts on member teams: remove and refund** (user's decision). `removeUnorderedParts` does this: parts built after the league start whose components don't match an ordered design. A fitted one is replaced by the best spare first, and one refund is made per design.
   - MM internals: see docs/save-schema.md, "Part design and improvement". MM components have no names; the site shows MM's summary text, as the game does.
4. **Organizer checklist: done and verified live by the user, on the site's Organizer page** (`site/src/components/race-cycle.tsx`, 2026-10-01; the user preferred it on the site over a Markdown file).
   - The current checkpoint comes from the published game date: on or after the day before the next race's date is B (before race), anything earlier is A (after the last race).
   - Saves are named `League R<n> Post` / `League R<n+1> Pre`, filled in from the calendar, with copyable publish / pull / apply commands.
   - It also shows what's waiting for the next pull (queued designs, HQ orders, transfer window) and has collapsible rules and troubleshooting.
5. Before the league starts for real: test with a second real Discord account, and play one full race cycle with the Organizer page's guide (the first real `pull` against AI-built parts on a member team). Auction tuning is done (migration 007), and the placeholder members are gone from `league.json`.
6. **Backlog of designed features, in the suggested build order** (the user's idea list is complete as of 2026-10-01):
   1. **Season regulations and politics.** It's useful every season, including the ERS one.
   2. **Works engine programmes.** Site and database built. The season-change step waits for a pre-season save.
   2b. **Next season's suppliers on the site.** Built (toolkit, DB, site, organizer guide). Left: publish, and test at season end / pre-season in game; member engines as options come with the engine season step.
   3. **Illegal engine tech.** Builds on 2.

## Series: several saves on one site, and ending a league (built 2026-10-01; migration 013 run, league-main.json set up and publish/pull run by the user the same day)
**The user's decisions (2026-10-01):**
- Switching or ending a league = **archive, then wipe**: a full JSON backup, then everything of that league deleted from the site.
- Several series at once (e.g. open-wheel + endurance, one save each) = **one site with a series switcher**; one Discord account can run a team in each.
- Series are **fully independent**: only member accounts are shared.

**How it works:**
- Migration `013_series.sql`:
  - The 21 league tables move to the schema `league` and get a `series` column (default `public.current_series()`, FK to `public.series` with cascade).
  - `public.<table>` is now a view `where series = current_series()` (security_invoker, local check option). So every existing function and site query works unchanged, scoped to one series.
  - `current_series()` reads the `x-series` request header, or `app.series`.
  - Keys and unique indexes include `series`, since team names repeat across saves (e.g. two ERS careers).
  - RLS on the tables checks the row's own series (`in_series`, `own_or_organizer`), so realtime, which has no headers, is per series too.
  - The five functions that upserted `on conflict on constraint` now insert into `league.<table>` with the series: through a view, a constraint can't be named.
  - `bid_history` reads `league.bids` directly; through the invoker view it would apply the member's own row rules.
  - New functions: `publish_snapshot(members, snapshot, series_name)` (creates the series and its `league_settings` row), `my_series()` for the switcher, `export_series()`, `import_series(backup, as_id)`, `end_series(id)`.
  - Existing data becomes the series `main`.
- Toolkit:
  - The league file has `"series": {"id", "name"}`. `SupabaseEnv.series` sends `x-series` on every REST call.
  - `pull` now needs `--league`. New `archive --league f [-o file] [--end]` and `restore backup.json [--as id]`.
  - The backup is written and read back before `--end` deletes anything.
  - A restore keeps row ids, so it only works once the original is gone.
- Site:
  - `setSeries` plus a fetch wrapper adds `x-series`. `watchTable` subscribes to `league.<table>` filtered by `series=eq.<id>`.
  - `my_series` loads the series list; the last one used is kept in localStorage.
  - The sidebar header is the series switcher. The "nothing published yet" screen links to the member's other series.
  - Organizer page: per-series file names (`league-<id>.json`, `changes-<id>.json`, save prefix = series name, "League" for `main`), and a Series card (start another, archive, end, restore).
- Tests: `test/db-series.test.ts`:
  - two series with the same teams
  - a member in both
  - header scoping, and realtime-style reads without a header
  - orders per series
  - export, end, restore round trip
  - ending one series leaves the other
  - migrating existing data to `main`
  The test harness (`test/db.ts`) sends a series header (default `test`).
- **Verified live by the user (2026-10-01):** the site works on the deployed build with series `main`: the `x-series` header gets through, and live updates work on the `league` schema.

**Steps for the user:**
1. Run migration 013.
2. Rename `league.json` to `league-main.json` and add `"series": {"id": "main", "name": "…"}`.
3. Publish.
4. To end the test league: `archive --league league-main.json --end`.

## Pit crew management (built 2026-10-02; needs migration 014, a publish, and an in-game check)
MM 1.53 (pit crew pack) gives every team ~15 crew: 10 positions (FrontJack, RearJack, 4 wheels, 2 fixing, 2 refuelling; the series' `PitStopCrewSize` rule sets how many are used) and reserves (role None = 11). Each has 5 skills (Tyres, FrontJack, RearJack, FixingParts, Refuelling), confidence, per-race contracts (`ContractPitCrew.mRacesLeft`), and the team has its own applicant list and a funding level (Low/Medium/High). After each race `mPitStopLogs` holds the team's stop times and mistakes.

**The user's decisions:**
- Members manage **positions, funding level, hire & fire, contract renewals**.
- **Hiring from the team's own applicant list** (as in MM, no auction); signed at the next apply.
- **Public pit stop leaderboard** per race (fastest stop, average, mistakes); crew stats stay private.
- Without a member choice, the **last published line-up is kept** (MM's automanaging must not reshuffle member crews).
- **Site-run crew (user's pick):** in MM only the player's career team has real crew people (`PitCrewController.mPitCrewTeamMembers`); every AI team (so every member team) has an `AIPitCrew` instead: `carOneTaskStats`/`carTwoTaskStats`, one `{taskType, taskStat, taskConfidence}` per `SessionSetupChangeEntry.Target` (Fuel, Tyres, PartsRepair, FrontJack, RearJack, BatteryRecharge, Driver). MM sets `taskStat` = the car's mechanic `stats.pitStops` and rerolls `taskConfidence` 0.75-1 after every race weekend (`RegenerateTaskStats`); the pit stop sim reads them. So the site keeps the crew, and before each race the toolkit writes the task stats from the assigned crew (Fuel/Battery ← refuellers' Refuelling, Tyres ← the 4 wheel men's Tyres, PartsRepair ← fixers' FixingParts, jacks ← their jack stat; MM's `GetStatTypeBasedOnTarget`).
- **Starting crew: equal quality for every member team.**
- **Development as in MM:** funding (Low/Medium/High) trains active crew each race; after peak age they lose skill and eventually retire.
- **Confidence from real race mistakes** (MM's `mPitStopLogs` per team: `mNumberOfMistakes`, times); recovers over clean races.
- **Applicants generated by the site per team** (~8, expiring after 1-2 races), seeded.
- **Career team: MM's own crew, managed in game** (user's pick); the site shows it read-only (`TeamState.gameCrew`).
- MM facts (from the IL and Tatra's crew in "League Test 10"): active positions = 6 for Small/SemiSequential crews (jacks + 4 wheels), Large = 8 (+fixing), 10 with refuelling (`GetMaxPitCrewSizeNumber`, `IsPitCrewRoleAllowedInSeries`); a signing gives `mRacesLeft` = 2 x race count + 1; renewal only when racesLeft < 12; release costs nothing; wages $36K-$120K a year in $12K steps (per race = /12), sign-on $45K. The DesignData values (funding costs, training rates, max crew size) aren't in the save or readable assets.

**What's built:**
- `src/pit-crew.ts` (pure, shared with the site): positions per crew size, task mapping, `FUNDING` (Low free/+0.1, Medium $50K/+0.25, High $120K/+0.45 skill per race: league values, MM's are unknown), `CREW_SETTINGS` (max 15, sign-on $45K, renew below 12, retire at 38, applicants 8 for 2 races), `perRaceWage` (fitted to Tatra's crew: ~$1K per average skill point above 2, $3K-$10K), `startingCrew` (identical skills/ages/contracts for every team at the series' AI average `aiLevel`, names from the save), `crewAfterRace`, `taskStats`, `assignRole`, `fillEmptyRoles`, its own seeded `roll` (politics' one correlated neighbouring keys), and the snake_case row converters.
- `src/ops/pit-crew.ts`: `pitCrewRules`, `pitStopLog` (public leaderboard), `gameCrew`, `crewNamePool`, and the `setPitCrew` op (both cars' `AIPitCrew` task values).
- Extract: `championship.pitCrew`, `championship.pitStops`, private `gameCrew`.
- Migration `014_pit_crew.sql`: `pit_crew_teams` (funding, processed_round), `pit_crew`, `pit_crew_applicants`, `crew_spend` (counts in `hq_committed`), `pit_crew_log`; member RPCs `set_crew_role` (swap), `set_crew_funding`, `sign_crew_applicant` (budget + crew limit), `release_crew` (best reserve fills), `renew_crew`; service-only `save_team_crew`; included in archive/restore.
- Toolkit (`src/crew-orders.ts`): **publish** forms starting crews for member AI teams and runs every finished round since `processed_round` (a new season restarts the count); **pull** emits `setPitCrew` for every crew (standing, every apply) and charges queued `crew_spend`.
- Site: My team → **Pit crew** (Positions pit box with swaps and "In the race" task values vs the field's AI average; Crew & contracts with renew/release; Applicants with sign; Funding & log), and a **Pit stops** tab per round on Calendar & results. Budget strips count queued crew costs. Organizer guide mentions crews.
- Tests: `test/pit-crew.test.ts`, `test/db-crew.test.ts`. Checked in demo mode with headless Chromium (desktop and Pixel 7, no console errors).

**Next steps for the user:** run migration 014, publish (forms the member crews), then play one cycle and check in game that the apply's `setPitCrew` values hold through the race (MM rerolls AI crews only at race weekend end).

## Equalize the field (built 2026-10-02; needs migration 015)
The organizer can make every team in the championship (AI and members) equal, usually at the start of a league. Drivers keep their own stats.
**The user's decisions:** the organizer sets the values (the form starts from the field's averages); "car" = parts only (suppliers stay); budgets equal too; a button on the Organizer page queues it and the next pull/apply writes it.
- `src/ops/equalize.ts`, op `equalizeTeams` (settings `EqualizeSettings` in league-types): per team, constructions in progress are cancelled without refund and HQ levels set (`setBuilding`); a running design is cancelled without refund; every part of each designable, non-spec type gets the stat (performance 0), max performance, reliability, max reliability and level, and `seasonPartStartingStat` gets the stat so new designs start equal; every part development rate; the lead designer's `partContributionStats`; every mechanic's stats; AI crews' task values (MM rebuilds them from mechanics' Pit stops after each race, so the default skill = the mechanics' Pit stops) or the career team's crew skills; then `setBudget`.
- `src/equalize.ts` `fieldDefaults`: the averages (fitted parts' stat + performance, HQ levels rounded, budget to $100K, staff stats to 0.1).
- Migration `015_equalize.sql`: `equalize_orders` (organizer-only, one queued per series, in backups), `queue_equalize(settings)` (replaces a queued one), `cancel_equalize()`.
- `pull` (`src/equalize-orders.ts`): after undoing the AI, before members' orders; member site-run crews restart as equal starting crews at the skill (names kept) and are saved with `--mark-applied`.
- **Presets (user request, fixed values):** Low / Medium / High in `PRESETS` (`presetSettings`): budget $10M/$25M/$50M; HQ core buildings at 1 / half of each max / max; staff stats 6/10/15; pit crew 6@75 % / 10@85 % / 15@95 %; part reliability 60-65 / 75-80 / 90-95 %, max performance 10/20/30, level 1/2/3, development rate 0.6/0.75/0.9. Part performance can't be fixed across series (its scale differs), so it's the field average x 0.9 / 1 / 1.1.
- Site: Organizer page → "Equalize the field" (areas can be switched off, a per-team preview of budget, HQ levels, designer and mechanics averages).
- Tests: `test/equalize.test.ts` (every team equal after a reload of League Test 10; drivers and spec parts untouched; organizer-only queue).
- Not yet seen in game: an equalized save loading and racing.

## Bug fixes from user feedback (2026-10-02)
- **"No illegal option when designing a part":** grey-area components (Risk +1/+2) only exist at levels 3-5, and most teams' HQ only opens levels 1-2, so the site showed none. `designOptions` now also returns `lockedComponents` (published as `PartDesignOptions.lockedComponents`). The designer shows them greyed under their tier with a lock, marks every risky component "Grey area", and a hint line says how many are available or locked and which building opens them. **Needs a republish** to show locked components.
- Phone: the designer's part-type tabs overlapped the spec note. The tab list kept shadcn's fixed `h-8` (the `group-data-horizontal` variant beats a plain `h-auto`), so it now uses `h-auto!`.
- Every `Select` now opens downward (`position="popper"`, `align="start"` by default in `ui/select.tsx`); `item-aligned` put the selected team over the trigger, so the team list grew upward.
- Phone sidebar: closes when a page or series is picked (`setOpenMobile(false)` in `app-sidebar.tsx`), and its close button shows again (`ui/sidebar.tsx` had hidden it with `[&>button]:hidden`).
- Regulations page: "Regulations" and "Votes" sub-tabs, with the open vote count on the Votes tab.
- Checked in demo mode with headless Chromium (phone and desktop, no console errors); `npm test` passes.

## Calendar & results: every round clickable (2026-10-01, user request)
- MM keeps every finished round's results on its calendar event (race, qualifying, practice), so the extract now publishes `championship.races` (all finished rounds; `lastRace` stays, as the last of them). About 10 KB per round, public.
- `site/src/pages/results.tsx`: calendar rows with results are buttons; the chosen round is in the URL (`#/results?round=2`), and the latest race is the default. The Race/Grid tab stays when switching rounds. Older snapshots only have the latest race and say so.
- Needs a publish to show earlier rounds. Checked in demo mode (desktop and phone, no console errors).

## Illegal (grey-area) parts: MM's scrutineering, shown on the site (built 2026-10-01)
The user's idea: members may run parts that are faster but risk getting caught after a race. MM already does this (`PenaltyDirector.ScrutinizePartRules`), and the user chose to keep MM's system and make it visible:
- **Risk:** components with "Risk +1/+2" raise a part's `rulesRisk`. After every race each fitted part with risk is caught when Random(0..99) < (risk + investor `partRiskBonus`) × 5, i.e. 5 % per risk point.
- **If caught:**
  - `rulesBrokenThisSeason`++, and the car drops 2 × that many places in the race result, so points are lost through the result.
  - A fine of $100K × that count.
  - The part's performance and reliability are wiped, it's unfitted, and its risk drops by 1.
- **Saved as:** a `PenaltyPartRulesBroken` (`mPart`, `mPlacesLost`, `mPenaltyCashAmount`) on the race result row, and a "<Part> - Rules Broken" transaction.
- **Extract:**
  - `championship.rulesBreaches` is the **public** stewards' log: round, team, driver, places lost and fine, but no part.
  - `TeamDesign.rules` is private: offences this season, the investor bonus, and the team's own busts with the part.
- **Site:**
  - The designer warns when the chosen components carry risk (the chance, and what the next bust costs).
  - Part tables show a risk badge with the chance per race.
  - The "Scrutineering" card on the parts sub-tab shows the chance per car, offences, the next penalty and the team's own busts.
  - The "Stewards' decisions" card on the Calendar & results page is the public log (a siren marks rounds with busts).
- Helpers: `bustChance` / `carBustChance` / `nextBustPenalty` in `src/part-design.ts`. Tests check them, and check that "League Test 10" yields Bernhauss' real bust at Munich.

## Season regulations and politics (built 2026-10-01; migration 008 run and published by the user the same day)
Members see the current and the confirmed next-season regulations, vote on the site with MM's voting system, and **the site's result always overwrites the in-game vote**.

**Build progress (2026-10-01):**
- ✅ Step 1, extract:
  - `src/politics.ts` (pure, shared with the site): `TEAM_CHARACTERISTICS`, `teamCharacteristics`, `predictAiVote`, `tallyVote`, seeded `roll`, `voteCutoff`, `votesClosingNow`.
  - `src/regulations.ts`: `extractRegulations` → `championship.regulations` (public). It holds the current and next rule ids, a catalogue of every rule definition of the series in the save, this season's votes (held ones with MM's result; upcoming ones with predicted AI votes), and each team's vote power and characteristics.
  - Rule names come from the game's text in `resources.assets` (`gameDataDir()`, override with `MM_GAME_DIR`). The "HUDText","English","PSG_id" rows give the names and the rules CSV gives the descriptions. Placeholders are filled from the impacts (tracks, fuel, pit speed, race length). Descriptions with unfillable placeholders are dropped.
  - AI characteristics are approximated: fixed leanings + standings position (also used for team quality) + budget, driver, fuel and tyre ranks. Cornering and track stats are left out. Predictions are seeded (season, rule id, team), so what's published is what's applied.
- ✅ Step 2: migration `008_regulations.sql` (**not yet run on Supabase**).
  - `rule_votes` (team, season, rule_id, choice, extra_power), member-visible, via an RPC `cast_rule_vote` (vote upcoming in the latest snapshot and not concluded; extra power ≤ the team's `votingPower`).
  - `rule_vote_results` (season, rule_id, yes, no, abstained, accepted), written by `pull --mark-applied`.
  - `next_rule_overrides` (season, group, rule_id), organizer-only, via the RPC `set_next_rule(group, rule_id|null)`.
- ✅ Step 3: toolkit ops (`src/ops/politics.ts`) + `src/rule-votes.ts` + `pull`. Tests: `test/politics.test.ts` settles a real vote, reloads and validates.
  - `concludeVote` replaces MM's own vote:
    - `nextYearsRules` AddRule (replace by group) when accepted
    - push a VoteResults (yesVotesCount, noVotesCount, abstainedVotesCount, votedSubject ref, voteResult 0 accepted / 1 rejected)
    - `mLatestVoteResult`, `mNewRuleAproved`++, `mNextVoteIndex`++, `mActiveVote` = the next vote or null
    - remove that vote's calendar event (OnEventTrigger "Vote" on the politicalSystem; the k-th Vote event is the k-th vote)
    - apply the teams' `votingPower` changes
  - `setNextRule` sets a group in `nextYearsRules.mRules` to a catalogue rule (a ref to an existing PoliticalVote object), or back to the current rule.
  - `pull`: `votesClosingNow` → `tallyVote` (member votes from the DB + published AI votes) → `concludeVote`; then the organizer's overrides → `setNextRule`.
- ✅ Step 4 (built 2026-10-01, checked in demo mode): the site's "Regulations" page (`site/src/pages/regulations.tsx`, sidebar link) has:
  - current vs next rules, highlighting changes and overrides
  - upcoming votes with the member's vote and extra power, the live tally (AI + member votes) and when each closes
  - held votes with their results
  - the organizer's per-group selector for next season

**Rules (the user's choices):**
- **AI teams vote like MM:** the toolkit computes each AI team's vote with MM's logic (beneficial = Yes, detrimental = No, neutral = random or abstain, seeded) and publishes it, so members see the likely outcome.
- **MM's vote power:** each team has `team.votingPower`. A member can spend extra on a vote, and abstaining banks +1 (`VoteChoice.Voted` / `Abstained`).
- **Deadline:** a vote stays open on the site until the pull at the checkpoint before MM's vote date, and the result is applied in that pull.
- **The organizer can change next season's rules** (add or remove, overriding votes). The current season's rules stay as they are, as in MM.

**What MM has (PoliticalSystem, ChampionshipRules):**
- `championship.rules` (current) and `championship.nextYearsRules`. `mRules` is a list of `PoliticalVote`, each with `ID`, `group` (e.g. PracticeLength), `effectType`, `impacts`, `benificialCharacteristics` / `detrimentalCharacteristics`, and name and description text IDs. They also carry flat fields (points, tyres, `specParts`, budgets…).
- `championship.politicalSystem`:
  - `mVotesForSeason`: 3–8 votes, scheduled by `GenerateCalendarEvents` on Wednesdays from May 1 to pre-season. `mCalendarEvents` holds their dates.
  - `mNextVoteIndex`, `mActiveVote`, `mVoteChoices`, `mVoteResultsForSeason`.
- On the vote date `Vote()` → `GetVoteChoices` (AI by `GetVoteImpactOnTeam`) → `ConcludeVoting`: the majority by `votePowerUsed` wins (a tie is random). Accepted → `nextYearsRules.AddRule(vote)`.
- **Text:** rule names are localised IDs. The CSVs are plain in `resources.assets`, e.g. `PSG_10004395` = "Short Practice Sessions". The rules DB row holds the description template ("Practice sessions last {RuleSessionLength}.").
- **To research when building:**
  - `PoliticalVote.GetVoteImpactOnTeam` (team characteristics)
  - how to set or undo `nextYearsRules` safely (AddRule replaces the rule of the same group?)
  - how the vote results are stored, so the toolkit can overwrite MM's outcome

## Next season's car: suppliers on the site (built 2026-10-01; migrations 010–012 run; not yet tested in game)
In MM, designing next year's car means choosing suppliers (`CarDesignScreen` / `TeamAIController.FindSuppliersForNewChassis`): engine, brakes, fuel, materials (+ battery/ERS in hybrid series).
- The chassis stats are the championship base + each supplier's `supplierStats` (`ApplyChampionshipBaseStat` + `ApplySupplierStats`).
- The engine supplier's `randomEngineLevelModifier` goes onto the engine parts at the season change (non-spec series).
- Each supplier is paid on its own (`GetEngineTransaction` …).
- `supplierManager.GetSuppliersForTeam(type, team, checkCanBuy)` lists what a team may buy (tier, `mTeamsThatCannotBuy`, discounts).

**Build progress (2026-10-01):**
- ✅ `src/ops/suppliers.ts`:
  - `supplierOptions`: every supplier with tier = championshipID + 1 that the team can buy (`CanTeamBuyThis`), priced with `GetPrice` (team discounts). MM itself offers a seeded random subset each season; the league offers all. Battery/ERS only when the rules switch energy systems on.
  - `currentSuppliers`, and `nextYearDesignState` (MM's AI starts next year's design in `OnPreSeasonStart`; state 0 = designing, 1 = waiting, 2 = complete).
  - The `setSuppliers` op swaps suppliers in the pending `nextYearCarDesign.mChassisStats`: it shifts the chassis stats by the supplier-stat difference, sets `mEngineModifier` for the engine, refunds the old supplier's price and charges the new one. It errors before pre-season.
  - Tests: `test/suppliers.test.ts` simulates a pre-season design.
  - C# dictionaries can be saved as `{}` when empty; `dictEntries` handles both shapes.
- ✅ The extract publishes `design.nextYearCar` (state, current, options) privately per team.
- ✅ Migration `010_supplier_choices.sql` (run on Supabase by the user, 2026-10-01): `supplier_choices` and `choose_supplier(type, id)`. Migration `011_supplier_window.sql` (**not yet run**) replaces `choose_supplier` and adds `clear_supplier_choice(type)` (back to "keep current"). Both check the team's options in the latest snapshot and the window (`supplier_window_car`). No budget reservation: the prices are swapped at apply.
- ✅ **Season key fixed:** MM's pre-season straddles New Year (ERS: 13 Dec 2016 to 5 Mar 2017), so choices keyed by the game date's year would get lost at a January checkpoint. The extract now publishes `nextYearCar.season` = the year of `currentPreSeasonEndDate` (`nextCarSeason`), and the RPC and pull use it.
- ✅ `pull` (`supplierChanges` in `src/engine-orders.ts`): for every member team whose latest snapshot says "designing", emits `setSuppliers` with each type's choice for that car's season, else this season's supplier if still offered ("no choice = keep current", now implemented). It warns about choices no longer on offer and lists teams still waiting. It repeats on every pull while MM designs; `setSuppliers` skips what's already set.
- ✅ Tests: `test/db-suppliers.test.ts` (closed mid-season, open once MM's draw is published, faked with `test/supplier-draw.ts`; own options only; change and clear; privacy; refused once built) plus a pure test of `supplierChanges`.
- ✅ Site: Parts → **Next season's car** sub-tab (`site/src/components/next-season-card.tsx`; a Parts sub-tab rather than the Engine page, since it covers brakes, fuel and materials too).
  - A status badge (closed with races to go / open / MM designing / built), and this season's supplier bill against next season's.
  - Per type, every deal, cheapest first, with price, engine level and stats, and ▲/▼ deltas against this season's supplier. "Choose", "Keep" and "Keep this season's" (clear).
  - Repeated supplier names are numbered "deal 1, 2…". A note when engines are spec.
  - Checked in demo mode with headless Chromium: open and closed window, desktop and phone width, no console errors. The Parts sub-tab list now wraps on phones.
- ✅ Organizer page: a "Season end: next season's suppliers" block from the final race weekend (see Window below).
- ✅ README and `docs/save-schema.md` ("Next year's car and suppliers").
- ⏭ To do:
  - Publish again (migrations 010–012 are live).
  - ✅ (2026-10-03, see "Pre-season saves checked") ~~**Confirm the JSON shape of `championshipSuppliers`** in a save made after the final race (advance past the season's end): `npx tsx src/cli.ts suppliers "Save<name>" --league league.json` should list 4/6/5/4 deals per member team. (The `suppliers` command and its Organizer page docs were added 2026-10-01; migration 012 was run by the user the same day.)
  - Test in game at pre-season: does a member's pick show on MM's car screen, do the chassis stats and engine level follow, and do the refund and charge appear in finances?
  - Check when MM moves `currentPreSeasonEndDate` on to the next season (assumed: at the new season's start).
  - Member engines as engine options (with the engine season step). **The engine programme page has the same New Year issue:** `engine_season()` and the site use the game date's year, so a January pre-season checkpoint would count as next season. Fix it with the same `season` idea when building the engine step.

**Rules (the user's choices):**
- **Offers = MM's own draw (user's decision, 2026-10-01, replacing "every deal of the tier"):** the user found 15 "Micronix Racing" brake deals confusing. MM's car design screen offers each championship a few drawn deals per type (`championshipSuppliers`, see docs/save-schema.md), so the site shows exactly those. The extract only publishes them once the season is over or MM is designing the car (the draw may linger into the next season).
- **Window:** opens when a published save has MM's draw (after the final race, at the season's end), stays open while MM designs next year's car at pre-season, closes once it's built. This replaces the earlier "3 races left" (MM has no offers that early). Migration 012 changes `supplier_window_car` to match. The Organizer page shows the season-end steps from the final race weekend: save "League Season End" past the season's end and publish; then "League Pre-season", publish, pull, apply.
- **No choice = keep this season's suppliers** (if the team can still buy them).
- **Visibility:** choices stay private until pre-season, then everyone sees who runs which suppliers, as in MM's team screens.
- Member engines (engine programmes) appear as engine options next to MM's suppliers.

**Plan:**
- The extract publishes each member team's options per type (`GetSuppliersForTeam` logic: championship lists, can-buy, team price with discounts, stats, engine level range) and its current suppliers.
- A migration adds `supplier_choices` (team, season, type, supplier id or member engine), private until pre-season, with an RPC that checks availability and budget.
- At the pull before pre-season the toolkit sets the pending `nextYearCarDesign.mChassisStats` suppliers (or starts the design if the AI hasn't yet), recomputes the chassis stats and `mEngineModifier`, refunds the AI's supplier payments and charges the members' choices. This shares the engine-programme supplier code.
- Like the engine step, it can only be tested in game with a save near pre-season.

## Phase 5: works engine programmes (site + database built 2026-10-01; season-change step not built)
A member invests in their own engine programme, becomes an engine supplier, and sells engines to other members.

**Rules (the user's choices):**
- **It only pays off where the engine isn't spec.** A programme can be built up while the league is in the ERS (engine and gearbox are spec there), but its engine only counts in a series without a spec engine, e.g. the WMC (`rules.specParts` = []).
- **Seasonal R&D, shaped by decisions, not just money** (the user wants the outcome to depend on the member's choices, 2026-10-01). All four mechanics:
  1. **An engine concept each season** (e.g. high-revving power, efficient long-life, balanced). It sets which stats can go high and which are capped.
  2. **Trade-off allocation:** money buys development points, spread over power (engine level), fuel efficiency, tyre wear/heating, improvability (and the hybrid stats where the series has them). Pushing one area costs another, like component trade-offs in part design.
  3. **Risky research projects:** optional, with a success chance raised by the engineer and HQ. A breakthrough gives a big boost; a failure wastes the money or hurts reliability. Rolled at the season change.
  4. **Customer spec:** the owner sells the full works engine or a detuned one (cheaper, less power).
  - **Luck: a little, like MM**, e.g. a small roll on the final stats, as MM rolls max reliability ±10 %. Choices decide the engine.
  - Still to design when building: the concept list and caps, point costs, trade-off ratios, the project list and odds, how "reliability" maps to MM (MM suppliers have no reliability stat; maybe through the engine part's reliability).
- **Customers: members only, at a price the owner sets.** AI teams keep MM's suppliers.
- **Switching supplier: between seasons only**, as in MM.

**Illegal engine tech (agreed 2026-10-01):**
- **How an engine becomes illegal:** some R&D research projects are illegal. They give a bigger gain, with a detection chance per race that grows each race the device runs (rivals and stewards catch on).
- **League scrutineering, not MM's:** MM only checks car parts with `rulesRisk`, and a works engine's gain sits in the supplier, which has none. So the toolkit rolls the check after each race. Plan: at `pull`, with a seeded roll that is logged publicly for fairness. The result goes in the public Stewards' decisions log.
- **When busted:**
  - The engine is **forced back to its legal state** for the rest of the season: the illegal gain is stripped from the supplier stats, and the legal part of the programme still counts. The member may try again next season.
  - The team **loses that race's points** (driver and team) and pays a fine scaled to the illegal gain.
- **Customers only ever get the legal spec:** illegal tech is works-only. Customers can't be caught and don't get the gain. So the owner's works supplier and the customer supplier are two `Supplier` objects (fits the customer-spec choice).
- To research before building:
  - removing one race's points from the save's championship standings (`mPoints` per race, positions, and results' `points`)
  - whether a supplier's stats can be changed mid-season and take effect

**Build progress:**
- ✅ `src/engine-rules.ts` (pure, shared): concepts, rising point cost, `developEngine`, `projectChance`, `buildEngine` (seeded projects + ±5 % roll, legal vs works engine), `carryOver`, `customerEngine`, `illegalDetection`. Tests: `test/engine.test.ts`.
- ✅ Migration `009_engine_programmes.sql` (run on Supabase by the user, 2026-10-01).
  - `engine_programmes` is public. `engine_plans`, `engine_builds` and `engine_spend` are private. There are also `engine_projects` (the cost list, checked against `PROJECTS`) and `engine_customers`.
  - RPCs: `found_engine_programme`, `set_engine_concept`, `buy_engine_points`, `choose_engine_project`, `set_engine_offer`, `buy_engine`. All spending is reserved through `engine_reserve` (budget check), and `hq_committed` counts it.
  - Tests: `test/db-engine.test.ts`.
- ✅ `pull` charges reserved engine spending (`src/engine-orders.ts`) and pays the owner for engine sales. Verified by the user: pull lists the engine payments correctly (2026-10-01).
- ✅ Site page "Engine programme" (`site/src/pages/engine.tsx`): found, concept, buy points, projected engine, research projects (illegal ones marked with the detection odds), customer offer, the member engine market, and a spec-engine banner. Live only; demo mode shows a note.
- ⏭ **Season-change step (toolkit), to build and test at pre-season (2016-12-13):**
  1. After AI teams have started next year's design (`nextYearCarDesign.state` = Designing), the toolkit runs `buildEngine` for each programme (engineer skill = the lead engineer's stat average, DC level from HQ) and stores `engine_builds`.
  2. It creates league `Supplier` objects (works and customer spec) and sets them on the owner's and customers' pending `mChassisStats` (stat shift + `mEngineModifier`), refunding the AI's engine payment.
  3. Illegal tech: after each race with a works engine carrying a successful illegal project, roll `illegalDetection` (seeded, public log). If caught: strip the gain (set the legal supplier), remove that race's points (research the standings edit), fine.

**FF20 calibration (2026-10-09, user: "fix it"):**
- Money stays as is: budgets are on the same scale (ERS 2016 $2–9M, FF20 F1 $1–11M at the career start, one team $57M each), so no migration.
- The engine level isn't: Rebirth's 2016 F1 engines are level 34–53 on engine parts worth 5; FF20's F1 engines are level 15–128 (A engines 40–150, B engines 0–35) on parts worth 626–1000. `ENGINE_GAME` / `newEngine(game)` in `src/engine-rules.ts`: a new FF20 programme starts at level 40 (Rebirth 10), and `projectChance` reads engineer stats out of 25 on FF20 (20 on Rebirth). `carryOver` never drops below the game's start level.
- The Engine page benchmarks the projected level against MM's engines in the championship (the extract now publishes `engine.level`).
- **For the season-change step on FF20:** FF20 has no supplier draw, so every team is offered every supplier of its tier (`supplierOptions`). A league engine supplier must list every non-customer team in `mTeamsThatCannotBuy`, or MM's AI teams will buy it.

**Economics (the user's choices, 2026-10-01):**
- Founding a programme costs **$30M** (one-off).
- Development costs **$1M per point, rising within a season** (the 1st point $1M, the 2nd $2M, …; n points cost n(n+1)/2 $M).
- **No ceiling:** a top programme can beat MM's best supplier (MM's range in the ERS save: engine level 1–2 up to 26–129, fuel −7…+17, improvability −4…+17, price $5–16M).

**Proposed model (starting numbers, keep them tunable in `league_settings`):**
- Engine stats = a supplier's output: engine level L (added to engine parts at the season change in non-spec series), FuelEfficiency (key 2), Improvability (key 3), TyreWear (key 0), TyreHeating (key 1).
- **Concept each season** sets the caps and point yields:
  - *Power*: +6 L per power point, fuel and improvability capped at +5.
  - *Efficient*: +3 L per point, fuel/improvability up to +20, +1.5 per point.
  - *Balanced*: +4.5 L per point, fuel/improvability up to +12.
- **Trade-off:** every 3 power points cost −1 fuel and every 4 cost −1 tyre wear (more power = thirstier, harder on tyres).
- **Carry-over:** next season starts from 80 % of this season's legal engine, so long programmes pay off. A new programme starts at L 10, everything else 0.
- **Research projects** (rolled at the season change, seeded): e.g. a $5M project with 55 % success (+ lead engineer and HQ bonus) gives +20 L, and a failure costs −8 L.
- **Illegal projects:** a bigger gain (e.g. +35 L) with a detection chance of 4 % per race, +3 %/race while it runs. Works only, as agreed.
- **Customer spec:** full or detuned (85 % of L). The owner sets the price; it's paid at the season change.
- The final stats get a small seeded roll (±5 %).

**Save side (research done 2026-10-01):**
- `NextYearCarDesign`: an AI team (members' teams too) runs `TeamAIController.HandleCarNewChassis` when its state is WaitingForDesign (1). It picks suppliers (`FindSuppliersForNewChassis`), pays their prices, and runs `StartDesign(chassis)`, which stores `mChassisStats` and `mEngineModifier = supplierEngine.randomEngineLevelModifier`.
- At `DesignCompleted` (pre-season) → `CarManager.ApplyNewCarDesigns`, the cars get the chassis. In non-spec series the engine parts' stat += `mEngineModifier`.
- Chassis stat values = the championship base + each supplier's `supplierStats` (`ApplyChampionshipBaseStat` + `ApplySupplierStats`).
- **So the toolkit, between the AI's StartDesign and DesignCompleted:**
  - creates a league `Supplier`: a clone of an engine supplier with a new id and name, min = max engine level, and the stats. It is not added to `championshipSuppliers`, so the AI never buys it.
  - sets it as the pending chassis's `supplierEngine`, shifts the chassis stat values by the stat difference, and sets `mEngineModifier`
  - refunds the AI's engine payment and charges the league price (customer → owner)
- In "League Test 10" (6 Oct 2016) no team has started next year's design yet (state 1). Pre-season starts 2016-12-13. **The save side can only be checked in game at pre-season.**

**What MM has (from Assembly-CSharp):**
- `supplierManager.engineSuppliers`: `Supplier` objects with:
  - `name`, `mBasePrice`, `mTier`
  - `teamDiscounts`, `mTeamsThatCannotBuy`
  - `min/maxEngineLevelModifier` → `mRandomEngineLevelModifier` (rolled by `RollRandomBaseStatModifier`; set min = max to make it deterministic)
  - `supplierStats` (CarChassisStats.Stats → value; Tatra's "Hammer": FuelEfficiency +2, Improvability −5)
- `GetPriceNoDiscount` = base + engine level modifier × mPriceMultiplier × mScalar.
- A car holds its suppliers in `car.chassisStats.supplierEngine` (also brakes, fuel, materials, battery, ERS).
- `NextYearCarDesign` takes the chosen supplier at the season change. In non-spec series it adds `randomEngineLevelModifier` to every engine part's stat; the price is charged as a "Next year car" transaction.

**Plan sketch:**
- The toolkit creates a league `Supplier` in `engineSuppliers` (and in `championshipSuppliers` for the championship), with stats from the programme, and sets it on the owner's and customers' next-year car.
- Money moves customer → owner at the season change.
- Before building, test a season change in game with the toolkit: how suppliers are chosen for member (AI-run) teams at the season end, and when chassis stats pick up supplier effects.

## Quality-of-life: times and building info (built 2026-10-02, user request)
- **Part improvement time:** the Mechanics card shows when each list is done (game days and date), live with the slider and the lists. `src/part-improvement.ts` is MM's exact formula (see docs/save-schema.md, "Part design and improvement"); the extract adds `improvement.chiefPerformance` / `chiefReliability`. **Needs a republish**; older snapshots show "appear after the next publish".
- **Part design time:** the running design shows days left, the queued one and the designer show "N days to design".
- **HQ:** buildings under construction show weeks left (days under a week). Every building shows MM's UI name (the "missing" Forecasting Centre was the save's "Logistics Centre") and an info icon with MM's description and effects on hover (`src/hq-info.ts`). Tooltips are hover-only, so they don't open on phones.
- **Calendar:** each remaining race shows "in N days" from the published game date ("this weekend" on race day).

## Sponsors (built 2026-10-03; needs migration 016, a publish, and an in-game check)
**The user's rules (2026-10-03):**
- Offers = **MM's own offers** from the save, no site-generated offers.
- **No exclusivity:** several teams can sign the same sponsor, as in MM.
- Signing any time before the organizer's next pull; the apply writes the deal (like HQ/parts).
- **AI deals:** deals MM's AI signed on a member team since the league began (offer date ≥ `league_start()`, no league sign order) are flagged; **the member keeps or drops** each one. Doing nothing keeps it. Dropping pays the upfront money back (my proposal in the discussion; the user said go ahead without objecting; easy to change in `drop_sponsor` and `sponsorChanges`).
- **No early exit** from other deals; only empty (or being-freed) slots take a new deal.
- **Visibility:** what's on the car is public (`TeamPublic.sponsors`); terms and offers private (`TeamPrivate.sponsorship`).
- **Expiry:** MM's own: an offer lapses after `offerRacesLeft` days (see docs/save-schema.md, "Sponsors"). The site warns at 7 days or less; `pull` leaves out and marks `expired` a sign whose offer lapsed by the latest snapshot's game date.
- The career team signs its sponsors in game (RPCs refuse it; the tab shows it read-only). The weekend objective sponsor isn't offered: the AI re-picks it at every event.

**Built:**
- `src/ops/sponsors.ts`: `teamSponsors` (extract), ops `signSponsor` and `dropSponsor`, mirroring `SponsorController.AddSponsor` / `RemoveSponsorshipDeal` (see docs/save-schema.md, "Sponsors"). Test in `test/ops.test.ts` (sign + drop, reload, validate, types, end event).
- Extract/publish: `sponsors` public, `sponsorship` private (`SponsorDeal`, `SponsorOffer` in `src/league-types.ts`).
- Migration `016_sponsors.sql`: `sponsor_orders` (kind sign / drop / keep; status queued / applied / cancelled / expired / kept), RPCs `sign_sponsor(slot, sponsor_id)`, `drop_sponsor(slot)` (budget check, counts in `hq_committed`), `keep_sponsor(slot)`, `cancel_sponsor_order(id)`; included in archive/restore. Tests in `test/db-sponsors.test.ts`.
- `src/sponsor-orders.ts` + `pull`: drops (with `adjustBudget` −upfront) before signs (+upfront), marks applied/expired with `--mark-applied`.
- Site: My team → **Sponsors** tab (6 slots "On the car" with Keep/Drop on AI deals and pending states; "Offers" table with upfront, income, length, guaranteed value, lapse date, Sign); rivals see only the sponsors on the car. Budget strips and the bid dialog count pay-backs. The organizer's race guide lists sponsor choices. Checked in demo mode with headless Chromium (playwright-core from the scratchpad).
- Not verified in game yet. To check: sign an offer and drop an AI deal on a member team via the site, pull + apply, load in MM, advance past a race and save; then `mmsave extract` (or publish) should still show the deal, with per-race money added to its `earned`, and the dropped sponsor gone.

## Season transition (designed 2026-10-03 with the user; chassis + car fund built, the rest not yet)
**What MM does** (Assembly-CSharp):
- **Investment** (`TeamFinanceController.mInvestement`, Low/Medium/High): a savings plan, not car quality. Every month `GetCarDevCost` (WMC $12M/$18M/$24M a year, ÷ 12; smaller in other series) is debited ("Next year car" transaction) and added to `moneyForCarDev`; when next year's car is designed, the pot is credited back (`GetCarDevMoney`) to pay the suppliers. The AI sets Low or Medium from its finances (`TeamAIController`).
- **Chassis design** (`CarDesignScreen`, player only): two sliders, `UIPreferencesSettingsWidget`: nose height = fuel efficiency ↔ tyre wear, rear package = improvability ↔ tyre heating; each stat = `chassisBaseStat[champ]` − `chassisSliderAmmount`/2 + slider × `chassisSliderAmmount` (10), the pair moving opposite ways; the chosen suppliers' `carAspectMin/MaxBoundary` narrow each slider; locked to the base outside the main championship. Then `ApplySupplierStats` adds the suppliers' stats. The AI (`HandleCarNewChassis`) builds a default chassis: member teams never get a preference.
- **Contracts:** at pre-season (month > 6) the AI renews anyone not contracted for next season if they're "interested to talk" (`ShouldRenew`), else lets them go and hires a replacement.
- **Pre-season** (`Team.OnPreSeasonStart`): next year's design waits; part improvement lists are cleared; part ranking recorded and `PerformanceCatchup` resets parts towards the field; stages DesignCar → PartAdapting → ChooseLivery → PreseasonTest.

**The user's rules:**
- **Chassis:** members set MM's two sliders (within their suppliers' bounds) next to their supplier picks; written into the pending design at pre-season like `setSuppliers`.
- **Investment:** like MM, cash flow only: members pick Low/Medium/High (a standing choice re-applied every pull).
- **Expiring contracts:** members decide on people whose contracts end this season. Renewal at MM's asking wage, the member picks 1–3 years; MM's "interested to talk" can refuse. Not renewed → into the next transfer window (any member can bid, the old team too).
- **Engine programmes:** build the designed season step.
- **Pre-season checklist** in the site's race guide and the TUI cockpit.
- **Part reset preview:** show members how MM's catch-up will change their parts.
- **Order:** chassis + investment first, then the rest. Most of it can only be checked in game with a save at season end / pre-season.

**Chassis + car fund (built 2026-10-03; needs migration 017, a publish, and an in-game check at pre-season):**
- Save: every supplier has `carAspectMinBoundary` / `carAspectMaxBoundary` (`[{Key, Value}]`, Key = `Supplier.CarAspect`: 0 RearPackage, 1 NoseHeight); engines and fuel set min bounds, brakes and materials max bounds. A slider's range is [Σ min, 1 − Σ max] over the chassis' suppliers (`UIPreferencesEntry.ClampSlider`).
- Chassis stats (`CarDesignScreen.OnStartDesign` + `CarChassisStats.ApplySupplierStats`): base 0 (`chassisBaseStat` is all zeros); nose n: FuelEfficiency = −5 + 10n, TyreWear = −5 + 10(1−n); rear r: Improvability = −5 + 10r, TyreHeating = −5 + 10(1−r); then for each supplier in order Engine, Brakes, Fuel, Materials (Battery/ERS set starting charge/harvest instead) add its stat (keys 0 TyreWear, 1 TyreHeating, 2 FuelEfficiency, 3 Improvability) and floor the stat at 0 after each add. n = r = 0.5 equals the AI's default chassis. Sliders only in the main championship (`GetMainChampionship()`, the WMC); elsewhere locked at the base.
- Pending design: `nextYearCarDesign.mChassisStats` (fields `mTyreWear`, `mTyreHeating`, `mFuelEfficiency`, `mImprovability`) while `state` = 0 (Designing). Existing `setSuppliers` shifts stats by supplier differences; the new `setChassis {team, nose, rear}` op recomputes the four stats from scratch (sliders clamped to the suppliers' range) and runs after it.
- Investment: `financeController.mInvestement` (0 Low, 1 Medium, 2 High), op `setCarInvestment {team, level}` as a standing choice every pull; extract publishes level, `GetCarDevCost` per level (series table above, ÷ 12, MM rounds currency) and `moneyForCarDev`.
- Site: next-season card gets "Car design" (two sliders, stats baseline = default vs result, recomputed with the chosen suppliers via a shared `src/chassis.ts`) and the investment selector. DB migration 017: `chassis_choices (team, season, nose, rear)` in the supplier window, `car_investment (team, level)` any time.
- **Built:** `src/chassis.ts` (`sliderRange`, `chassisStats`, shared with the site); ops `setChassis` / `setCarInvestment` and `hasChassisDesign`, `carInvestment`, `pendingSuppliers` in `src/ops/suppliers.ts`; supplier options now carry `minBound`/`maxBound`; the extract adds `nextYearCar.chassisDesign`, `.pending`, `.investment`. Migration `017_chassis_investment.sql` (`set_chassis`, `set_car_investment`; the career team is refused). `src/car-orders.ts` + pull ("Next season's car" section; skipped with a warning before migration 017). Site: `components/car-design-card.tsx` under the supplier picks (sliders within the suppliers' bounds, default → yours for the four stats; the fund's three levels with MM's monthly amounts and the fund so far). Tests: `test/chassis.test.ts`, `test/db-car.test.ts`.
- When the suppliers' bounds cross (no room on a slider), MM's own screen pins the slider at 0 (worst end); the toolkit keeps the middle (the AI's default) instead and the site says so.
- To check in game at pre-season: a member's sliders show on MM's car screen stats for that team (next year's car), and the fund level shows in its finances.

**Pre-season saves checked (2026-10-03, ERS "League Test 10 (4)"–"15", 6 Nov → 17 Dec 2016).** Details in docs/save-schema.md, "What MM does on the first day of pre-season".
- **The supplier draw comes at pre-season start, not after the final race.** `championshipSuppliers` is empty on 4 and 6 Dec and filled on 13 Dec, the day the AI picks from it and starts designing. The window logic (open when the snapshot has offers) already works; the organizer guide is fixed: one "Pre-season" save on the first day, check with `suppliers`, publish, let members choose, pull + apply (the design runs to 5 Mar). The guide block now also shows in pre-season (MM resets the calendar then, which hid it): the extract publishes `championship.preSeason {start, end}` (needs a publish).
- **Fixed `setSuppliers`:** it shifted the pending chassis by the raw supplier difference, so stats went negative (Garuda −4, −4.5). It now rebuilds the four stats with MM's formula (floor at 0 after each supplier) and keeps what the AI added on top (1–2 random stats +4). Battery/ERS still shift. `setChassis` (WMC) still rebuilds from scratch, so WMC members trade the AI's bonus for the sliders.
- **Fixed `removeUnorderedParts`:** MM's pre-season rebuilds every part with no components and build date 13 Dec, which would have counted as AI-built (removed + refunded once spares existed). Parts without components are now skipped.
- Contract renewals: the ported rules predicted MM's AI outcome for 23 of 24 people; wages differ by about −20 %…+7 % (MM negotiates).
- Tests: `test/preseason.test.ts` (on "League Test 12 (1)": draw + AI picks, floored chassis, reset parts kept).
- ✅ **Verified in game by the user (2026-10-03): "League Test 16"** (from "League Test 12 (1)"): Garuda Racing's next-year suppliers set to Micronix #41 brakes, Imperial #42 fuel, XCT Alloys materials (chassis TW 0, TH 0, FE 6, IM 0; budget 2,705,750 → 935,750 after refunds and charges) and car fund High; Panther Race Team (WMC) sliders nose 0.8 → clamped 0.64, rear 0.3 (chassis TW 25, TH 15, FE 16.9, IM 15.5).
- **Promotion/relegation: member teams protected, AI teams move (user's decision 2026-10-05, replacing "block it" from 2026-10-03):** op `protectTeams` (src/ops/promotions.ts), sent by every pull with the member teams; the career team is always protected too (it retires every race with the game patch, so it ends last, and relegating it would move the organizer's view out of the league). At season end MM stores each tier pair's lower champion and upper last place with their part rankings and swaps exactly those at pre-season start without re-reading the standings, so a protected one is replaced by the best-placed (champion) or lowest-placed (last place) unprotected team of that championship, with its part rankings recomputed by `partRankings` (port of `TeamStatistics.GetPartRankingsForChampionship`; matches MM's stored values exactly for all 14 teams in "League Test 12"). No unprotected team left: that swap is held. It also lifts `completedPromotions` left by the old `holdPromotions` (in a save that flag can only come from it). **Needs an apply between season end (6 Dec in ERS) and pre-season start (13 Dec)**: the race guide's pre-season box has that step ("Season end" save, the day before pre-season). Applied earlier it reports "stored from last season" and changes nothing that matters. Tests in `test/preseason.test.ts`. `holdPromotions` stays as an op (old changes files) but pull no longer sends it. Earlier version verified in game: "League Test 17" (the full freeze). ✅ **Substitution verified in game by the user (2026-10-05):** "League Test 12 Protect" (`examples/protect-teams-test.json` on "League Test 12"), advanced to pre-season.
- **AI chassis bonus (user's decision: keep it):** member cars outside the WMC keep the 1–2 random +4 stats MM's AI rolled; `setSuppliers` preserves them.
- **Still needs a January save:** contract ends (31 Dec replacements, `mNextYearEmployeeSlots`), and when MM moves `currentPreSeasonEndDate` on (after 5 Mar).

**Expiring contracts (rules agreed 2026-10-03; step 1 built the same day, needs migration 018, a publish, and an in-game check):**
- **Rules (the user's):** renew in a contract's final 12 months until MM's pre-season starts (`currentPreSeasonStartDate`, 13 Dec); no decision = the contract expires; renewal at MM's asking wage + MM's sign-on fee; only the fee is reserved against the budget; the member picks 1-3 seasons (`league_settings.max_contract_years`); someone MM says won't talk can't be renewed. The career team renews in game.
- **Built:**
  - `src/ops/contracts.ts`: MM's renewal rules ported from Assembly-CSharp (`renewalTerms`, `teamRenewals`, `teamStars`, trait conditions) and op `renewContract`. See docs/save-schema.md, "Contract renewals". The random term is 0.
  - Extract: private `contracts {deadline, renewals}` (`TeamContracts`, `ContractRenewal`).
  - Migration `018_contract_renewals.sql`: `contract_renewals`, RPCs `renew_contract(person_guid, years)` and `cancel_renewal(id)`, fee counted in `hq_committed`, archive/restore.
  - `src/renewal-orders.ts` + pull section "Contract renewals" (before the transfer window); the op refuses if the contract changed since the order (`expectedEnd`).
  - Site: My team → **Contracts** tab (`components/contracts-tab.tsx`, `lib/contracts.tsx`): current vs MM's asking wage, sign-on fee, preferred length, MM's answer, 1/2/3-season picker, Renew/Cancel. Budget strips and the bid dialog count renewal fees; the organizer's race guide and the TUI cockpit list renewals. Checked in demo mode with headless Chromium (desktop and 390 px, no errors).
  - Tests: `test/ops.test.ts` (renew, reload, validate, event moved), `test/db-renewals.test.ts`.
- **On the F1 save (1 Mar 2016)** 30 contracts end this season: 10 willing, 10 "Morale too low" (low season-start morale plus traits such as "teammate earns more"), 7 "Not interested", 2 rival refusals, 1 retiring.
- **To check in game:** renew someone on a member team via the site, pull + apply, load in MM: the staff screen shows the new wage and end year, and the contract doesn't end on 31 Dec.
- **Step 2 (needs a pre-season save):** non-renewed people into the next transfer window; undo MM's AI pre-season renewals and next-year signings on member teams (MM fills seats via `mNextYearEmployeeSlots`, and `HireReplacement*` at contract end).

## TUI (designed 2026-10-03 with the user; all four phases built the same day)
**The user's choices:** all four areas (race cycle cockpit, save browser + diff, command launcher, save editor), built in that order; **Ink** (React for the terminal); a full-screen, game-like dashboard (sidebar of screens, panels, colours, keyboard navigation); **plain Unicode symbols** (the user isn't sure their terminal has a Nerd Font); offline save features always, website features with the CLI's own `.env` credentials; every write **previews a diff, asks, and writes a new save name** (never overwrites, through `Save.write()`).

**Plan:**
1. **Shell + cockpit:** `npm run tui`; the CLI's commands move into functions (`src/commands/*.ts`) that take a logger and return results, so the CLI and the TUI share them. Screens: series picker (`league-*.json`), save picker (Wine folder, newest first, with game date and series prefix), and the cockpit: where the series stands (last/next race from the latest save and snapshot, like the site's race guide), publish, members' queued choices (HQ, designs, sponsors, crews, window), pull → change preview by team → apply to a new save name.
2. **Save browser:** teams by championship, a team's budget, HQ, parts, staff, sponsors; `diff` of two saves as a tree.
3. **Command launcher:** every CLI command as a form with pickers, output in a log pane.
4. **Editor:** budget, HQ levels, renames, hire, parts, sponsors, with preview + new save.

**Phase 1 built (2026-10-03):** `npm run tui` (`src/tui/`: `app.tsx` shell, `cockpit.tsx`, `pickers.tsx`, `components.tsx`, `data.ts`, `theme.ts`). `src/commands/` holds `publishSave`, `pullDecisions` (returns the change set, sections for the review and `markApplied`) and `applyToSave`, used by the CLI and the TUI; `src/race-cycle.ts` (`seriesFiles`, `cycleOf`) is shared with the site's race guide; `readSavHeader` reads a save's header without the data block. Checked by driving it in a pseudo-terminal (Python `pty` + `pyte` in the scratchpad) at 150×46, 120×34 and 100×28: publish (declined), pull review, apply to a new save (then deleted), mark-applied declined. Not yet used by the user.
- Dialogs are overlays (absolute `Box` with a background) so the screen under them keeps its state; blocking work (loading, writing saves) runs behind a "Working…" dialog.
- The F1 series is named "Formula 1", so the race guide's save names are "Formula 1 R1 Post", but the user's saves are "F1 League …": the save list falls back to all saves and the steps show the selected save's name. Renaming the series (or the saves) would line them up.
- Found while testing: `startDesign` needed a design already running somewhere to copy its calendar event; the F1 save has none (the equalization cancelled them), so the real apply failed. It now builds the event from any queued event (same `CalendarEvent_v1` + `MMAction` shape). Test in `test/ops.test.ts`. Also `pull` now skips sponsors with a warning while migration 016 hasn't been run (it failed before).

**Phase 2 built (2026-10-03):** screens 4 and 5.
- **Save browser** (`src/tui/browser.tsx`): teams by championship, a team's overview, HQ, parts, staff and sponsors via the extract's own `team()` (now exported, with `building`, `part`, `person`).
- **Compare saves** (`src/tui/compare.tsx`): picks the other save, orders them by game date then file time. "Per team" = `compareSaves` (`src/save-compare.ts`: budget, standings, HQ, design, parts by GUID with values rounded as MM shows them, staff by slot, sponsors by slot). "Every field" = `diffSaves` (`src/diff.ts`): teams first, then people ("Person <name>"), championships, then "save"; each team's branch stops at other teams, people and championships, so it holds only that team's own data. Up to 200,000 fields (a race apart is about 50,000+).
- Loaded saves are cached (two at most, about 340 MB each; `loadSave` in `src/tui/data.ts`) and shared by the cockpit, browser and compare; apply always loads its own copy.
- Fixed in the diff (CLI too): an object compared with a missing value was printed whole before being cut to 120 characters, which with a deep `--depth` ran out of memory (4 GB); objects are now described (`{TeamDisplayEffect}`, `[3 items]`). 50,000 fields take about 0.6–1.5 s.
- Tests: `test/compare.test.ts` (League Test 3 → 4). Checked in the pseudo-terminal at 140×40.

**Phase 3 built (2026-10-03):** screen 6, **Commands** (`src/tui/launcher.tsx`, forms in `src/tui/commands.ts`). All 12 CLI commands as forms with defaults from the selected series and save; it runs `node_modules/.bin/tsx src/cli.ts …` as a child process (the exact CLI behaviour, the screen stays responsive, `Esc` stops it), streams output into its pane and the log, and rescans saves after apply/encode. The run and the forms live in a module-level store, so a command keeps running across screen switches; the child is killed when the TUI exits. Upload/delete/write commands confirm first (archive `--end` in red). New pick-from-list dialog (`kind: "pick"`, type to filter). Tests: `test/tui-commands.test.ts` (argument building, confirmations). Checked in the pseudo-terminal: validate, teams, apply confirm (declined), diff save picker, Esc stop, screen switch during a run.

**Phase 4 built (2026-10-03):** screen 7, **Editor** (`src/tui/editor.tsx`; the team list is shared with the browser in `src/tui/teams.tsx`). Edits are toolkit changes (`setBudget`, `renameTeam`, `setTeamCountry`, `setBuilding`, `hire`, `renamePerson`, `fitPart`, `removePart`, `signSponsor` + `adjustBudget` for the upfront money, `dropSponsor`), keyed by team id so a queued rename doesn't break later edits. They're kept per save file in a module-level store (survive screen switches, dropped when another save is picked). `w`: `Save.load` a fresh copy, `applyChanges`, `compareSaves(original, edited)` as the preview, then a new name (must not exist) and `Save.write()`. Checked end to end in the pseudo-terminal on "F1 League R1 2016 League": DCT budget $50M + Design Centre level 3 → written, validated (12078 objects, budget and level as edited), then deleted; free-agent picker, sponsor sign, undo.
- Not covered: adding new parts (`addPart` needs stats the editor would have to ask for), part stats, staff stats, contracts. Easy to add as more rows/actions.

## Team identity: colours, livery and logo (toolkit verified in game 2026-10-05; site built the same day, needs migration 019, `mmsave liveries` and a publish)
**The user's choices:** members can change all three (colour scheme, livery pattern, logo) on the site; colours with a **free colour picker**; changes allowed **any time between races** (applied at the next export); the user confirms MM mods load in their game.
**How it would work** (details in docs/save-schema.md, "Team colours, livery and logos"):
- Colours: the toolkit writes a full Team Colours database mod into `MM_Data/Modding/Databases/` (base rows extracted from the game + one new row per member team) and points the member team's `colorID` at it. Only the organizer installs it.
- Livery: set `team.liveryID` to one of the save's `liveryManager._liveries` for that championship.
- Logo: member uploads an image; the toolkit adds `Team_/TeamSmall_/TeamBW_/TeamHat_/TeamBody_/TeamChairmanBody_<teamID>` textures to the `Images/teamlogos` bundle (UnityPy). Riskiest part.
**In-game test, built 2026-10-05: works in game (user, same day)** once the staging mod is switched on:
- `setTeamLook` op (`src/ops/team.ts`): `colorID` and/or `liveryID` (checked against `teamLiveries`, the liveries valid for the team's championship).
- `src/team-colours.ts`: `teamColoursMod()` = MM's table (`schema/team-colours-1.53.csv`, extracted from `resources.assets` with UnityPy) + one row per league team from four picked colours (primary, secondary, tertiary, trim); UI shades, helmet, staff, sponsor and livery-editor colours are derived. League IDs start at 129 and must stay contiguous. Very dark picks are lifted for the UI only.
- `tools/team-logos.py` (Python + UnityPy): adds `<prefix>_<teamID>` textures (6 sizes, BW = greyscale) to a **copy** of the `teamlogos` bundle. Verified by reloading: 356 textures, container and preload table consistent.
- Test files: save "F1 League R1 2016 Look Test" (`SaveF1 League R1 2016 Look Test.sav`, from "League Fixed Repaired" + `examples/team-look-test.json`): Kubica GrandPrix (team 7) → colour row 129 (red #c8102e / white / black / gold trim) and livery 27 (was 14). Mod files in `out/team-look-test/Modding/` (`Databases/Team Colours.txt`, `Images/teamlogos` with a placeholder "KUBICA GP" logo).
- To check in game: logo on standings/team/HQ screens, hats and shirts; red UI colour; car body and livery pattern in the race/practice 3D view; nothing else changed for other teams (incl. the 62-127 logos of the user's existing bundle).
- **The staging mod must be switched on in MM's Workshop screen after every launch** (`StagingMod.isStaging` is not saved). With it off, MM shows its own logo and falls back to colour row 0 (white car, grey staff) for a league `colorID`.
**Site choices (2026-10-05, user):** logo uploads wait for **organizer approval** (pull exports approved logos only); livery picker shows **previews tinted in the member's colours** (extract MM's pattern textures); colour clashes **warn only**.
**Site, built 2026-10-05:**
- Migration `019_team_identity.sql`:
  - `team_looks` (series, team, four colours, `livery_id`, `color_id`): a standing choice. `color_id` comes from the global sequence `league.team_color_id` (from 129) once per team and is never reused, because one mod file serves every series in the game install. Readable by every member of the series.
  - `team_logos` (path in Storage bucket `team-logos` as `<series>/<uuid>.<ext>`; status pending / approved / rejected / withdrawn / replaced; note). Approved ones are visible to the series, others to the team and the organizer.
  - RPCs `set_team_look` (hex check, livery must be in the snapshot's `championship.liveries`; update before insert so saves don't burn colour IDs), `submit_team_logo` (withdraws an earlier pending one), `withdraw_team_logo`, `review_team_logo` (organizer; approving replaces the current logo), `all_team_identities()` (service role: every series' looks and approved logos with the MM `teamID` from that series' latest snapshot). The career team is refused (`my_look_team`).
  - Storage buckets `team-logos` (public read, members upload into a series folder they're in, 1 MB, PNG/WebP/JPEG) and `liveries` (public read): created only where a `storage` schema exists (Supabase, not PGlite).
  - Included in archive/restore. Tests: `test/db-team-identity.test.ts`.
- Extract: `TeamState.look` (public: `colorID`, `liveryID`, MM's colours for MM rows) and `Championship.liveries` (`id`, MM's number, `dlc`, `mask`: the side-view texture's file name, `liveryMask` in `src/ops/team.ts`).
- `tools/livery-masks.py`: exports every livery texture's lower half (the car's flank on side views) as a 512x128 colour key from `resources.assets` (paths via the ResourceManager in `globalgamemanagers`) and the Livery Pack bundle: 195 files, 2.8 MB. Every livery in both test saves has one. These are game assets, so they go to the `liveries` bucket (`mmsave liveries --game <MM_Data> --python <py>`), not the public repo. Demo mode reads `site/public/liveries/` (gitignored; copy `out/liveries` there).
- `src/livery-tint.ts`: the channel blend (black primary, red secondary, green tertiary, blue trim) and the clash distance ("redmean" < 100), shared by the site.
- `pull`: `setTeamLook` for every saved look, every time (MM re-rolls AI liveries each season), with a reminder to rebuild the mod.
- `mmsave team-mod --league <file> [-o out/team-mod] --logos-base <original teamlogos> --python <py>` (`src/team-look-orders.ts`): `Modding/Databases/Team Colours.txt` (every series' rows; gaps from ended series filled with MM's row 0) and, if any logo is approved, `Modding/Images/teamlogos` from the **original** bundle + the logos (downloaded from Storage). Two series with logos for the same MM teamID: the later approval wins, with a warning. Test: `test/team-mod.test.ts` (runs the Python step when `MM_PYTHON` has UnityPy).
- Site: My team → **Identity** tab (big side-view preview with the logo; four colour pickers with hex fields; clash warning; livery grid tinted in the draft colours, Livery Pack patterns labelled separately; Save / Reset; status "MM's own look" / "Saved · in game after the next race" / "In game"; logo "In use" and pending upload with Withdraw, rejection note, Upload). Rivals see it read-only. Organizer → **Team identity** card (pending logos with Approve / Reject + note, and the team-mod command). Teams page: a colour stripe and the approved logo on each card. The race guide's pull step mentions the mod. Checked in demo mode with headless Chromium: save look, upload, approve, no console errors.
**To go live:** run migration 019; `mmsave liveries --game "<game>/MM_Data" --python <py with UnityPy>` once; publish (for `look` and `liveries`); keep a copy of the game's original `Modding/Images/teamlogos` (the one from before the Kubica test) as `--logos-base`.
**Not done:** `TeamRebrand` (MM can change an AI team's `colorID`; the next pull puts it back); the career team (colours live in the save header).

## Player team retires at every start (built 2026-10-05; applied to the user's game and verified in game the same day for qualifying and the race)
**The user's request:** the team MM considers the player's (the spectator team, e.g. SPEC Racing in the F1 career) retires at the start of every race with no yellow flag, safety car or VSC. **Choices:** patch the game code (not a save edit); retire on the grid (when the session goes green); **qualifying too**.
**Why a game patch:** see docs/save-schema.md, "Retirements and race flags": flags only come from crashes and spins; a parts retirement sets none; but a save edit (zeroed parts) only fails at MM's first condition tick, 6-12% into the race, and until then makes the car crash for certain when picked.
**Built:** `tools/league-patch/` (see its README): `LeaguePatch.dll` (net35 against the game's DLLs, `Hooks.OnSessionStart`: in qualifying and race sessions, every `isPlayerDriver` car not out of the race → `ChangeBehaviour(Retired)` + reason `Parts`, logged as "LeaguePatch: retired …") and a Mono.Cecil patcher that adds one call at the end of `SessionManager.StartSession()` (original kept as `Assembly-CSharp.dll.orig`; patches always start from it; `--restore` is byte-identical). Switch: `MM_Data/league-patch.ini` `retirePlayerTeam=true|false`, read at each session start (off for a series where the organizer races the career team, e.g. Tatra in "main"). CLI: `mmsave game-patch --game <MM_Data> [--retire on|off] [--status] [--restore]` (needs `dotnet`). Test: `test/game-patch.test.ts` (on a copy of the game's Managed folder).
**Verified in game (user, 2026-10-05):** works for both qualifying and the race. Original check list: patch, load a save before qualifying: the spectator cars retire as Q1 goes green (stay in the garage) and as the race starts (drive to the garage), no flag, the race runs on for viewing; `output_log.txt` shows "LeaguePatch: retired". Watch how a car retiring at the green on the grid behaves while the field launches.

## Third-party mods: Enzoli 2016, facepack, track movies, Enhanced Graphics (2026-10-08; installed, not yet checked in game)
The user downloaded these into ~/Downloads and asked that they work with the toolkit, with **member teams' branding always taking priority** over the mod's AI teams. Details are in docs/save-schema.md, "Third-party mods".
**User's choices:**
- Install UMM in **Doorstop mode**, with a guard in `game-patch`.
- Port **liveries, sponsor logos, track movies and the facepack**.
- **Pin AI liveries, members free:** members may still pick any pattern.
- Give AI teams **real 2016 colours**.

**Built:**
- `tools/enzoli-port.py` (+ `tools/mod_bundle.py`, the shared bundle writer `portraits.py` now uses): Enzoli's `resources.assets` (not installable on 1.53) → `out/enzoli/Modding/Images/liveries` (12 liveries), `Images/sponsorlogos` (62 decals, car + UI), `Videos/TrackMovies/*.bik` (16).
- AI looks: `league.json` `"aiLooks"` → `src/ai-looks.ts`; `examples/f1-2016-looks.json` covers 8 WMC AI teams (colours are a best match to the 2016 cars; tune freely). `team-mod` writes the colours over MM's rows, and `pull` pins the liveries (`setTeamLook` by teamID, `ifAvailable`). Member teams are skipped by name or teamID. `league-f1.json` points at the file. Tests: `test/ai-looks.test.ts`, ops test for `ifAvailable`.
- `game-patch`: refuses patch/restore while `Assembly-CSharp.dll` references UnityModManager. `--status` reports UMM (injected or Doorstop). Test in `test/game-patch.test.ts`.
- `tools/livery-masks.py`: masks of liveries replaced by `Modding/Images/liveries` come from the mod, so the site previews Enzoli's patterns.
- `tools/driver-photos.py facepack --facepack <bundle>`: SFace match of the facepack's faces to the save's drivers (107 matched, threshold 0.5). A matched face is the default pick on `sheet.html` (value `facepack:Driver_<n>`). `build` cuts it out like the photos and credits the facepack.

**Installed in the game's `MM_Data/Modding`** (backup of the old `Team Colours.txt` in `out/modding-backup-2026-10-08/`):
- `Images/liveries`
- `Images/sponsorlogos`
- `Videos/TrackMovies/*.bik`
- `Databases/Team Colours.txt` (member rows 129–131 unchanged, AI rows 1–5, 7, 64, 104 replaced)

**Still to do:**
- **Tracks (2026-10-08, user feedback: calendar still showed MM's tracks):**
  - Enzoli's file does embed real track pictures (`TrackImages@1080`, 16 circuits). His team logos and track outlines are not in it: they point back into the old game's `.resS`.
  - MM can't mod those atlases or its text, so the league game patch now has two more hooks (`tools/league-patch/README.md`):
    - `MM_Data/league-sprites/<Atlas>/<sprite>.png`;
    - `MM_Data/league-text.txt` (circuit, series and GMA→FIA renames, from Enzoli's Shared table).
  - Both files are written by `tools/enzoli-port.py`, installed, and the patch was re-applied. Not yet checked in game.
  - The 3D circuits stay MM's fictional ones.
  - The track intro movies hadn't been tested: that session never went to a race weekend.
- Enzoli's newer Workshop **"2016 Mod Layer"** (and his "Intro Videos") are referenced by the facepack's previews but not downloaded. That's the likely source of real team logos and colours; ask the user for it.
- Facepack portraits now keep their own background (user preference).
- **Portraits built and installed 2026-10-08** from the user's `choices.json` (in `out/portraits/`): 107 facepack faces, MM's drawn face for the other 98 drivers (no Wikimedia photos); indexes checked against "SaveF1 R2 2016 Post"; the old test bundle is in `out/modding-backup-2026-10-08/portraits`.
- **The user:** re-run `mmsave liveries` so the site shows the new patterns.
- **UMM installed 2026-10-08** (0.33.1 from Nexus, the official console installer run under mono, DoorstopProxy):
  - `winhttp.dll` and `doorstop_config.ini` in the game folder (target `MM_Data\Managed\UnityModManager\UnityModManager.dll`, rewritten with backslashes);
  - `MM_Data/Managed/UnityModManager/` holds the manager;
  - `Mods/EnhancedGraphics/` holds the mod;
  - Wine per-app override `HKCU\Software\Wine\AppDefaults\MM.exe\DllOverrides` `winhttp=native,builtin` in `~/.wine`;
  - `Assembly-CSharp.dll` and the league patch are untouched (`game-patch --status` reports Doorstop).
  - First launch (2026-10-08): UMM loaded and Enhanced Graphics reported `Active`, but UMM's window was empty: Unity's `Font.GetOSInstalledFontNames()` found no fonts (the prefix's `C:\windows\Fonts` was empty, though Wine's registry already listed the Linux fonts under `Z:\`). Fix: Liberation Sans copied into `~/.wine/drive_c/windows/Fonts` and registered, plus a Wine replacement Arial → Liberation Sans. Not yet checked in game.
  - To uninstall: run the installer again with "D. Delete", or remove those files and the registry key.
- **Check in game** (staging mod on): Enzoli patterns and real colours on the AI cars; sponsor decals on cars and in the sponsor screens; a track intro movie; the facepack faces; Enhanced Graphics loading (UMM log) together with the league patch.
- **Not done:**
  - Feeder-series AI colours (the user can add GP2/GP3 teams to the looks file).
  - Enzoli's UI atlases (F1/GP2 series branding in `Shared1@1080`/`Frontend1@1080`): there's no mod type for atlases except `AssetManager.GetAtlasTexture`, unexplored.
  - The 89 facepack faces with no confident match.

## Fresh start with FIRE (decided 2026-10-08)
- **The community chose a new career on a FIRE mod.** The user says "Fire 20" (a FIRE 2020 mod?); they first linked FIRE Mod 2017, Workshop 1118440753. The F1 2016 career and today's Enzoli/2016 work are retired; the tools stay.
- **The game install is not vanilla.** Three base files were changed before the toolkit touched it, presumably by Rebirth: Redux. Their build stamps are the 2017 originals, and there's no marker text.
  - `Managed/Assembly-CSharp.dll`: 2025-11-05. The league patch's `.orig` backup was taken from this already-modified DLL.
  - `Managed/Assembly-CSharp-firstpass.dll`: 2024-06-30.
  - `resources.assets`: 2025-10-06.
- **These can't be restored without clean copies** from the same 1.53 build (expected build stamps: firstpass 2017-11-17, Assembly-CSharp 2017-11-22). `schema/team-colours-1.53.csv`, `circuits-1.53.json` and `championships-1.53.json` were extracted from the modified `resources.assets`: re-extract and compare once clean files are in.
- **Removed 2026-10-08:** everything the toolkit added. The game patch is restored (to the Rebirth DLL).
  - UMM and Doorstop, `Mods/`, and the Wine `MM.exe` DLL override;
  - `league-sprites`, `league-text.txt` and `league-patch.ini`;
  - `Modding` liveries, sponsorlogos, portraits, teamlogos, Team Colours and the track movies.
  - Everything is backed up in `out/game-backup-2026-10-08/`.
- **Left in place:**
  - `Modding` files from 2026-10-01 that the toolkit didn't make: `Databases/Chassis.txt`, `Create Team Defaults.txt`, `Part Suppliers.txt`, `Images/supplierlogos`, `Preview.png`;
  - the Liberation Sans fonts in `~/.wine/drive_c/windows/Fonts`.

## FIRE Fantasy 20 installed (2026-10-08, not yet run)
- **The mod:** Workshop 2020326985, the zip from ~/Downloads, extracted to `~/Downloads/FF20/mod`. Manual: https://docs.google.com/document/d/16LmFibA56tC3aIfOWam43kyQgC7qGcQO4CBkvzYhos4. It's a new career only, starting in 2020, with F1/F2/F3, GT World/Cup, WEC and the Global Endurance Trophy: 84 teams, 12 per series.
- **Installed into the game:**
  - `00_installation/MM_Data` copied over `MM_Data`: FF20's `Assembly-CSharp.dll`, `resources.assets`, 14 `sharedassets*.assets`, 4 frontend `.bk2` videos and `StreamingAssets/FireFantasy20/config.txt`. Overwritten files are backed up in `out/game-backup-2026-10-08/before-ff20/`. Those are the Rebirth versions.
  - The Workshop part (Databases, DesignData, Images, Logos, Models, Videos) copied into `MM_Data/Modding` (the staging mod). The five 2026-10-01 Modding files were removed (copies in `out/game-backup-2026-10-08/Modding`).
- **firstpass:** FF20 doesn't ship `Assembly-CSharp-firstpass.dll`. Every type and member its DLL uses exists in the (Rebirth-dated) firstpass copy.
- **Manual setup:**
  - race difficulty slider 0, Race Strategy Difficulty "realistic", Expanded Camera off;
  - switch the staging mod on before creating the career;
  - play in English.
- **Bonus:** FF20's DLL exports race results, lap/sector data and driver stats to files (`FF20_DataManagement`, configured in `StreamingAssets/FireFantasy20/config.txt`). It's a candidate source for results import.
- **Big finding: the old install ran Rebirth: Redux code.** It adds fields to 55 classes compared with FF20 (which is vanilla 1.53 plus FIRE's edits).
  - Fields the toolkit treated as "1.53" are Rebirth's:
    - `Team` development rates, breakthrough/dead-end parts and ranks;
    - `CarPart.developmentVariance`;
    - `Circuit` per-series session start times and overtake corners;
    - `Championship.bannedLocations`, min/max races, `hadResetThisYear`;
    - `Supplier` temporary discounts; `SupplierManager.championshipSuppliers` and `priceMultiplier`.
  - So `schema/mm-1.53.json` describes the Rebirth game.
  - Code that uses these fields: `src/ops/design.ts`, `src/ops/equalize.ts`, `src/ops/parts.ts`, `src/ops/suppliers.ts`, `src/ops/circuits.ts`, `src/ops/old-format.ts` and `src/cli.ts`.
  - The F1 2016 save's "older save format" was a pre-Rebirth save.
- **Toolkit work needed for FF20** (discuss with the user first):
  - Regenerate the schema from FF20's DLL. `monodis` segfaults on it, so use a Cecil- or ilspy-based dumper.
  - Review every feature that reads Rebirth fields.
  - Re-extract the colour, circuit and championship tables from FF20's assets and mod databases.
  - Re-check the league patch hook targets against FF20's code.
  - Team identity: build on FF20's Team Colours table and teamlogos bundle. Its liveries use UV mapping on its own models.

## Toolkit on FF20 data: foundation (2026-10-08)
**User's direction:** rebuild the toolkit on FF20 data. Add FF20's race data export to the site with all four views (results, position/gap charts, lap times/stints, sectors/speed). Tyre wear, fuel, setup and form/stamina are visible to the own team only. Upload goes with `publish`.

**Built:**
- **Schemas:**
  - `tools/schema-dump` (C#, Mono.Cecil) writes the schema JSON from a game DLL. `monodis` crashes on FF20's DLL; the dumper also fixes the old monodis generator's naming bugs.
  - `schema/mm-ff20.json` comes from FF20's DLL. The old `schema/mm-1.53.json` is renamed `schema/mm-rebirth.json`, since it was generated from the Rebirth DLL.
  - `Save.game` (`detectGameCode`: a Team with `breakthroughParts` means Rebirth) picks the schema, so old saves and tests still work.
- **Colours:** the base table is `schema/team-colours-ff20.csv` (FF20's `Databases/Team Colours.txt`: 85 rows, 0..84, without the Metallic/Smoothness columns). The old one is `team-colours-rebirth.csv`. `teamLook`/`baseColours` take the game code. League colour IDs still start at 129; 85..128 are filled with neutral rows.
- **Sponsors:** FF20 repurposed `Sponsor.Category` as the series tier (SingleSeaterTier1..EnduranceTier2), and the labels are now per game.
- **Test:** `test/ff20.test.ts` on "SaveFF20 F1 Test" (or `MM_FF20_SAVE`).

**FF20 facts found:**
- Part stats are on a **0–1000 scale** (Mercedes 1000, Manor 600; old saves ~0–100).
- Enum changes:
  - `Championship.Series` gains `EnduranceSeries2` (4);
  - `RaceStartType` has no `Jump`;
  - `PenaltySize` has no `Tiny`;
  - `UITeamLogo.Type` has no `ChairmanBody`.
- **Team logos:** `Images/teamlogos` has `Team`/`TeamSmall`/`TeamBW` for all 84 teams, with ARGB32 templates present. The `team-mod` logo base must be FF20's pristine bundle (`~/Downloads/FF20/mod/Images/teamlogos`).
- **Liveries:**
  - Each team has its own livery in `Images/liverypack`: ids 92..362, `LiveryBase_<n>`/`LiveryDetail_<n>`, 4096² UV maps for FF20's models. They are still colour keys (black/red/green/blue), so a member's four colours still tint them.
  - The save stores the liverypack's **absolute path** (`customAssetBundleName`); moving the game folder breaks liveries in saves.
  - The site's side-view masks don't apply, so the livery picker preview needs a new design.
- **Race data export:** `FF20_DataManagement.FF20_DataManager.SaveAllData`, run when the race results screen shows (race only, no qualifying).
  - **Path:** `MM_Data/StreamingAssets/FireFantasy20/<baseFolderName>/<locationName>_<yyyyMMdd>_<timestamp>/{RaceResults,LapSectorData,DriverStats}`, as set in the installed `config.txt`.
  - **Format:** pipe-separated CSV with a `SEP=|` first line. RaceData has the public fields of `RaceEventResults.ResultData`, with references written by `name`. LapData is one file per driver: `lapNum|sectorNum|compounds|tyreWear|tyreTemp|fuel|setupQuality|sessionTrim|trackWater|trackRubber|flag|gapToLeader|gapToCarAhead|topSpeed|sectorTime|standingPos|form|stamina|timeDriven|overtakesDelta|runWides|cutCorners|lockUps`. DriverData has the driver stats.

**Rebirth clean-up (2026-10-08).** The rules follow `save.game`; old saves keep Rebirth's, and `test/ff20.test.ts` covers FF20.
- **Part design** (`src/ops/design.ts`, `src/part-design.ts`, `DesignContext.rules`). FF20's `CarPartDesign` differs from Rebirth's:
  - base stat = season start + engineer skill (no ×1.5);
  - max performance = improvability ×2;
  - max reliability = `initialMaxReliabilityValue` (no design-centre/engineer bonus);
  - no development rates;
  - component days for every non-engineer component (Rebirth only counted them when the slot count equalled the level);
  - AI (non-player) materials ×0.01 (Rebirth ×0.1), and AI designs 10 days faster;
  - design-centre days 0/−2/−3.5/−5;
  - starting reliability rolled per game launch (0.5–0.7, max 0.85–0.95); the planner shows 0.6/0.9.
  - `developmentVariance` is only written to Rebirth saves (`design.ts`, `parts.ts`).
- **Equalize:** development rates are only written where the save has them. The site hides the field when the field average has none.
- **Suppliers** (`src/ops/suppliers.ts`): FF20 has no next-season draw. It offers every supplier of the type with `mTier === championshipID + 1` that isn't in `mTeamsThatCannotBuy`, which gives each team its own engine list. Battery prices add the harvest-efficiency modifier (+ the hybrid mode cost $1M, rounded to $1000). The site still shows them only at season end (a league rule).
- **`repairCircuits`/`repairOldFormat`:** refuse FF20 saves (Rebirth-only fields).
- **Site:** the parts tab hides the development-rate note for FF20 contexts.

- **League game patch re-applied on FF20 (2026-10-08, user request: "retire the player team" must stay active).**
  - `Assembly-CSharp.dll.orig` is now FF20's pristine DLL.
  - `retirePlayerTeam=true`.
  - FF20's `SessionManager.StartSession` and `AIRetiredBehaviour` match Rebirth's.
  - The atlas and text hooks are in too, but do nothing without `league-sprites/` or `league-text.txt`.
  - FF20's `SessionManager.isUsingAIForPlayerDrivers` only means "session being skipped", so it can't replace the patch.
  - Not yet checked in game on FF20.

**Still to do:**
- Rescale for 0–1000 stats.
- Design the livery picker.
- Build the race data feature (needs a real export: play a race in the FF20 test career).

## FF20 race data on the site (built 2026-10-08; needs migration 020 and "gameData" in the league file)
- **Parser:** `src/race-data.ts` (`findRaceExport`, `readRaceExport`) reads FF20's export folder for a round (`<location>_<yyyyMMdd>_*`, newest wins, base folder from FF20's `config.txt`).
  - Public: classification, per-driver sector rows (gaps, position, compound, flag, top speed, sector time running within the lap, incidents, track water/rubber) and driver stats.
  - Private per team: tyre wear/temp, fuel, setup quality, form, stamina.
  - A real race is about 218 KB public + 81 KB private.
- **Database:** `supabase/migrations/020_race_data.sql`.
  - `league.race_data` is readable by series members; `league.race_data_private` by the own team or the organizer.
  - `publish_race_data` is service-role only and replaces a round.
  - Both are in `series_tables`. Test: `test/db-race-data.test.ts`.
- **Upload:** `publishSave` uploads every finished round with an export when league.json has `"gameData": "<MM_Data>"`.
- **Site:** Results gets Classification, Race trace (position and gap charts), Lap times & tyres (lap chart clipped at 107 %, stint bars), Sectors & speed and My team data (tyre wear/temp, fuel, form).
  - Code: `site/src/components/race-data.tsx`, `site/src/lib/race-data.tsx` (demo mode: `public/race-data-demo.json`, gitignored), Recharts 2.15.4.
  - Checked with headless Chromium on desktop and 390 px, with no console errors.
  - `site/public/demo-state.json` is now an FF20 extract; the old one is in `out/work/demo-state.backup.json`.
- **Seen in the test race:** a car demoted by the post-race scrutineers has negative `lapsToLeader` (shown as "Penalty").
- **FF20 scrutineering (fixed 2026-10-08):** the "−23" was real: FF20 sends a caught car to the back (`mPlacesLost` 23), fines $250K per offence, checks at 10 % per risk point and **bans** the part. `SCRUTINEERING` in `src/part-design.ts` holds both games' rules. The extract adds `championship.game`, `design.rules.game` and `Part.banned`. The site shows "To the back", FF20's odds and fine, and a "Banned" marker (no fitting or improving). `setFitting` skips banned parts, so `pull` no longer refits a caught part from the stored fitting. Tested on "SaveFF20 F1 Test Post race". Needs a publish to show on the site.
- **To go live:**
  - run migration 020;
  - add `"gameData"` to `league-f1.json`;
  - keep FF20's `config.txt` with `oneFolderPerRace = true`;
  - publish after each race.

## FF20 rescale and the 3D livery picker (built 2026-10-08)
- **Race data is live-ready.** The user ran migration 020; `league-f1.json` has `"gameData"`, and FF20's `config.txt` already has `oneFolderPerRace = true`. The 2016 `aiLooks` line was removed from `league-f1.json`: on FF20 it would have painted 2016 looks onto FF20's AI teams.
- **`league-f1.json` still lists the 2016 career's members and teams** (Tatra Racing etc., which don't exist in FF20) and the championship name "Formula 1 World Championship". The user must set the FF20 member teams before the first pull.
- **FF20 vs Rebirth numbers:** both DLLs' method bodies were diffed (Cecil IL dump, hashed per method). Every game rule the toolkit mirrors was checked. The differences are in `src/game-rules.ts` (`GAME_SCALE`), keyed by `save.game` / `championship.game`:
  - Drivers: stats up to 25, ability = total / 41.4 (was 20 and / 36). Engineer stats go up to 25 too (ability still / 24). Team principal ability = total / 90 × 5 (was / 60).
  - Buyout (`GetContractTerminationCost`): yearly wage / 8 per month left (was / 12).
  - Car fund (`GetCarDevCost`): a smaller table, paid **after each race** (yearly / the season's races), not monthly. The site says "/race".
  - Chassis stats are clamped to 0..20 (`chassisStatMax`).
  - Part stats (700–1000) only matter in ratios, so equalize, promotions and team stars needed no change. Improvement rates and component boosts are the same in both games.
- **Migration `021_ff20_scale.sql` (not yet run):**
  - `league_settings.buyout_wage_divisor` (default 8);
  - `public.buyout` reads it;
  - wage bases set to FF20 F1 medians (Driver $6.0M, Engineer $4.5M, Mechanic $0.73M);
  - the `liveries` bucket allows 8 MB and `model/gltf-binary`.
  - The TS mirrors fall back to 8 before the migration runs.
- **Livery picker:** FF20's `LiveryShader` (decompressed from the F1 bundle) samples base and detail at **UV0 whatever the projection**. It mixes primary → trim (B) → secondary (R) → tertiary (G).
  - `tools/ff20-car-renders.py` exports FF20's F1 car (`Chassis_Championship0`, without sponsor quads and glass) as `ff20-f1-car.glb`. It also renders one side-view UV lookup and writes:
    - per livery: a side mask (`ff20-f1-<key>.png`) and a 1024² UV key (`ff20-uv-<key>.png`);
    - one shading/parts overlay.
  - It covers 374 liveries: the table, the DLC bundle and FF20's liverypack. It takes about 2 minutes.
  - `mmsave liveries` runs it when `Modding/Models/Vehicle/F1` exists and uploads the `.glb` too.
  - Extract: `LiveryOption.model/texture/name/usedBy` ("FF20 design n", the teams running it).
  - Site:
    - The selected livery is shown on a 3D car (`livery-car-3d.tsx`, three.js 0.186.1, lazy chunk).
    - The grid shows side renders with the overlay (lazy-loaded) and has a search by name or team.
    - MM's own patterns are garbled on FF20's model, as in game, and sort last.
  - Checked in demo mode (desktop and 390 px, no console errors). The My team tab bar now scrolls sideways on phones (it overflowed before).
- **To go live:** run migration 021, then `mmsave liveries --game "<MM_Data>" --python ~/.mm-venv/bin/python` (uploads about 43 MB), then publish.
  - **2026-10-09:** the user ran migration 021. All 945 livery files (`out/liveries`) are uploaded. Only the publish is left.
  - The upload failed on "bad record mac" TLS errors (about 1 in 50 requests, more for the 3 MB `.glb`). Storage requests now retry 6 times, and `mmsave liveries` uploads every file it can before naming the failed ones, so running it again is enough.

## League pre-season (built 2026-10-09; migration 022 run by the user the same day; needs a publish and an in-game check)
**The user's rules (2026-10-09):** on a save a few days before round 1 the organizer opens a pre-season on the site (Organizer page switch, not automatic). While open:
- **Free-agent signings, instant:** first come wins (no auction), no sign-on fee, at the market's opening wage (`min_wage`), 1..`max_contract_years` seasons. Free agents only (no AI or member staff). The replaced person becomes a free agent. Only free agents of the latest publish can be signed: people released now reach the market at the next publish.
- **Own-team moves:** promote the reserve (to car 1 or 2), swap the drivers' cars, swap the mechanics, release anyone.
- **This season's suppliers, free:** any supplier of the tier (FF20 has no draw). The chassis is rebuilt with MM's floor-at-0 formula; **a new engine shifts every engine part by the engine-level difference** (`mRandomEngineLevelModifier`: Mercedes A 128, Renault A 93, Mercedes B 17), which MM otherwise only adds when next year's car is built (`NextYearCarDesign.DesignCompleted`). Not with spec engines.
- **Release rule (my default, told to the user):** a released race driver, engineer or mechanic stays unless someone is signed into the seat before the pull (MM can't race with an empty seat); the pull warns. Only a released reserve actually leaves.
- The career team is managed in game.

**Built:**
- Ops (`src/ops/staff.ts`): `promoteDriver` (port of `ContractManagerTeam.PromoteDriver` without morale: slots, status, standings row removed if the demoted driver hasn't raced, session driver lists cleared like `ClearSelectedDriversForSession`), `swapCarDrivers`, `swapMechanics` (`SwapMechanicForDriver`), `releasePerson` (reserve only). `hire` into an empty reserve slot now sets status Reserve. `setCurrentSupplier` (`src/ops/suppliers.ts`) reworked as above; returns lines.
- MM facts: single-seater cars = the first two driver slots (`Team.GetDriversForCar`), the third is the reserve; FF20 teams have spare driver slots 3–5 that aren't seats. `ContractPerson.Status` 0 Equal / 1 One / 2 Two / 3 Reserve. Session lists `mSelectedSessionDrivers` (car → [driver]) and `mVehicleSessionDrivers` (car → driver) are empty before the first session.
- Extract: `Person.status` (drivers), `Person.mechanicCar`, `SupplierOffer.level` (exact engine level), `design.currentCar {current, options, specEngine}` (FF20 only).
- `src/preseason.ts`: `replay()` turns a team's moves (oldest first) into the line-up and the save changes; shared by the site and the pull. A release + later signing into that seat becomes one `hire` replacing the released person.
- Migration `022_preseason.sql`: `league_settings.preseason`, `preseason_moves` (public in the series; unique queued signing per person = first come wins), `preseason_suppliers` (private). RPCs `set_preseason`, `preseason_sign`, `preseason_move`, `preseason_undo` (latest move), `preseason_supplier`, `clear_preseason_supplier`.
- Pull: section "Pre-season" after contract renewals (`src/preseason-orders.ts`); `--mark-applied` marks moves and picks applied.
- Site: My team → **Pre-season** tab (first tab while open: line-up with promote/swap/release, moves waiting with Undo last, this season's suppliers); Staff market "Sign now" dialog and "signed by"; header badge; Organizer card to open/close. Checked in demo mode with headless Chromium (desktop and 390 px, no console errors).
- Tests: `test/lineup.test.ts` (ops on "SaveFF20 F1 Test"), `test/db-preseason.test.ts` (RPC rules, then pull → apply on the save).

**To go live:** publish the pre-race save (the extract adds the new fields); open the pre-season on the Organizer page; members act; `pull --mark-applied` + apply; close it.
**To check in game:** a promoted reserve races in the right car; swapped mechanics show on the right drivers; a pre-season signing's wage and contract end; the engine switch shows in the car's stats (chassis and engine).

## Renewal refusals explained on the site (2026-10-09)
- The user asked why drivers wouldn't re-sign after winning a race. Checked against MM's code on the 2016 F1 saves: MM's renewal check never counts wins directly. A race moves morale by at most ±0.2 (`UpdateSessionMorale`, against the *expected* position: a win from an expected 3rd is about +0.08), while temporary traits (fights −0.6 each way, injuries, "Losing Hope" −0.3) and promotions/status changes (±0.4) move it far more. Marketability pushes drivers away (+8 % per point), and the career manager's loyalty/finances (used for every team) only help in steps of 8.
- **Port bug fixed:** teammates' traits reached every teammate. MM (`CanBeAppliedToOtherPerson`) only lets a teammate trait through without special cases, or a fight with *this* driver; such a trait adds its morale modifier as well as its teammate modifier (MM's code does both). Ocon and Massa (2016 R2) were wrongly "Morale too low" because of Hamilton and Rosberg's fight.
- `ContractRenewal.why` (`RenewalReason`): morale with every trait (name from MM's localisation via `gameTextName`, temporary end date, condition, teammate), MM's score parts against the threshold, and tips (the morale band that would be enough, which traits wear off when). Contracts tab → "Why?" dialog (`site/src/components/renewal-why.tsx`). Checked in demo mode, desktop and 390 px.
- Seen while checking: `extractLeague` on the 2016 WMC in "SaveLeague Test 10" crashes in `rulesBreaches` (`r.penalties` isn't an array there). Old Rebirth save only; not fixed.
- Possible league rules if MM's behaviour is unwanted: ignore "Morale too low", count wins or podiums, or a fixed manager loyalty/finance. Not asked for.
- Note: the pre-season `promoteDriver` op skips MM's ±0.4 morale change for promotion/demotion.

## Working notes for the assistant
- The user plays MM under Wine on Linux (CachyOS). They test in game and report back, so give them concrete things to check.
- Never overwrite the user's own saves. Write new `SaveLeague Test N.sav` files.
- Git: branch `main`, remote `origin` = github.com/JustJohny/Motorsport-Manager-League (public, Apache-2.0 LICENSE from GitHub). Pages URL: https://justjohny.github.io/Motorsport-Manager-League/. Commit and push only when the user asks.
