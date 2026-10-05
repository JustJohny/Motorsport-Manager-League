# League game patch

A small patch to Motorsport Manager 1.53's game code for league races, applied with
`mmsave game-patch`. It's the only part of the toolkit that changes the game itself; everything else
edits saves or mod files.

**What it does:** when qualifying or the race goes green, the player team's cars (the team MM treats
as the player's, e.g. a spectator team) retire as if a part had failed, and drive to their garage.

**Why that way:** in MM, yellow flags, safety cars and VSCs come only from crashes and spins
(`CrashDirector.OnCrashIncident`, `AISpinBehaviour`). A retirement for parts (`AIRetiredBehaviour`,
reason `Parts`) sets no flag, and a car that's out of the race is never picked for a crash. A save
edit can't do this cleanly: zeroed parts only fail at MM's first condition tick (6-12% into a race),
and until then `CrashDirector.VehicleWillCrash` makes a car with a zero-condition engine, gearbox or
suspension crash for certain.

**How:**
- `LeaguePatch/` builds `LeaguePatch.dll` (net35, against the game's own `Assembly-CSharp.dll` and
  `UnityEngine.dll`) with `Hooks.OnSessionStart(SessionManager)`.
- `Patcher/` (Mono.Cecil) adds one call to it at the end of `SessionManager.StartSession()`, keeping
  the original as `Assembly-CSharp.dll.orig`. Every patch starts from that backup, so patching twice
  doesn't stack calls; `--restore` puts it back byte for byte.
- `MM_Data/league-patch.ini`, read at every session start: `retirePlayerTeam=true|false`. Turn it off
  for a series where the organizer races the career team.

```sh
npx tsx src/cli.ts game-patch --game "<game>/MM_Data"               # patch; retirePlayerTeam=true the first time
npx tsx src/cli.ts game-patch --game "<game>/MM_Data" --retire off  # keep the patch, switch it off
npx tsx src/cli.ts game-patch --game "<game>/MM_Data" --status
npx tsx src/cli.ts game-patch --game "<game>/MM_Data" --restore     # back to the original game
```

Needs the .NET SDK (`dotnet`). The hook logs "LeaguePatch: retired …" to `MM_Data/output_log.txt`.
