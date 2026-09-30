# Handoff: MM League Toolkit

_Last updated 2026-09-30 (website v1 built). Read this first in a new session, then `README.md` and `docs/save-schema.md`._

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
  - **Unverified against real Supabase:** which JWT claim holds the Discord username. `current_discord_username()` uses `user_metadata.name` minus `#discriminator`, then falls back to `user_name` and `full_name`. The Organizer page lists logins that match no team, which shows the real value.
- **Demo mode:** without `VITE_SUPABASE_*` the site loads `site/public/demo-state.json` (a gitignored extract). It was verified by screenshots of every page, with no console errors.
- `.github/workflows/pages.yml`: builds `site/` on push to master/main, with `BASE_PATH=/<repo>/`.

### One-time setup the user still has to do
1. **Supabase:** create a project, then run `supabase/migrations/001_init.sql` in the SQL editor. Copy the URL, publishable (anon) key and secret key.
2. **Discord:** create an app at discord.com/developers → OAuth2. Add the redirect `https://<project>.supabase.co/auth/v1/callback`. In Supabase → Authentication → Providers → Discord, paste the client ID and secret.
3. **Supabase Auth URL config:** Site URL `https://<user>.github.io/<repo>/`. Also add `http://localhost:5173/` to the redirect URLs for dev.
4. **GitHub:** create the repo and push. It must be public for free Pages. Set Pages source to "GitHub Actions". Add secrets `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
5. **Locally:** copy `.env.example` to `.env` with the secret key. Add `discord` usernames to the league file, then run `mmsave publish "<save>" --league league.json`.

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
1. Walk the user through the one-time setup above and test a real Discord login. Fix the username claim if needed.
2. **Phase 2: staff auction** (fixed window).
   - `auctions` and `bids` tables, a `place_bid()` function (open window, minimum bid, budget check), realtime bids, and `mmsave pull` producing `hire` ops.
   - The game's wage demand can't be read from the save (see docs/save-schema.md), so the league defines its own minimum bid. Agree on that formula, plus rules for which slot a signing replaces, releases, and ties.
3. Phase 3: HQ queue (N race weekends; `BuildingInProgress` counts as level 0). Phase 4: part development formula. Both feed `syncTeam` through `pull`.
4. Optionally, play "League Test" through a race to verify driver hires and swaps on AI teams.
5. An organizer workflow document (between-race checklist).

## Working notes for the assistant
- The user plays MM under Wine on Linux (CachyOS). They test in game and report back, so give them concrete things to check.
- Never overwrite the user's own saves. Write new `SaveLeague Test N.sav` files.
- Git: initial commit `dc4d371` on `master` (2026-09-30). Commit only when the user asks.
