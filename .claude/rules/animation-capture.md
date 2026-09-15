---
paths:
  - "lib/animation-capture.js"
  - "lib/animation-capture/**"
  - "test/capture-animations.test.js"
---

# Animation capture

Two halves: `lib/animation-capture.js` (host side, driven by the `capture_animations` MCP tool) and `lib/animation-capture/animation-capture.cs` (in-game script). The host side loads a level, swaps the bro, runs the script, waits for its `done`/`error` sentinel, and writes `states.json` and `report.md` (the comparison against the state list) into `out`. The in-game script writes one PNG strip per state (frames left to right), `capture.json` recording the sheet cell each frame addressed, and the sentinel into `gameOut` — the same directory, named the way the game's filesystem sees it.

## Running a sweep

`capture_animations` is the tool; it runs on the server's own client, so the sweep goes to whatever target the server is pointed at.

```json
{ "level": "1:0", "bro": "Drunken Broster", "out": "/tmp/capture" }
```

- `out` is the absolute directory the strips, `capture.json`, `states.json` and `report.md` land in. The prep step deletes every `.png` in it, so a directory that already holds files is only accepted when it holds a `states.json` from an earlier sweep; an empty or missing one is always fine.
- `level` (`"CAMPAIGN:LEVEL"`) loads a campaign level first and waits, up to `timeout`, for that player to spawn alive. A game sitting in the intro scene has no player and the bro swap fails against it. The campaign index must be one the game has (`list_campaigns` prints them); an out-of-range one loads some other campaign and then fails to find the level.
- `settle` (seconds, default 3, only used with `level`) waits after the level reports its player. The player goes live about a second before the world renders, and a sweep started in that gap captures nothing.
- `bro` swap: the tool snapshots the slot, calls `swap_bro`, then waits. Primary path — the reply names the slot's character after the swap; a name differing from the snapshot *is* the change, so the poll only waits for the slot to report a live character. Fallback — the reply carries no name to compare, so the poll waits for the slot to report a live character whose name differs from the snapshot. An empty slot beforehand means anything alive in it now counts as the swap.
- Neither branch matches against the requested name: `bro` speaks Swap Bros Mod display names, `game_state` reports GameObject names, and the two do not map (Rambro's object is `Rambo(Clone) [local]`, "Broffy the Vampire Slayer" is `Broffy`, "Mr. Anderbro" is `Nebro`). So a landed swap means the slot changed, not that it changed to the bro asked for — a failed BroMaker substitution leaving plain Rambro reads as landed.
- Reply name equal to the snapshot name means the slot already held that bro: no poll, the reply's `swap.alreadyHeld` says so, and the sweep runs on it as it is; `swapSettle` still sleeps.
- `swapTimeout` (seconds, default 15): if the slot never reports the change, the run fails without sweeping and writes no `report.md` and no `capture.json`, rather than strip whatever the slot holds.
- `swapSettle` (seconds, default 2, only used with `bro`) waits after the swap lands. `swap_bro` answers while the old character is still the one being drawn, and a sweep that freezes the clock there strips the wrong bro.
- `states` is an array of state lists in layer order (a single string is taken as one layer) and defaults to `base-states.json`. A relative name resolves under `lib/animation-capture/states/` and must stay inside it; an absolute path is used as given. Layers merge by name, later files winning: a same-name entry replaces the earlier one outright and keeps its position.
- `gameOut` is `out` as the game's filesystem sees it (default: `out`). Set it whenever the two path spaces differ — a Proton or WSL install — or the script writes its strips, `capture.json` and sentinel somewhere the tool never polls. The read side breaks first: the tool writes `states.json` under `out` and tells the script to read it under `gameOut`, so a wrong value surfaces as the script's `state file not found` error before any strip is missed.
- `allowSideEffects` lets swept animations fire their real specials and attacks. Without it, `UseSpecial`, `UsePockettedSpecial`, `PerformKnifeMeleeAttack` and `PerformPunchAttack` are patched out for the sweep, which also hides a sprite-sheet swap performed inside `UseSpecial`. Costs ammo and damages the level.
- `includeLethal` also sweeps the states marked `lethal`. Without it they are left out of the sweep and listed as excluded in the report.
- `timeout` (seconds, default 60) bounds the sweep, and with `level` the wait for that level's player as well; a full sweep takes about two seconds. `player` (0–3, default 0) is the player index captured. `box` is the world-unit half-size of the crop box, each strip cell being `2*box` px; unset, the script's own default of 24 applies.

With the defaults the worst case is about 80s without `level` — the swap timeout, the swap settle and the sentinel timeout in a row — and about 140s with it, since the level's player gets the same `timeout` to spawn.

The reply is a JSON object. `success` is true only when the sentinel was `done` and no state errored inside the sweep — a cell mismatch is a finding, not a failed run. `status` is `done`, `error`, `timeout` or `game-gone`; `message` carries the outcome's text (with the game log's `animation-capture` lines appended on a timeout) and is null on `done`. `report` is the Markdown, the same text `report.md` holds; `paths` names `out`, `report`, `capture` (null when the game wrote none) and `states`; `summary` carries the five counts the report's bullets do; `stateErrors` lists the messages from `capture.json`; `swap` is null with no `bro` and otherwise `{ requested, slot, alreadyHeld }`; `logTail` is the formatted tail on a timeout and null otherwise. `report.md` and `capture.json` land in `out` whether or not the caller is still waiting, so a client that gave up first can read them off disk.

A run that never reached the sweep — a state list that fails validation, a level that never reports its player, a swap that never lands, a script that fails to compile, a missing or unparsable state file — comes back as a tool error with no report, since there is nothing to report on.

A sweep is server state for its whole length: `launch_game`, `wait_for_game` and a second `capture_animations` are refused while one runs, and `stop_game` is the escape hatch — the sentinel wait watches the game process alongside the sentinel files and ends as `game-gone` within a poll. A server stopped mid-sweep unloads the script and restores the game speed on its way out, so an interrupted sweep does not leave the game frozen — unless that teardown overruns the wrapper's grace period.

A state that errors mid-sweep does not abort the run. Its pinned fields are restored, the record is filed with `skipped: "error: …"`, the message goes into `capture.json`'s `errors`, and the sweep moves on. The report lists it under Skipped with the message under Errors, and the reply's `success` is false. A state skipped because its `requires` flags do not hold is not an error. An `after` method that throws leaves the state captured and compared, but the message is filed on the record as `afterError` and pushed into `capture.json`'s `errors` — so it counts under "States that errored mid-sweep" in the report and makes `success` false.

## State lists

A state list names the animations to sweep, how to reach each one, and how many frames it has. `base-states.json` covers the animations `TestVanDammeAnim` and `BroBase` share — every animation a stock or BroMaker bro inherits. A per-bro list (`drunken-broster.json` is the worked example) carries only what differs: its own states plus any base entry it must restate.

The file is either a bare array of entries or an object with a `states` array. The object's other keys (`schema`, `name`, `source`, `note`) are documentation; nothing reads them.

Merge semantics: `states` is one entry per layer, base first. A later entry whose name already exists replaces that entry outright and keeps its position — restate the whole entry, never a patch over the base one. Restate a base entry whenever the bro overrides its dispatch: `special_new` on a bro whose `AnimateSpecial` steps `usingSpecialFrame` instead of `frame` needs its own entry, or the base one drives a field the animation never reads. New entries append unless they name `insert_before`.

The `setup` below is abridged; the real entry in `base-states.json` pins every field its `note` names.

```json
{
  "name": "running",
  "requires": { "useNewFrames": true },
  "setup": { "actionState": "Running", "ducking": false, "dashing": false, "health": 3 },
  "step": { "field": "frame", "values": [0, 1, 2, 3, 4, 5, 6, 7] },
  "expect": { "sheet": "main", "row": 2, "cols": [0, 7] },
  "note": "ChangeFrame :4075-4078 -> AnimateRunning :3522; the else arm :3570-3596 needs !throwingHeldObject, !doingMelee, !releasingHighFive, no usingSpecial*, pushingTime <= 0, rollingTime <= 0 and rollingFrames <= 0. useNewFrames then routes to AnimateActualNewRunningFrames :3719-3740 (frame % 8, row 2 while !dashing). Footstep sound and poof effect fire at frame % 4 == 0."
}
```

- **`name`** — required, unique. Names the strip file (`running.png`) and the report entry.
- **`setup`** — fields pinned on the character to steer `ChangeFrame` to this animation. Values are booleans, integers, floats, or an enum member name as a string. Field names resolve against the character and its base classes; `frame` and `actionState` are properties over `_frame` and `_actionState` and resolve to those. Every field touched is snapshotted and restored when the state ends, so name a field here even when it only needs restoring — an animation that writes `yI` or sets a flag on its last frame must list that field or the change outlives the state.
- **`before`** / **`after`** — optional lists of parameterless instance methods called on the character, for states reachable only by having it swap an object reference for itself. `before` runs once, after `setup` is pinned and before the first step; `after` when the state ends, after the pinned fields are restored and on any error teardown, so a failed state never leaves the character switched. Give the two together. Names resolve against the character and its base classes at any visibility; one that does not resolve, one that takes parameters, or an exception out of a `before` call errors the state the way an unknown `setup` field does. Example: `running_holding_item` in `drunken-broster.json` uses `before: ["SwitchToHeldItem"]`, `after: ["ClearHeldItem"]`.
- **`insert_before`** — optional, on a layer entry: place the new state ahead of the named one instead of appending, for a state whose setup a later state would spoil. The named state must already be in the merged list when this entry is processed — layers merge in `states` order, so naming a state only a later layer supplies is a forward reference and fails the run with a usage error. Ignored when the entry restates a state already present — a restated entry keeps its position.
- **`step`** — the field the frames are driven with and the values to drive it through. `field` defaults to `frame`; countdown-driven animations name their own counter (`chimneyFlipFrames`, `rollingFrames`, `ladderClimbingTransitionFrames`, `flexSpecialFrame`, `inseminatedCounter`). `setup` is re-applied before each value, so an animation that clears its own driving flag partway through still runs its full span.
- **`expect`** — the sprite-sheet cells this animation should address: `row`, an inclusive `cols` range, and a `sheet` label. `row` and `col` are the sprite's `lowerLeftPixel` floor-divided by its own cell size — `row = floor(lowerLeftPixel.y / cellHeight)`, `col = floor(lowerLeftPixel.x / cellWidth)` — with no offset applied on either side: `capture.json` records exactly those numbers and the report prints them unchanged, so take a new state's values off a capture run rather than deriving them. The tool flags a state that lands elsewhere. `step.values` count must equal the column span, or the entry has no well-formed walk and nothing can match it. `sheet` is a display label only — the comparison is on `row` and `col` alone, so a state walking the right cells of a *different* texture still reports ✓. Texture identity is never checked: read `texture`, `texId` and `texW`/`texH` off the cells in `capture.json` by hand when a sheet swap is the point.
- **`expectGun`** — optional, same shape over the gun overlay, sheet defaulting to `gun`. A state stating both matches only when both walks do; this is the only real check on a state whose body row is the one it would address anyway.
- **`requires`** — layout flags that must hold on the live character for the animation to be meaningful (`useNewFrames`, `canAirdash`). Read off the character; when they do not hold the state is recorded as skipped with the flag and its actual value. Not an error — it means this bro does not use that variant.
- **`knownMismatch`** — optional reason the state addresses less than its full `expect` span, for one-shots that clear their own flag on the last frame and re-enter `ChangeFrame`, overwriting the cell before the harness reads it. It excuses only the *last* step: every earlier step must still walk the expected columns in order, or the tool reports a real mismatch with the reason attached as a footnote. The check is on the ordered `(row, col)` walk, one column per step, so the same columns out of order or with a step repeated is a real mismatch too. It is ignored outright in two cases: when the state also states `expectGun` and the gun walk failed (a body-side excuse cannot cover a gun that went elsewhere), and on a single-column `expect` span (one step is all terminal, so nothing is left to vouch for it).
- **`lethal`** — optional, `true` when entering the state kills or respawns the live player, with `lethalReason` saying why. The game's `Update` keeps running while the sweep holds the clock at 0, so `actionState: Dead` with `health: 0` is a real death, not a pose. Excluded from the sweep unless `includeLethal`.
- **`note`** — where the dispatch and cell arithmetic live in the decompiled source, plus the state's known limitations (a step that fires a real attack, one that self-cancels). Bare `:NNNN` line references are `TestVanDammeAnim.cs`; other files are named. A state whose point is a sheet swap inside `UseSpecial` should say so and be run with `allowSideEffects`.

## Unreachable states

An animation needing an object reference the character can install itself is reachable: name the method in `before` and its reverse in `after`. `unsupported` is for the rest — an animation needing a reference only the world can supply, a collider in the level, or a position delta the harness cannot express. Such an entry carries an `unsupported` reason instead of `setup`/`step`:

```json
{
  "name": "zipline_moving",
  "unsupported": "needs a live ZipLine reference",
  "note": "AnimateJumping :3145-3148 dispatches on attachedToZipline != null -> AnimateZipline :3226"
}
```

Keep these in the file so the tool reports them instead of leaving a silent hole in the coverage.

One class of cell no entry can cover. `ChangeFrame` is not the only thing that writes sprite cells: `SetGunSprite` (`TestVanDammeAnim.cs:9245-9263`) chooses the hanging gun columns from the live `actionState` — `Hanging`, `ClimbingLadder` with `hangingOneArmed`, or `Jumping` while attached to a zipline — and runs from `RunGun` (`:9230-9243`), which the per-frame update chain calls at `:1350`. The movement code ahead of it has already reset `actionState`, so a value a state list pins never survives to the point that reads it, and calling `ChangeFrame()` does not go near the branch. Those cells need a single `execute_code` call that sets the fields and invokes the animator in the same call, with nothing running in between — not a state entry.

## In-game capture

`animation-capture.cs` does not read the backbuffer: `ReadPixels` off the screen comes back as zeroed memory for seconds after a level load and whenever the window is not being presented. Each step points every camera that draws to the screen at one `RenderTexture`, in depth order, renders them itself, and reads the crop back from that. As a backstop, a state whose crop was inside the screen and still read back all-zero is recorded as a `blank capture` error rather than passing as a strip of empty cells.

It resolves the player's character up front, so a player with no character fails the script at startup rather than part way through a sweep.
