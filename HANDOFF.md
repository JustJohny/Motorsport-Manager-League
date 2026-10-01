# Handoff: MM League Toolkit

_Last updated 2026-10-01 (auction and HQ orders live and verified in game; next: phase 4, part development). Read this first in a new session, then `README.md` and `docs/save-schema.md`._

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
- Members can bid on free agents and on AI teams' staff. AI staff cost a buyout (remaining contract value) and swap with the released person.
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
   - Tuning to discuss: opening prices can be below an AI driver's current wage, and buyouts of long contracts are large ($11M for a 20-year-old on a deal to 2018).
3. **Phase 4: part development.** Rules agreed with the user (2026-10-01), replacing the earlier "formula from team assets" idea:
   - **The game builds it**, like HQ: the site sends the design, the toolkit starts it in MM, and MM finishes it with its own stats and time.
   - **Components from MM's real list**, per part type, with MM's unlock rules (Design Centre level, designer).
   - **Parts the AI designs on member teams are cancelled and refunded**, as with HQ projects.
   - **Members choose fitting** (which part goes on car 1 and car 2).
   - **League limit: one active design per part type** per team, counted on the site.
   - **Both cars in one order**, at MM's price for the second build. It counts as one design.
   - **Paid upfront**, with money reserved on order and paid at apply, as with HQ.
   - MM facts so far (from `Assembly-CSharp.dll`, `CarPartDesign`):
     - Base stat = season starting stat for the part type + 1.5 × the lead designer's matching `partContributionStats`.
     - Cost = `PartTypeSlotSettings.materialsCost` per championship and part type, + component cost bonuses.
     - Time = `buildTimeDays` − `designCentrePartDaysPerLevel[level]` − component bonuses.
     - `maxPerformance` comes from the chassis' improvability.
4. An organizer workflow document (between-race checklist).

## Working notes for the assistant
- The user plays MM under Wine on Linux (CachyOS). They test in game and report back, so give them concrete things to check.
- Never overwrite the user's own saves. Write new `SaveLeague Test N.sav` files.
- Git: branch `main`, remote `origin` = github.com/JustJohny/Motorsport-Manager-League (public, Apache-2.0 LICENSE from GitHub). Pages URL: https://justjohny.github.io/Motorsport-Manager-League/. Commit and push only when the user asks.
