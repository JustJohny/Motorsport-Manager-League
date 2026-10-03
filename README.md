# MM League Toolkit

Tools for running a **Motorsport Manager 1** league the way F1 Manager 24 leagues run. Members make team decisions on a website between races. The organizer writes those decisions into a save, plays the race in MM, and sends the results back.

This first prototype is the **save toolkit**: a TypeScript library and CLI that reads MM saves, extracts league state as JSON for a website, and writes member decisions back into a save.

## Setup
```sh
npm install
npm test            # round-trips your saves byte-for-byte and exercises every operation
npx tsx src/cli.ts  # usage
```
Needs Node 22+. The CLI finds saves in `…/AppData/LocalLow/Playsport Games/Motorsport Manager/Cloud/Saves`, including the default Wine prefix on Linux. You can pass a bare save name.

## Commands
| Command | What it does |
|---|---|
| `teams <save>` | List teams by championship, with IDs |
| `extract <save> --league league.json -o state.json` | Site-ready JSON: every team in the league championship (budget, HQ, parts, staff), free-agent market, calendar, standings, last race results |
| `publish <save> --league league.json [--dry-run]` | Extract and upload to the league website (Supabase). Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env` (see `.env.example`) |
| `pull [-o changes.json] [--mark-applied] [--force]` | Members' decisions as changes, in this order: undo the AI on member teams (`cancelUnorderedHq`, `cancelUnorderedDesigns`, `removeUnorderedParts`), queued HQ orders (`startBuilding` + `adjustBudget`), queued part designs (`startDesign` + `adjustBudget`), every member's standing fitting and improvement (`setFitting`, `setImprovement`), and, once its deadline has passed, the transfer window's signings (`hire` + `adjustBudget`). `--mark-applied` marks orders and the window done |
| `apply <save> changes.json -o out.sav` | Apply member decisions and write a **new** save (never overwrites the input) |
| `diff <a.sav> <b.sav> --team NAME` | Structural diff, for reverse-engineering what the game changes |
| `validate <save>` | Check the object graph (duplicate ids, dangling or forward refs) |
| `decode` / `encode` | Unpack to or repack from `header.json` + `data.json` for hand edits |

## Terminal UI (`npm run tui`)
A full-screen dashboard for the organizer, run in the toolkit folder (Ink; plain Unicode symbols, so any font works; 100×28 or larger).
- **Race cycle:** where the series stands (checkpoint A after a race or B before the next), the selected save next to the website's latest snapshot, the race guide's steps, and members' queued decisions (a read-only pull, refreshed with `r`).
- `p` publishes the selected save after showing what goes up. `u` pulls members' decisions into a review by area (HQ, parts, crews, sponsors, window…) with the change counts; from there `a` applies them to a **new** save you name (it refuses names that exist), writes `changes-<series>.json`, and then asks whether to mark the decisions applied on the site.
- **Saves** (`2`): the Wine saves folder, newest first, with each save's game date. **Series** (`3`): the `league-*.json` files and their members.
- Keys: `Tab` menu/screen, `1`–`3` screens, `l` bigger log, `q` quit. The save browser, a command launcher and a save editor are planned (see HANDOFF.md).
- The CLI's publish, pull and apply live in `src/commands/` and are shared by both.

## Changes (`changes.json`)
See `examples/changes.example.json`. Operations:
- `setBuilding {team, building, level}`: 0 means not built. Otherwise it's the in-game level. It warns if prerequisites aren't met.
- `setBudget {team, amount, reason?}`: also logs a transaction in the in-game finance screen.
- `adjustBudget {team, delta, reason?}`: adds to or takes from the budget (e.g. `-250000`, "Sign-on fee: …"), logged the same way.
- `startBuilding {team, building, speed?}`: starts building (level 0 → 1) or upgrading, like MM's own HQ screen. MM's build time is in **weeks** (`buildTime` / `upgradeTime[level]` × 7 days), times `speed` (default 1). The game finishes it by itself. It doesn't charge anything (use `adjustBudget`).
- `cancelBuilding {team, building, refund?, reason?}`: stops a construction in progress and refunds the price MM charged when it started (the AI pays upfront too).
- `cancelUnorderedHq {teams, keep, since}`: cancels and refunds every construction on the listed teams that started after `since` and isn't in `keep`. `pull` always emits this first: the in-game AI also runs member teams between races and starts HQ projects with their money.
- `startDesign {team, type, components}`: starts designing a part the way MM's design screen does, from the team's own component list (component ids; engineer components open their extra slots). One design at a time per team, as in MM. MM's time rules apply, and the game builds the part with its own stats. It doesn't charge anything (use `adjustBudget`; the league charges MM's player price).
- `cancelDesign {team, refund?}`: stops the design in progress and refunds what MM charged (AI teams pay 10 % of materials).
- `cancelUnorderedDesigns {teams, keep, since}`: like `cancelUnorderedHq`, for part designs the AI started on member teams. `keep` lists ordered designs by type and components.
- `removeUnorderedParts {teams, keep, since}`: removes parts the AI designed *and finished* on member teams between checkpoints, and refunds them (once per design). A fitted one is first replaced on the car by the best spare part.
- `setFitting {team, fitting: [{car, type, part}]}`: re-applies a member's fitting; parts that are gone are skipped.
- `setImprovement {team, performance, reliability, split?}`: the parts (GUIDs) the mechanics improve, at most 2/4/6/8 per list for Factory level 0–3, plus the share of mechanics on performance (0..1).
- `setSuppliers {team, suppliers: {Engine?, Brakes?, Fuel?, Materials?, Battery?, ERSAdvanced?}}`: supplier ids for next year's car, replacing MM's AI picks once pre-season has started it. The pending chassis stats shift by the supplier-stat difference, the engine level modifier follows the engine, and the AI's payment is refunded for each new supplier's price.
- `addPart {team, type, stat, reliability, performance?, maxPerformance?, level?, name?, fitToCar?}`
- `fitPart {team, type, part, car}` and `removePart {team, type, part}`
- `hire {team, person, replacing | slotID, yearlyWages?, endDate?}`: works for drivers, lead engineers and mechanics. A free agent replaces someone, who is then released. Someone at another team **swaps** with the person they replace.
- `syncTeam {team, hq, parts, fitted, staff, budget}`: **site is the source of truth.** It forces a member team to match the site and undoes whatever the in-game AI did for that team between races.

People and parts are identified by the GUIDs in the `extract` output. Those GUIDs stay the same from one save to the next.

## League website (`site/`)
A Vite + React + shadcn/ui site on GitHub Pages, with Supabase for data and Discord login. v1 is read only: my team (staff, HQ, parts, budget), standings, calendar and results, all teams' line-ups, the staff market, and an organizer page.

- A league file (`league-<series>.json`, see `examples/league.json`) names its **series** and gives each member a `discord` username. The organizer gets `"organizer": true` and can see every team's private data.
- `mmsave publish` splits the extract into public data (standings, results, line-ups) and per-team private data (budget, HQ, parts). Row-level security in `supabase/migrations/001_init.sql` lets members read only their own team's private data.
- `src/league-types.ts` defines the data shapes. It has no imports, so the site uses it directly.
- `npm run dev` in `site/` without Supabase settings runs a demo on a local extract, including a local auction simulation. See `site/README.md`.

### Staff auction (transfer windows)
The organizer opens a window with a deadline on the Organizer page. Members nominate free agents or AI teams' staff from the Staff market. Nominating places the nominator's opening bid in the same dialog, all or nothing (`nominate`, migration 006). Everyone then bids live on the Transfer window page. Rules (enforced in `supabase/migrations/002_auctions.sql`, mirrored for display in `src/league-rules.ts`, tunable in the `league_settings` table):
- A bid is a yearly wage for 1–3 seasons and names who in the bidder's team it replaces. Bids beat the leader by 5%, and nobody can raise their own leading bid.
- Opening price = base per role × (stat average / 10)², at least $50K.
- Winners pay a 25% sign-on fee. AI teams' staff also cost a buyout, MM's own termination cost (the months of wage left, at most 6), and swap with the released person. They open at no less than their current wage. The opening-price formula's bases are calibrated to what MM's AI teams pay (migration 007).
- Everything a member's leading bids would cost (fees, buyouts, and the extra wages for the rest of this season) must fit in the budget.
- Bid amounts are public; who a team would release is visible only to that team and the organizer.

### HQ orders
Members order a new building or an upgrade on their HQ tab at any time, at MM's price. Rules are enforced in `supabase/migrations/003_hq_orders.sql`:
- The building can't already be under construction or have a queued order.
- Prerequisites must be finished.
- Queued orders plus leading bids must fit in the budget.

Projects the in-game AI starts on member teams are shown on the HQ tab as "AI project". `pull` cancels and refunds them first (`cancelUnorderedHq`, migration 004), so members can order that building themselves. Projects older than the league's first published game date are kept.

`pull` turns the queued orders into `startBuilding` + `adjustBudget`, so construction starts in game with MM's real build times (weeks; `league_settings.hq_speed` scales them) and MM completes it. There's no limit on parallel projects.

After the deadline: `mmsave pull -o changes.json --mark-applied`, then `mmsave apply <save> changes.json …`, and publish again after the race.

## Regulations
The Regulations page shows this season's and next season's rules and holds MM's rule votes on the site. Members vote with MM's vote power, and AI teams' votes are predicted with MM's logic (`src/politics.ts`) and published. At the checkpoint before a vote's game date, `pull` settles it with the league's result instead of MM's own vote (`concludeVote`). The organizer can set any rule group for next season (`setNextRule`, migration 008).

## Next season's suppliers
On Parts → Next season's car, members choose next year's engine, brakes, fuel and materials suppliers (battery and ERS too, in hybrid series) from the deals MM draws for the championship after the final race (about 4 engines, 6 brakes, 5 fuel and 4 materials deals), as MM's car design screen offers them, at MM's price for the team. The window opens when a published save has that draw (`src/supplier-rules.ts`). `mmsave suppliers <save> --league league.json` prints what a save would offer each member team, to check before publishing. No choice keeps this season's supplier if MM offers it again. Choices are private and stored against the season the car is for (migrations 010–012: `choose_supplier`, `clear_supplier_choice`). MM only designs next year's car at pre-season, so `pull` emits `setSuppliers` for member teams once their snapshot shows MM designing it, and repeats it on every pull until the car is built.

### Series: several saves on one site
Each series is one MM save (e.g. an open-wheel and an endurance league at the same time) with its own teams, members, snapshots, orders, bids, votes, engines and supplier choices. Members log in once and switch series at the top of the sidebar; one Discord account can run a different team in each series.
- The league file sets `"series": { "id": "endurance", "name": "Endurance league" }`; `publish` creates the series, and `publish` / `pull` / `archive` work on that series only.
- Database (migration 013): the league tables live in the `league` schema with a `series` column. The `public` views of the same names show the series in the request's `x-series` header (the site and the toolkit send it), so every database function is scoped to one series. Row-level security checks each row's own series, which keeps realtime (no headers) per series too.
- Ending a series: `mmsave archive --league <file>` writes a JSON backup of every row of the series; with `--end` it then deletes the series from the site (nothing of other series). `mmsave restore <backup.json>` puts it back while no series has its id.
- The league from before series existed is the series `main`: add `"series": { "id": "main", "name": "…" }` to its league file.

## Organizer workflow
Each race has two checkpoints (after the race, and just before the next one). The site's **Organizer page** walks through them step by step: it detects the current checkpoint from the published game date, fills in the save names, and has copyable commands, the rules that keep the cycle working, and what to do when something fails.

## Game schema
`schema/mm-1.53.json` holds the declared C# type of every serialized field, generated from the game's `Assembly-CSharp.dll`. The toolkit uses it to add the `$type` hints the game needs when edits move objects around (see `docs/save-schema.md`). To regenerate it for another game version:
```sh
npx tsx tools/gen-schema.ts "<game>/MM_Data/Managed/Assembly-CSharp.dll" schema/mm-1.53.json   # needs monodis (mono)
```

## Status
- ✅ The codec round-trips all tested saves byte-for-byte (JSON identical).
- ✅ All operations apply, validate, and survive a write and reload (`test/ops.test.ts`).
- ✅ Fixed the first in-game load failure (missing `$type` on moved objects). Every written save is now type-checked against the game schema.
- ✅ **Verified in game:** an applied save plays a full race weekend and advances to the next one. HQ, budget, parts and hires all persist through the game's own saves. See `docs/save-schema.md`.
- ✅ League website v1 (read only) builds and renders real save data in demo mode. Supabase RLS was tested locally in PGlite.
- ✅ Website deployed on GitHub Pages with Supabase and Discord login (verified by the user).
- ✅ Staff auction built: database rules tested in PGlite (`test/db.test.ts`), including pull → apply on a real save. The UI was checked in demo mode.
- ✅ Auction verified in game (a free-agent signing, and an AI driver bought out with a swap).
- ✅ HQ orders built: `startBuilding` op + migration 003 + site HQ tab, covered by tests on the real save.
- ✅ AI HQ projects on member teams are cancelled and refunded at apply (tested on the real save).
- Next: run migrations 003 + 004, publish again (the snapshot needs the new `buildWeeks`/`upgradeWeeks`/`progressStart`), and check in game that a started building progresses and completes.
