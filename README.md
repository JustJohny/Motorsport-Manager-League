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
- `addPart {team, type, stat, reliability, performance?, maxPerformance?, level?, name?, fitToCar?}`
- `fitPart {team, type, part, car}` and `removePart {team, type, part}`
- `hire {team, person, replacing | slotID, yearlyWages?, endDate?}`: works for drivers, lead engineers and mechanics. A free agent replaces someone, who is then released. Someone at another team **swaps** with the person they replace.
- `syncTeam {team, hq, parts, fitted, staff, budget}`: **site is the source of truth.** It forces a member team to match the site and undoes whatever the in-game AI did for that team between races.

People and parts are identified by the GUIDs in the `extract` output. Those GUIDs stay the same from one save to the next.

## League website (`site/`)
A Vite + React + shadcn/ui site on GitHub Pages, with Supabase for data and Discord login. v1 is read only: my team (staff, HQ, parts, budget), standings, calendar and results, all teams' line-ups, the staff market, and an organizer page.

- `league.json` gives each member a `discord` username. The organizer gets `"organizer": true` and can see every team's private data.
- `mmsave publish` splits the extract into public data (standings, results, line-ups) and per-team private data (budget, HQ, parts). Row-level security in `supabase/migrations/001_init.sql` lets members read only their own team's private data.
- `src/league-types.ts` defines the data shapes. It has no imports, so the site uses it directly.
- `npm run dev` in `site/` without Supabase settings runs a demo on a local extract, including a local auction simulation. See `site/README.md`.

### Staff auction (transfer windows)
The organizer opens a window with a deadline on the Organizer page. Members nominate free agents or AI teams' staff from the Staff market. Nominating places the nominator's opening bid in the same dialog, all or nothing (`nominate`, migration 006). Everyone then bids live on the Transfer window page. Rules (enforced in `supabase/migrations/002_auctions.sql`, mirrored for display in `src/league-rules.ts`, tunable in the `league_settings` table):
- A bid is a yearly wage for 1–3 seasons and names who in the bidder's team it replaces. Bids beat the leader by 5%, and nobody can raise their own leading bid.
- Opening price = base per role × (stat average / 10)², at least $50K.
- Winners pay a 25% sign-on fee. AI teams' staff also cost a buyout (the remaining contract value) and swap with the released person.
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
