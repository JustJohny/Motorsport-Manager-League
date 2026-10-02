# Motorsport Manager 1.53 save format — research notes

Findings from decoding real saves (game 1.53.16967). They're verified by the round-trip tests in `test/`.

## Container
| Offset | Type | Meaning |
|---|---|---|
| 0 | 4 bytes | magic `mm2s` |
| 4 | int32 LE | format version (4) |
| 8 | int32 | header block, compressed length |
| 12 | int32 | header block, raw length |
| 16 | int32 | data block, compressed length |
| 20 | int32 | data block, raw length |
| 24 | bytes | header: raw **LZ4 block** (no frame) → JSON (save info, team name/colours, ~9 KB) |
| … | bytes | data: raw LZ4 block → JSON (whole game state, ~20–30 MB) |

No checksum was seen. The game loads files whose compressed bytes differ from its own, as long as the JSON is the same.

## JSON dialect (FullSerializer)
- Compact, with no whitespace.
- Floats always carry a decimal point (`1.0`) or exponent (`1E-05`).
- Bare `NaN`, `Infinity` and `-Infinity` tokens appear.
- String **values** escape every char outside ASCII 32–126 as `\uXXXX` (lowercase). Object **keys** are written raw (e.g. `"André Zoom":{…}` in relationship dictionaries).
- `$id` marks an object's first appearance. Later appearances are `{"$ref":"<id>"}`. **A `$ref` must never come before its `$id` in document order.** 0 of 109k refs in real saves do, and FullSerializer resolves refs in one pass. `Graph.normalizeRefOrder()` restores this after edits.
- Lists that are shared are wrapped: `{"$content":[…],"$id":"…"}`.
- `$type` appears **only** when the runtime type differs from the declared type of the field it's written in (`EnginePart`, `Engineer`, `Mechanic`…). Drivers usually have none, because they're first written in `List<Driver>`.
  - **Pitfall (this broke the first in-game test):** if an edit moves an object's definition into a field of a different declared type, the game builds the wrong class and fails with `ArgumentException: failed to convert parameters` from `fsIEnumerableConverter`.
  - Example: moving a driver into `EmployeeSlot.personHired`, which is declared as `Person`.
  - Fix: `schema/mm-1.53.json` lists the declared type of every serialized field. It's generated from `Assembly-CSharp.dll` with `tools/gen-schema.ts`, which needs `monodis`. On load, `Types.record()` notes each object's real type. Before writing, `Types.annotate()` adds `$type` wherever a moved definition needs it.
  - The schema types all ~18k objects in every tested save, with no contradictions.

## Where things live (data JSON)
- `time.mNow` is the current game date.
- `teamManager.mEntities[]`: 82 teams. Useful fields: `teamID`, `name`, `id` (GUID), `championship`, `player.mPlayerTeam` (the human team).
  - **Team names** (`renameTeam`): `name` (full) and `mShortName` (standings/timing; `GetShortName` falls back to `name` when it is empty or the team is player-created). MM copies them from its database only in the `Team` constructor at career creation, so the save is the only copy afterwards; everything else references the team object. `customLogo.teamFirstName`/`teamLasttName` are only used by player-created teams. Engine suppliers have their own `name` (e.g. "Steinmann") in `supplierManager.engineSuppliers`.
  - **Team countries** (`setTeamCountry`): `nationality` is a ref to a shared country object (the flag). `locationID` is a country text ID (`mCountryID`, e.g. "PSG_10000948" = Germany), shown as the location on the HQ screen (`Headquarters` UI `Setup`) and team details.
- **Engine suppliers:** `supplierManager.engineSuppliers` holds a separate copy of each make per tier, with ids 0–20, 1000–1021, 2000… (the F1 ones are 0–4). Both cars' `chassisStats.supplierEngine` refs pick one. `supplierStats` keys 2/3 add to the chassis `mFuelEfficiency`/`mImprovability` (`ApplySupplierStats`). `mRandomEngineLevelModifier` is added to engine part stats only when next year's design completes, so a mid-season swap leaves engine parts alone. `teamDiscounts` (works deals) is `[{Key: teamID, Value: 50.0}]`, or `{}` when empty. `Car.mCachedStats` is rebuilt from parts on every `GetStats`.
  - `financeController.finance.currentBudget`, plus `transactionHistory.transactions[]`.
  - `headquarters.hqBuildings[15]`: `currentLevel` (0-based), `state` (0 NotBuilt, 1 BuildingInProgress, 2 Constructed, 3 Upgrading), `normalizedProgress`, `mStaffNumber`, `mDateProgressStarted/End`. The `info` object holds `name`, `type`, `maxLevel` (0-based), `workerCapacity[]`, `upgradeCost[]` and `dependencies[{buildingType, requiredLevel}]`.
  - `carManager.partInventory.<type>Inventory` holds the parts.
    - Part fields: `$type`, `name`, `id`, `isFitted`, `fittedCar`, `components[]`, and `mStats{level, mStat, mPerformance, maxPerformance, mReliability, maxReliability, rulesRisk, partCondition{mCondition…}}`.
    - Part-type index order: Brakes, Engine, FrontWing, Gearbox, RearWing, Suspension, then the GT and GET variants.
  - `carManager.mCar[2]` holds the cars. `mCurrentPart[17]` is indexed by part type, and `mPartsFittedToCar[]` lists the fitted parts.
  - `contractManager.mEmployeeSlots[13]` entries are `{jobType, personHired, slotID}`. Job types: 0 Driver, 3 EngineerLead, 4 Assistant, 5 TeamPrincipal, 6 Scout, 7 Mechanic, 8 Chairman. The team-level `mEmployeeSlots` are the same slot objects as the six driver slots.
  - Caches that point at people: `contractManager.mCachedPeople`, `mMechanics`, `mSelectedSessionDrivers`, `mVehicleSessionDrivers`, `teamAIController.mDrivers`, and `carManager.partImprovement.mechanicOnPerformance/Reliability`.
- `driverManager` / `engineerManager` / `mechanicManager.mEntities[]` hold everyone. Each person has a `contract`:
  - Fields: `employeer`, `mEmployeerTeam`, `job`, `mContractStatus` (1 OnGoing, 3 Terminated), `yearlyWages`, `startDate`, `mEndDate`, `mCurrentStatus` (driver 1/2/reserve).
  - **Free agent** = `employeer: null`, `job: 18`, `mContractStatus: 3`.
- Championship (`team.championship`):
  - `mName` (e.g. "European Racing Series") and `mEventNumber`.
  - `calendar[]` events have `eventDate`, `circuit`, `mHasEventEnded`, and `results.{qualifyingSessions,raceSessions}[0].resultData[]` (position, driver, team, grid, time, points…).
  - `standings.mDrivers/mTeams[]` rows have `mEntity`, `mCurrentPosition`, per-race arrays `mPoints[]` (cumulative), `mRacePositions[]`, and so on.

## Hiring pitfalls found in game
- **Mechanic–driver relationships:** each mechanic has `mDictDriversRelationships` and `mDictRelationshipModificationHistory`, keyed by the driver's `name`. Free agents have empty dicts.
- **Person names** (`renamePerson`): `mFirstName`, `mLastName`, `mShortName` ("L. Hamilton"), `mThreeLetterName` (MM writes "Ham", not "HAM") and `name`. `name` isn't always first + last ("Rick de Graaf" vs `mLastName` "De Graaf"). A driver's `name` is also the key in every mechanic's two relationship dicts, and the contract-end event text spells it out. The only other copy is a challenge-mode objective (`mDriverName`), which career saves don't use.
  - `nationality` is a shared `{mCountryKey, mCountryID, mNationalityID}` object, so a rename can only use countries already in the save (no Monaco in the WMC test save). Its definition can sit inside one person, so changing that person's ref orphans it until `normalizeRefOrder` pulls it back in from `byId`. Look nationalities up in `byId`, not by walking the tree.
  - **Countries MM knows but the save lacks** (Monaco) can be added: MM's localisation (`resources.assets`) has a "Country" and a "Nationality" row per country key, e.g. Monaco = `PSG_10000999` / `PSG_10001195`, continent 2 (Europe). `GAME_COUNTRIES` in `src/ops/people.ts` holds them; `nationality()` creates the shared object on first use. Macau has no country row, so it can't be used. Not yet seen in game: whether Monaco's flag shows.
  - Free agents have no slot: `renamePerson` takes `person` (current full name or GUID) instead of team + slot.
  - Portrait indices have the same ranges for both genders. On a gender change the op borrows a portrait from someone of the new gender.
  - MM's parody characters carry the real people's birth dates (Harry Chapman = Hamilton 1985-01-07, Paddy Lock = Paddy Lowe, Charlotte Windsor = Claire Williams), which shows what each MM team stands for: Kitano = McLaren, Vélan = Sauber, Thornton = Lotus/Renault.
  - The game fills them on every hire (`Mechanic.SetDefaultDriverRelationship`: 0 weeks, 0 relationship, `relationshipAmountAfterDecay: -1`).
  - If they're missing, the game crashes with a NullReferenceException in `Mechanic.GetModifiedRelationshipWithDriver` when practice starts.
  - `hire` now creates them for every mechanic × driver pair on the affected teams.
- **Career history:** `careerHistory.mCareer[]` must end with an open entry for the current team.
  - The entry has `team`, `championship`, `year`, zeroed stats, `mIsFinished: false`, `mEndDate` = null date and `mStartDate`.
  - Most free agents have an empty list. After each session the game calls `currentEntry.IncreaseStat` for non-driver, non-mechanic staff, so an empty list crashes in `Team.IncreaseStaffHistoryStat` when qualifying ends.
  - `hire` closes the previous entry and opens a new one. `release` closes it.
- **Contract end event:** every running contract has `contract.mCalendarEvent`. It sits in `calendar.mDelayedEvents`, which is sorted by `triggerDate`, and has `OnEventTrigger {targets: [contract], methodNames: ["ContractEndDateReached"]}`, a `ContractDisplayEffect` and localized "Contract ending with …" text.
  - `hire` re-aims or clones one for the new person and inserts it in date order. `release` removes it.
- **Objects without `$id`:** FullSerializer only gives an object an `$id` if something else references it (171 contracts have none). `Graph.ref()` assigns one on first reference.
  - Some free agents keep a stale inline event with no `$id`. Putting that same object in a second place without an id would serialize it as two separate copies.
- The game's own hire path is `ContractManagerTeam.HireNewPerson`/`HireNewDriver`. It also does `PartImprovement.AssignChiefMechanics`, `AIPitCrew.RegenerateTaskStats`, `Team.SelectMainDriversForSession` and `DriverManager.AddDriverToChampionship`. Check these first if another hire-related crash shows up.

- **Swap cache update must stay inside the team.** After a swap, `hire` rewrites the team's cached person lists (`mCachedPeople`, `mMechanics`, session drivers, AI drivers, `partImprovement`). These reach other teams through references, e.g. `carManager.partImprovement.mTeam.rivalTeam`. Following those rewrote the *other* team's seat, which left a person in two seats and the released person in none. `replaceRefs` now never follows a reference into a team, or into a person employed elsewhere. `test/ops.test.ts` swaps with a rival team and checks that every person holds exactly one seat.
- **Inline definitions in caches.** A person's `$id` definition can sit inline in another team's mechanic `mRelationshipDriversCache`. Replacing it with a `$ref` is safe, because `normalizeRefOrder` moves the definition to the first remaining reference on write.

## HQ construction (from Assembly-CSharp)
- **Display names differ from the save.** `info.name` holds MM's older internal names; the HQ screen shows the localised `nameID` strings (`resources.assets`, "Headquarters Screen" table). Type 10 "Logistics Centre" is the game's **Forecasting Centre**, 9 "Staff Housing" is the **Staff Centre**, 6 is the **Brakes R&D Facility**, 7 "Ride Handling Development" is the **Handling Development Centre**. The save's descriptions are outdated too. `src/hq-info.ts` holds the UI names, descriptions and effects; the toolkit still keys buildings by the save's names (equalize, `setBuilding`).
- **Times are in weeks.** `HQsBuilding_v1.BeginBuilding`: `mDateProgressEnd = now + info.buildTime × 7` days, `state = 1` (BuildingInProgress). `BeginUpgrade`: `now + info.upgradeTime[currentLevel] × 7`, `state = 3` (Upgrading). A save confirms it: Tatra's Factory upgrade, `upgradeTime[0] = 34`, runs 238 days. So builds take 10–116 weeks, 3–29 races.
- **The game completes buildings itself.** `Team.Update → Team.UpdateHeadquarters → HQsBuilding.UpdateProgress` recomputes `normalizedProgress` from the start and end dates, then calls `Build` / `UpgradeBuilding` at 1.0. Setting the state and dates is enough; `currentLevel` stays until completion.
- **Calendar event.** `GenerateCalendarEvent` adds a `CalendarEvent_v1` (category 2048, `OnEventTrigger` = the building's `UpdateProgress`, `OnButtonClick` = `ChangeScreenCommand` "HeadquartersScreen" with `focusEntity` = building, `TeamDisplayEffect.team`). `showOnCalendar` and `interruptGameTime` are true only for the player's team. The text IDs are `PSG_10009159` "Built X" and `PSG_10009160` "Upgraded X". Building display names are localized from `nameID` and aren't stored in the save, so `startBuilding` copies the text from an event for the same building type.
- **The AI pays upfront.** AI teams get an expense transaction of the full price the day they start, e.g. "Test Track - Build" $8M or "Handling Development Centre Level 2 - Upgrade" $8M. `cancelBuilding` refunds that amount (`initialCost`, or `upgradeCost[currentLevel]`), reverts `state` (1 → 0 NotBuilt, 3 → 2 Constructed), resets the progress and dates, and removes the building's `UpdateProgress` calendar events.
- **Cloning pitfall.** Cloning `{ ...template }` (a spread copy) loses the runtime type the schema tracker recorded for `template`, which fails `annotate` ("unknown runtime type") once the clone gets an `$id`. Copy the type over (`save.types.runtime.set(clone, runtime.get(template))`). Contract events in `hire` had the same latent bug; it's fixed now.

## Part design and improvement (from Assembly-CSharp, decompiled with ilspycmd)
Decompile a class to C# with `dotnet tool install --tool-path <dir> ilspycmd`, then `<dir>/ilspycmd -t CarPartDesign "<game>/MM_Data/Managed/Assembly-CSharp.dll" -r "<game>/MM_Data/Managed"`. This is far easier to read than `monodis` IL.

**Settings** live in `partSettingsManager.championshipPartSettings[championshipID][partType]` (`PartTypeSlotSettings`). ERS is championship 2. Part types: 0 Brakes, 1 Engine, 2 FrontWing, 3 Gearbox, 4 RearWing, 5 Suspension. Each type has:
- `materialsCost`: e.g. Engine $1.35M, Gearbox $900k, Brakes $450k.
- `buildTimeDays`: 16–25.
- `costPerLevel[5]` / `timePerLevel[5]` (`[0,2,3,4,5]`): what a component of that level adds when it has no own cost or time.
- `unlockRequirements[5]`: levels 1–2 are always open. Levels 3/4/5 need the part type's development building (`buildingType` 2–7) at `buildingLevel` 0/1/2.

**Spec parts can't be designed.** `championship.rules.specParts` lists part type indexes; in the ERS it is `[1, 3]` (Engine, Gearbox, supplied at level −1 and stat 150). The AI skips them too (`isSpecPart` in `TeamAIController`).

**One design at a time per team.** `carManager.carPartDesign` holds a single `mCarPart` and `mStage` (0 Idle, 1 Designing). There is no queue.

**Components.** `carPartDesign.<type>Components` is a `Dictionary<level-1, List<CarPartComponent>>`. Each season `ChooseComponentsForSeason` picks 3 random Stock/Risky components per level (1–5) for each team, so every team has its own list. The lead engineer adds one more per level (`engineer.availableComponents[level]`).
- Component fields: `id`, `level`, `componentType`, `statBoost`, `maxStatBoost`, `reliabilityBoost`, `maxReliabilityBoost`, `productionTime`, `cost`, `riskLevel`, `unlockRequirements`, `activationRequirements`, `mBonuses`, `mNameID` (localised, not in the save), and `mCustomComponentName` (a rich-text summary such as "Performance: +10 / Reliability: -15%").
- **Slots:** `GetNumberOfSlots` = the highest level of a part of that type in inventory + 1, clamped to 1..5. A component of level L fits a slot index ≥ L-1. Part level from the sum of component levels: ≥1 → 1, ≥3 → 2, ≥6 → 3, ≥10 → 4, ≥15 → 5.

**Stats** (`SetBaseStats` + `ApplyComponents`):
- Main stat = `seasonPartStartingStat[type]` (the best part's stat at season start) + floor(lead engineer `partContributionStats[statType]`) × 1.5, then component boosts × the team's `<part>DevelopmentRate` and a development variance from engineer skill. This build has extra development code, so let MM compute it.
- `maxPerformance` = the chassis' improvability.
- `maxReliability` = initial + (Design Centre level − 1) × 0.05 + engineer contribution × 0.02, ±0.1 random at `StartDesigning`.

**Cost.** For the player's team: `materialsCost` + the components' cost. AI teams pay only **10 % of `materialsCost`** + components. The AI path (`TeamAIController`, line ~713) charges a Debit transaction and then calls `StartDesigning()`.

**Time.** `buildTimeDays` + `designCentrePartDaysPerLevel[DC level]` + component times (`timePerLevel` only for a component in the last slot) − the player's `designPartTimeModifier`.

**Start and finish.** `StartDesigning` sets the stage, `startDate` and `endDate`, and adds a `CalendarEvent_v1` (category Design, `OnEventTrigger` = `PartComplete`). `PartComplete` clones `1 + mExtraCopies` parts into the inventory. For AI teams it then calls `teamAIController.FitPartsOnCars()`. `Cancel` (player UI) refunds half.

**Improvement** (`carManager.partImprovement`):
- `partsToImprove[1 = Reliability | 3 = Performance]`: lists of inventory parts. Any part in the inventory can be improved, not only fitted ones, unless it is banned or already at its max.
- **Slots per list = round(lerp(2, 8, Factory level / 3))**: 2/4/6/8 for Factory 0–3.
- `mechanics[stat]` is the split of the mechanics (`SplitMechanics(x)`: x = the share on Performance). Work happens on weekdays from 09:00 to 18:00.
- **Timing** (`PartImprovement.GetWorkRate`, `GetChiefMechanicWorkRate`, `GetWorkEndDate`; `src/part-improvement.ts`):
  - Per working day (9 h), a list gains: performance `8 × min(1, mechanics/40) + 1 × min(1, chief.performance/20)` points; reliability `0.12 × min(1, mechanics/40) + 0.01 × min(1, chief.reliability/20)`. The chiefs are `mechanicOnPerformance` / `mechanicOnReliability` (the two race mechanics).
  - The rate is shared out by what each part still lacks, so **every part in a list reaches its max at the same moment**: end = (sum of gaps / rate) working days, walked over weekdays 09:00–18:00 as `GetTotalSecondsToEndDate` does. Matches MM's own `partWorkEndDate` to within seconds for every team in three saves (`test/improvement.test.ts`).
  - With parts in only one list, MM moves all mechanics to it (`UpdateMechanicsDistribution`).
- The AI (`TeamAIController` ~734–804) refills both lists and the split by itself, and `FitPartsOnCars()` refits after every part it builds.

## Next year's car and suppliers (from Assembly-CSharp)
- MM designs next year's car only at pre-season: `NextYearCarDesign.state` is WaitingForDesign (1) during the season, Designing (0) once the AI's `HandleCarNewChassis` has picked suppliers and called `StartDesign`, and Complete (2) when built. There's no mid-season supplier choice in MM; the league's window is its own rule.
- Pre-season straddles New Year: the ERS 2016 championship has `currentSeasonEndDate` 2016-12-06, `currentPreSeasonStartDate` 2016-12-13 and `currentPreSeasonEndDate` 2017-03-05. The season a car is for is the year of `currentPreSeasonEndDate`, not the game date's year. (Not yet seen: when MM moves these dates on to the next season.)
- `supplierStats` keys are `CarChassisStats.Stats` (0 tyre wear, 1 tyre heating, 2 fuel efficiency, 3 improvability, 4 starting charge, 5 harvest efficiency). They're ratings, so higher is better: the dearest deals have the most tyre wear. Keys 4 and 5 are 0 outside hybrid series.
- **MM's offer list:** `supplierManager.championshipSuppliers` (championshipID → SupplierType → deals) is drawn by `DetermineNewSeasonSuppliers` at `Championship.OnChampionshipPromotionsEnd` (after the final race), seeded per championship (`championshipSeed`), with `GetDesiredSupplierCount` deals per type: 4 by default, 6 brakes, 5 fuel (6/5 for the energy types). `NegotiateChampionshipSuppliers` runs at `OnPreSeasonStart`. `GetSuppliersForTeam` = that list filtered by `CanTeamBuyThis`. It's `{}` in every mid-season save seen so far; **its populated JSON shape hasn't been seen yet** (`drawnSuppliers` accepts `[{Key, Value}]` or an object keyed by number or type name).
- One supplier has many deals with the same name (all 15 ERS brakes deals are "Micronix Racing"), each with its own id, stats and price. Engine deals have `minEngineLevelModifier` = `maxEngineLevelModifier` (already rolled), so their level is one number.

## Pit crew (pit crew pack, from Assembly-CSharp via `monodis`)
- `Team.pitCrewController` (`PitCrewController`): `mPitCrewTeamMembers`, `mPitCrewApplicationManager`, `mAIPitCrew`, `mPitStopLogs`, `mCurrentPitCrewFunding` (0 Low, 1 Medium, 2 High), `mPitCrewAutomanaging`.
- **Only the player's team has crew people.** `PitCrewController.Start`: `Team.IsPlayersTeam()` gets a `PitCrewApplicationManager` (and members); every other team gets an `AIPitCrew` and no members.
- `AIPitCrew.carOneTaskStats` / `carTwoTaskStats`: 7 `AIPitCrewTaskStat {taskType, taskStat, taskConfidence}`, indexed by `SessionSetupChangeEntry.Target` (0 Fuel, 1 Tyres, 2 PartsRepair, 3 FrontJack, 4 RearJack, 5 BatteryRecharge, 6 Driver). `RandomizeTaskStats` sets every `taskStat` to the car's mechanic `stats.pitStops` and `taskConfidence` to Random(0.75, 1); `OnRaceWeekendEnd` calls `RegenerateTaskStats` for AI teams. `PitstopTasksManagingHelper.AddPitStopTask` uses `GetTaskStat` for AI teams (Tyres = 4 tasks with the same stat). The league writes these with `setPitCrew` before each race.
- `PitCrewMember` (a `Person`): `mPitCrewRole` (0 FrontJack, 1 RearJack, 2-5 wheels FL/FR/RL/RR, 6-7 fixing, 8-9 refuelling, 11 None = reserve), `mStats {mPitStats[5] (Tyres, FrontJack, RearJack, FixingParts, Refuelling), mConfidence, mMaxConfidence}`, `mMistakeLogs`, `mStatsLostPerRaceAfterPeak` (~1.1), contract `ContractPitCrew {mRacesLeft, yearlyWages (per race = /12), signOnFee}`.
- Positions per series (`IsPitCrewRoleAllowedInSeries`, `GetMaxPitCrewSizeNumber`): `ChampionshipRules.pitCrewSize` Small(0)/SemiSequential(2) = 6 (jacks + wheels); Large(1) = 8 (+ fixing), 10 with `isRefuelingOn`.
- Task → skill (`SessionPitstopTask.GetStatTypeBasedOnTarget`): Fuel and Battery → Refuelling, Tyres → Tyres, PartsRepair → FixingParts, jacks → their jack stat.
- Contracts: `SignContract` sets `mRacesLeft` = 2 x `Championship.eventCount` + 1; renewal (`RenewContract`) only when racesLeft < 12; `GetContractTerminationCost` = 0; at racesLeft 0 the member is fired (`FirePitCrewMember` removes the entity). Sign-on fee $45K (Tatra's transactions); wages $36K-$120K a year.
- `mPitStopLogs`: a `PitStopRaceLog[]` sized to the calendar, indexed by `Championship.eventNumber` (round - 1): `mFastestPitStop`, `mNumberOfPitstops`, `mNumberOfMistakes`, `mNumberOfCatastrophicMistakes`, `mCatastrophicFireHappened`, `mPitstopTimes[]`. Every team has it (AI teams too).
- `PitCrewDesignData` (funding costs and training rates, max crew size, peak ages, confidence losses) is game design data: not in the save, and not readable from the assets with UnityPy. The league's values are in `src/pit-crew.ts`.

## Verified in game (2026-09-30, save "League Test 2", player team)
- `setBuilding`: Wind Tunnel shown at level 1.
- `setBudget`: new budget shown, with our transaction note in the finance history.
- `addPart` + `fitPart`: a part with `mStat: 60` shows as a **60** front wing, fitted to the car. The part `name` (e.g. "F-LEAGUE") is **not shown anywhere in the UI**, so the site should identify parts by GUID and label them itself.
- `hire`: the new lead engineer and mechanic are shown, and the replaced staff are gone.
- Staff and driver changes on AI teams (Garuda/Octane) show in their team screens. The game doesn't show rival HQ, parts or budget.

- **Full cycle (League Test 2 → 3 → 4):** practice, qualifying and race played, then time advanced to the next race weekend. The game's own saves kept the budget (plus race income), Wind Tunnel 1, Scouting Facility 2, the spec-60 wing on car 2, and the new engineer and mechanic.
  - `mmsave diff` shows the game only changed normal gameplay state: standings, results, finances, and relationship growth of the new mechanic (0 → 9.6). None of our edits were reset.

## Open questions (verify in game with `mmsave diff`)
- Whether `mPerformance` (the improvement bonus) is shown separately from `mStat`, e.g. "60 +5".
- What the game itself changes when a driver is hired mid-season, e.g. whether it moves the old driver's standings row to `mInactiveDrivers`.
- How part `level` maps to design tiers.
- Whether HQ upkeep and staff costs recalculate on load after a building level is set directly.
- **Free-agent wage demands.** An unemployed person's contract is a placeholder: `yearlyWages` is mostly 100000 (0 for many young drivers), and `mEndDate` is unset. The real demand isn't stored either: `contractManager.desiredContractValues` (`mDesiredWages`, `mDesiredSignOnFee`, …) is all zeros in saves, because the game only fills it in during a negotiation. From `ContractDesiredValuesHelper::CalculateDesiredWage` in the DLL, the formula is:
  - `base` = `ContractVariablesContainer.GetBaseDesiredWageForPerson`, a wage-range curve by `PersonStats.GetAbility()` from game-database tables that aren't in the save;
  - plus, for drivers only, `desiredEarnings / (1e6 · seriesModifier)`;
  - then `base · (1 + lerp(-m, m, negotiationWeight)) + base · abilityPotential/5 · k`. The negotiation weight depends on the offering team.
  - **Decision:** don't reproduce it. The league sets its own minimum bid (the site is the source of truth, and `hire` writes any `yearlyWages`).
- **Qualifying results.** In `results.qualifyingSessions[0].resultData`, `position`, `time` and `bestLapTime` are 0 (seen after round 5 and round 6); only `gridPosition` is set. Lap times may be stored per session elsewhere. The website currently orders qualifying by grid slot.
- Driver `mPotential` ranges 0–92 while current stats are 0–20, and it is 0 for all staff. Its exact meaning (and whether the UI shows it as stars) is unverified.
- Whether an HQ construction started by the toolkit progresses and completes in game (the code says yes; not played yet).
- Engine and gearbox parts of teams on a supplier deal have `level: -1` and stat 150.

Research recipe: copy a save, make one change in game, save again, then run
`mmsave diff before.sav after.sav --team "Your Team"`.
