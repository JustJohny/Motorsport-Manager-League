# MM League Toolkit

Read `HANDOFF.md` at the start of a session: it has the project goal, decisions, current status and next steps. Save-format details and pitfalls are in `docs/save-schema.md`; keep both files up to date as work progresses.

- Run `npm test` after changing anything in `src/`. The tests read the user's real saves from the Wine saves folder.
- Always write saves through `Save.write()`, which normalizes refs, adds `$type` and validates. Never overwrite the user's own saves.
- When the user reports a game failure, read `~/Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/MM_Data/output_log.txt` first.
