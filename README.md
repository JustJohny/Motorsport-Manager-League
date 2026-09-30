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
| `apply <save> changes.json -o out.sav` | Apply member decisions and write a **new** save (never overwrites the input) |
| `diff <a.sav> <b.sav> --team NAME` | Structural diff, for reverse-engineering what the game changes |
| `validate <save>` | Check the object graph (duplicate ids, dangling or forward refs) |
| `decode` / `encode` | Unpack to or repack from `header.json` + `data.json` for hand edits |

## Changes (`changes.json`)
See `examples/changes.example.json`. Operations:
- `setBuilding {team, building, level}`: 0 means not built. Otherwise it's the in-game level. It warns if prerequisites aren't met.
- `setBudget {team, amount, reason?}`: also logs a transaction in the in-game finance screen.
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
- `npm run dev` in `site/` without Supabase settings runs a demo on a local extract. See `site/README.md`.

## Organizer workflow (proposed)
1. The league runs in one championship. Each member owns an existing team (`league.json`), and the organizer's own career team can be any of them.
2. **Between races**, save while in the HQ (not during a session) and run `extract`. The site shows members their team, the staff market and HQ.
3. Members make decisions on the site, which produces `changes.json`. Use `syncTeam` for each member team, plus individual ops for new parts and hires.
4. Run `apply`, then load `… (league).sav` in MM and play the race weekend. Member teams race with AI strategy but with the cars, staff and HQ the members chose.
5. Save after the race and run `extract` again. The site imports the standings and `lastRace` results.

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
- Next: set up Supabase, Discord and Pages for real, then the staff auction.
