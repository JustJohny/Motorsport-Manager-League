# Organizer checklist: one race cycle

Every race has two checkpoints, as in vanilla MM, where you fit new parts before the next race.

- **A. After the race:** members design parts, order HQ and bid. You apply it, then advance in MM to the next race weekend, so the parts get built.
- **B. Before the race:** members see their finished parts, fit them and pick improvements. You apply it, then play the race.

Members can do everything at both checkpoints. Run every command from the project folder (`~/Documents/MotorsportManagerEditor`).

## Save names

MM saves a game named "League R7 Post" as `SaveLeague R7 Post.sav`. `apply` writes its result next to it as `SaveLeague R7 Post (league).sav`, and that's the save you load in MM.

| Save it in MM as | When |
|---|---|
| `League R<n> Post` | right after race n, before advancing |
| `League R<n+1> Pre` | at the start of race weekend n+1, before practice |

The worked example below is the next real one: race 7 (Guildford) has been run, and race 8 is next.

## A. After the race

1. **In MM:** after the race, back at HQ (not in a session), save as **League R7 Post**.
2. **Publish it.**
   ```
   npx tsx src/cli.ts publish "SaveLeague R7 Post" --league league.json
   ```
3. **On the site (Organizer page):** if there's a transfer window this round, open it with a deadline before you plan to do step 5. Bids are only applied once the deadline has passed.
4. **Tell the members** they can act: design, HQ, bids, fitting, improvement.
5. **Pull their decisions** once you're ready, after the window deadline if there is one:
   ```
   npx tsx src/cli.ts pull -o changes.json --mark-applied
   ```
   Read what it prints:
   - designs and HQ orders, with their prices
   - fitting and improvement choices
   - transfer signings

   The first changes in the file undo what MM's AI did on member teams (HQ projects, part designs, parts it built). That's expected.
6. **Apply them to the same save you published:**
   ```
   npx tsx src/cli.ts apply "SaveLeague R7 Post" changes.json --name "League R7 Post (league)"
   ```
7. **In MM:** load **League R7 Post (league)**. Advance time until race weekend 8 starts, then stop before practice. Ordered parts finish on their own along the way. Save as **League R8 Pre**.

## B. Before the race

8. **Publish it.**
   ```
   npx tsx src/cli.ts publish "SaveLeague R8 Pre" --league league.json
   ```
9. **Tell the members** their new parts are in. They fit them (car 1 / car 2) and pick improvements. They can also order a new design, HQ or bids now; those start at this apply.
10. **Pull and apply:**
    ```
    npx tsx src/cli.ts pull -o changes.json --mark-applied
    npx tsx src/cli.ts apply "SaveLeague R8 Pre" changes.json --name "League R8 Pre (league)"
    ```
11. **In MM:** load **League R8 Pre (league)** and play practice, qualifying and the race. Then the next cycle starts at step 1 with **League R8 Post** and **League R9 Pre**.

## Rules that keep it working

- **Always apply to the save you just published.** The site's design options, parts and prices come from the published save. A different save can have other components or parts, and `apply` then stops with an error rather than guessing.
- **Don't play member teams yourself in MM** between apply and publish. Don't design, fit or build HQ for them, your own career team included. `pull` treats anything it didn't order as the AI's doing and undoes it with a refund.
- **Never apply to a `(league)` save twice.** A new apply always starts from a save you made in MM.
- `--mark-applied` marks orders and the transfer window done on the site. If `apply` fails after that, don't pull again. Fix the problem and apply the same `changes.json`.
- Your own saves are never overwritten. `apply` always writes a new `(league)` file.

## If something goes wrong

- **The game crashes or a save won't load:** the cause is at the end of `~/Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/MM_Data/output_log.txt`.
- **`apply` stops with an error:** nothing is written. The message names the change that failed, e.g. `Change #4 (startDesign): …`.
- **Members say their page is out of date:** check that you published the latest save. The site header shows the game date and publish time.
