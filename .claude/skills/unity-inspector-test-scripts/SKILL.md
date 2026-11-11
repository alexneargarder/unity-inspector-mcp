---
name: unity-inspector-test-scripts
description: Procedure for writing and debugging the JSON test scripts that the unity-inspector-mcp server's run_test_script tool runs against Broforce through the Unity Inspector Mod. Use when writing, editing or reviewing a test script in scripts/tests/, when deciding whether to script a sequence of game tool calls instead of making them by hand, when checking a mod change in the game with a scenario script, and when a run_test_script run fails, hangs on an until step, leaves the game changed, or its results, report or logs need reading. Applies even when the user doesn't name the skill.
---

# Unity Inspector test scripts

Read the script format, every field and the reply's fields in [scripts/README.md](https://github.com/alexneargarder/unity-inspector-mcp/blob/master/scripts/README.md) before writing a script. Paths below are relative to the server checkout.

## Choosing to script

1. Run `list_test_scripts` and, for a mod change, read the README's "Scenarios for a Mod Change" table. When an existing script covers the case, run it with its `args` and go to Reading a run.
2. Write a script when the same game-side tool calls will run more than once, when a step must wait on game state, or when the game must be restored however the run ends. Otherwise call the tools by hand.
3. Save it in `scripts/tests/`, where `run_test_script` finds it by bare name; a script kept anywhere else runs by absolute path. An `execute_script` step names a library script in `scripts/csharp/` by name, or any C# file by absolute path.

## Writing a script

1. Open with steps that undo whatever an earlier failed run of this script left changed — a pause, the game speed, a joined player, a mod setting, a loaded script — each a no-op when nothing is left.
2. Give the first press `until` with an `expect`, so a run started on the loading screen waits the load out.
3. Take any record of what the run found (a value its last steps compare against or restore) on every run, never only when absent.
4. In a script that loads levels, poll after the restore steps until any load in progress has settled — the scene unchanged for 4 s, not `LoadingScreen`, and in a level, the level built and not moving on, as the third step of `scripts/tests/game-states.json` does — and only then record the level the run started in.
5. Wait for game state by polling with `until`, never with `wait`:
   - A `go_to_level` or `restart_level` step replies once a slot's bro is alive; the next step needs nothing in between. When a bro's once-only intro holds the game instead, the reply carries `cutscene: "CutscenePause"` and a `warning`. Give that step `"wait": 1500`, since the game ignores a skip in a cutscene's first second, then add a `simulate_input` `start` step and poll `game_state` with `until` for `"pauseState": "UnPaused"` and a live bro, as `scripts/tests/levels.json` does. On a level where the bro spawns straight in, the intro starts just after the reply, so the reply carries no `cutscene`. A script loading one with a bro whose intro hasn't played polls `game_state` with `until` for `"pauseState": "CutscenePause"` first, then waits and skips it the same way.
   - After any other load whose next steps need a level or a bro — a load started from `execute_code`, menu input — add:
     ```json
     { "command": "game_state", "until": { "timeout": 60, "interval": 1 }, "expect": { "contains": ["\"state\": \"alive\""] } }
     ```
   - Before pressing keys at the main menu, poll an `execute_code` step that returns the `MainMenu` object's `MenuActive` with `until` for `True` and give it `"wait": 500`, as `scripts/tests/game-states.json` does: the game ignores menu input for 3 s after the scene loads and for up to 0.3 s each time the menu becomes active.
   - Make every `until` timeout cover the first load after a launch, about 20 s.
   - Use `wait` only after a step whose effect no command can read back.
6. Give every step that can fail an `expect`. Without one a step fails only when its command throws or returns `success: false`, so an `execute_code` step whose returned text reports a failure still passes: return a fixed word on success and `expect` it with `contains`. A step that should fail gets `"success": false` and a `contains` naming the error. `contains` matches the result pretty-printed as the tool returns it, a space after each key's colon.
7. Repeat in `cleanup` every restore the steps make: settings, speed, pause, spawned objects, loaded scripts (`unload_script`, its `path` the `execute_script` step's `path` or an inline script's `name`), the run's records, and in a script that changes level, a reload of the level it started in. End `steps` with that same reload.
8. Set `continueOnFailure: true` only when the steps are independent checks and every failure should be listed.

## Reading a run

1. A script with a bad key, param, placeholder or arg runs nothing, and the reply's error names the problem: fix the script and rerun.
2. With `passed: false`, find the step in `results` or `cleanup` whose `passed` is false. Its `preview` is the start of its unmet expectations or its error; with `continueOnFailure`, `failures` lists every failed step. A `report` holding `"passed": false` fails the run too; a scenario report's `checks` entry with `passed: false` says why in its `detail`.
3. When the preview is `truncated` or the reply has `omitted`, read the step's full record in `resultsFile`. An `until` step's record carries `attempts`, and its result is the last attempt's.
4. Read `logs` for the errors, warnings and floods the game and the mods wrote during the run, by source. `cleanupSkipped` means the game is gone: read `crashLog` when present, relaunch with `launch_game`, and rerun.
5. When the reply adds a notice that the server's code changed on disk after it started, the server is older than its checkout and may refuse what the README allows: run `restart_server`, then rerun.
6. When the cause is still unclear, make the steps up to the failing one as tool calls by hand and inspect the state (`game_state`, `inspect_player`, `inspect_component`) before making the failing call. What a command does inside the game is in the [Unity Inspector Mod's source](https://github.com/alexneargarder/BroforceMods/tree/master/Unity%20Inspector%20Mod).
