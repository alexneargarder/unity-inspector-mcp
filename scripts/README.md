# Test Scripts

`tests/` holds the JSON test scripts that automate Unity Inspector commands. Test scripts allow you to create repeatable test sequences for debugging and testing game behavior.

## Directory Structure

```
scripts/
├── README.md   # This file
├── csharp/     # The C# script library (see csharp/README.md)
└── tests/      # Every test script in the repo
```

A script outside the repo runs by absolute path, so there is no need to
copy your own scripts into this tree.

## Script Format

Test scripts are JSON files with the following structure:

```json
{
  "name": "Human-Readable Test Name",
  "description": "Detailed description of what this script tests",
  "steps": [
    {
      "command": "tool_name",
      "params": {
        "param1": "value1",
        "param2": "value2"
      },
      "wait": 1000
    }
  ]
}
```

### Fields

- **name** (required): Display name for the script
- **description** (optional): What the script tests or demonstrates
- **steps** (required): Array of commands to execute
- **cleanup** (optional): Steps with the same fields, run after `steps` whether they passed, failed or threw, unless the game is gone; a failed cleanup step fails the run without stopping the other cleanup steps
- **continueOnFailure** (optional): `true` records a failed step and moves on to the next one instead of stopping, unless the game is gone
- **args** (optional): Arguments the script takes, each `{ "default": <value>, "description": "..." }`; `run_test_script`'s `args` override the defaults, and `list_test_scripts` shows them. A given arg that is neither declared here nor named by a placeholder is an error before the script runs

A key the script format does not have, at the top level or in a step, is rejected before the script runs.

### Step Fields

- **command** (required): Name of a game-side Unity Inspector MCP tool. Server-side tools like `read_log` and `launch_game`, and a name that is no tool, are refused before the script runs
- **params** (optional): Object containing parameters for the command, named as the tool names its arguments; a key the tool does not take is rejected before the script runs. A `{{name}}` anywhere in a string, nested objects included, is replaced by that arg: a string that is only the placeholder takes the arg's own type, and a placeholder with no value is an error before the script runs. `execute_script` takes either `path` (a library script by name, `.cs` name, catalog display name or absolute path, sent to the game as source) or inline `source` with the `name` the script loads under. Flags behave as they do on the tool and are refused alike: `swap_bro` takes `nextSpawn`, `execute_script` takes `compileOnly`
- **wait** (optional): Milliseconds to wait after this step completes, a number from 0 to 2147483647
- **expect** (optional): Checks run against this step's result — `success` (boolean), `contains` and `notContains` (arrays of substrings matched against the result as it is returned). The step passes when every check holds, so a step that is expected to fail does not stop the script; an unmet check fails the step and stops it. An `expect` must carry at least one of the three, and neither array may be empty — an `expect` that checks nothing is rejected before the script runs
- **until** (optional, needs `expect`): `{ "timeout": <seconds>, "interval": <seconds, default 1> }` — re-send the step every `interval` until its `expect` holds or `timeout` passes; the step passes or fails on its last attempt, and its record carries `attempts`, with `duration` covering them all
- **report** (optional): `true` lifts the step's result — the JSON string `execute_code` returns, or an object — into the run's `report`; a string that does not parse fails the step

```json
{
  "command": "execute_code",
  "params": { "code": "object o = null; return o.ToString();" },
  "expect": { "success": false, "contains": ["NullReferenceException"] }
}
```

A script that arms a library script, polls it and collects its report:

```json
{
  "name": "Runner",
  "args": { "level": { "default": 0, "description": "Level index" } },
  "steps": [
    { "command": "execute_script", "params": { "path": "my-runner" } },
    { "command": "go_to_level", "params": { "campaignIndex": 1, "levelIndex": "{{level}}" } },
    { "command": "execute_code", "params": { "code": "return MyRunner.Phase;" },
      "until": { "timeout": 300, "interval": 2 }, "expect": { "contains": ["done"] } },
    { "command": "execute_code", "params": { "code": "return MyRunner.ReportJson;" }, "report": true }
  ],
  "cleanup": [ { "command": "unload_script", "params": { "name": "my-runner" } } ]
}
```

## Results

- **passed**: every step and cleanup step passed, and no report says `"passed": false`
- **resultsFile**: a JSON file holding the whole run, every step's full result included, named by script and time in a folder of the session's own under `$XDG_STATE_HOME/unity-inspector-mcp/test-results/` (`~/.local/state/...` when that is unset, `UNITY_INSPECTOR_TEST_RESULTS_DIR` to choose another), which keeps that session's newest 100 and is cleared a week after its last run; the reply itself carries only the fields below
- **results** / **cleanup**: one record per step that ran — `step`, `command`, `passed`, and a `preview`, the first 300 characters of its result or error, with `truncated` when cut; `cleanupSkipped` says why cleanup did not run or stopped (the game is gone)
- **omitted**: present when the reply would pass 40,000 characters, naming what was left out to fit, in this order: previews of passing steps, every preview, `logs`, the report's `events`, `stuck`, `survey` and any other field over 2,000 characters but `checks`, the whole `report`, then the per-step lists
- **report**: the lifted report, or an array of them when several steps carry `report`
- **failures** (with `continueOnFailure`): each failed step's number, command and first unmet expectation or error line, cleanup steps marked `cleanup`
- **logs**: what Unity's player log gained during the run (the UMM log when the player log gained nothing), grouped by source, with error and warning counts, sample lines, and floods (one line repeated 50 times or more); a log the game started over mid-run is read from its start and marked `rotated`, `overlappingRun` says another run on the same server overlapped this one, and `crashLog` carries the game's last output when it died

## Available Commands

You can use any game-side Unity Inspector MCP tool in your scripts:

### Level Control
- `go_to_level` - Load a specific level
- `list_campaigns` - List available campaigns

### Input Simulation
- `simulate_input` - Simulate controller input
  - Actions: up, down, left, right, fire, jump, special, highFive, gesture, sprint, start, escape
  - Supports duration (hold time), count (repeated presses), and sequence (ordered steps run back to back)

### Inspection
- `inspect_player` - Get player information
- `list_enemies` - List enemies in scene
- `list_gameobjects` - List GameObjects
- `inspect_gameobject` - Inspect specific GameObject
- `inspect_component` - Inspect specific component
- `query_gameobjects` - Search for GameObjects

### State Modification
- `teleport_player` - Move player to coordinates
- `set_player_health` - Set player health
- `set_game_speed` - Change time scale
- `modify_component` - Modify component properties

### Bros and Scripts
- `swap_bro` - Swap a player's bro, or with `nextSpawn` choose the bro they spawn as next
- `execute_script` - Run a C# script, or with `compileOnly` only compile it

### Utilities
- `take_screenshot` - Capture game screenshot
- `execute_code` - Execute C# code
- `ping` - Test connection

## Example Scripts

### Basic Movement Test

```json
{
  "name": "Movement Test",
  "description": "Test basic player movement and jumping",
  "steps": [
    {
      "command": "go_to_level",
      "params": { "campaignIndex": 0, "levelIndex": 0 },
      "wait": 3000
    },
    {
      "command": "simulate_input",
      "params": { "action": "right", "duration": 1000 }
    },
    {
      "command": "simulate_input",
      "params": { "action": "jump" },
      "wait": 1000
    },
    {
      "command": "take_screenshot"
    }
  ]
}
```

### Combat Test

```json
{
  "name": "Combat Test",
  "description": "Test firing and special abilities",
  "steps": [
    {
      "command": "go_to_level",
      "params": { "campaignIndex": 1, "levelIndex": 0 },
      "wait": 3000
    },
    {
      "command": "simulate_input",
      "params": { "action": "fire", "count": 5, "interval": 200 },
      "wait": 1000
    },
    {
      "command": "simulate_input",
      "params": { "action": "special" },
      "wait": 1000
    },
    {
      "command": "list_enemies"
    }
  ]
}
```

### State Modification Test

```json
{
  "name": "Teleport Test",
  "description": "Test teleportation and health modification",
  "steps": [
    {
      "command": "go_to_level",
      "params": { "campaignIndex": 0, "levelIndex": 0 },
      "wait": 3000
    },
    {
      "command": "teleport_player",
      "params": { "x": 100, "y": 50 },
      "wait": 500
    },
    {
      "command": "set_player_health",
      "params": { "health": 10 },
      "wait": 500
    },
    {
      "command": "inspect_player"
    }
  ]
}
```

## Tips

### Wait Times
- Add wait times after level loads (typically 2-3 seconds)
- Add short waits after input to let animations complete
- No wait needed if the next command doesn't depend on the previous one

### Script Organization
- Keep scripts focused on testing one feature or scenario
- Use descriptive names and descriptions
- Consider breaking complex tests into multiple smaller scripts

### Debugging Failed Scripts
- The steps stop at the first failed step unless `continueOnFailure` is set; `cleanup` steps still run
- `logs` shows the errors the game and the mods wrote while the script ran
- Check the failing step's `preview`, and its full record in `resultsFile`
- Add `inspect_player` or `list_gameobjects` steps to verify state

### Common Patterns

**Load and inspect:**
```json
{
  "command": "go_to_level",
  "params": { "campaignIndex": 0, "levelIndex": 0 },
  "wait": 3000
},
{
  "command": "inspect_player"
}
```

**Repeated input:**
```json
{
  "command": "simulate_input",
  "params": { "action": "fire", "count": 10, "interval": 150 }
}
```

**Held input:**
```json
{
  "command": "simulate_input",
  "params": { "action": "right", "duration": 2000 }
}
```

## Running Scripts

### From Claude Code

Use the `run_test_script` tool with the name of a script in `tests/`, and `args` for its arguments:
```
run_test_script with script: "example-movement-test.json"
```

Or with just the base name:
```
run_test_script with script: "example-movement-test"
```

A bare or relative name resolves inside `tests/`; a script kept anywhere else takes its absolute path.

Or with an absolute path:
```
run_test_script with script: "/full/path/to/script.json"
```

### Listing Scripts

Use the `list_test_scripts` tool to see all available scripts in `tests/`.

## Scenarios for a Mod Change

The `scenario-*.json` scripts run a mod change end to end in the game. Pick by what changed:

| Change | Run | Args to set |
| --- | --- | --- |
| A bro's kit, an ability | `scenario-bro-swap`: every swap is made with rescues held off, and the driver then holds the bro, pressing fire, melee and special itself where it has not, until fire has been pressed for the bro and it has run a melee and a special. A melee is seen when the bro's `StartMelee` runs or its `doingMelee` turns on. A special is a special press followed by the bro's or its BroMaker special ability's `UseSpecial` running without flashing the ammo bar, or by its special ammo dropping, overridden methods included; a melee counts once whether `StartMelee`, `doingMelee` or both show it, and a press counts at most once. `customBroUsedKit` and `lockedCustomBroUsedKit` fail when that takes longer than `kitHoldSec` or the bro is swapped out or dies first. What the melee or special did is not checked | `customBro`, the bro's BroMakerLib name; `kitHoldSec`, the seconds each check allows |
| A new bro | `scenario-bro-swap`, which checks the bro's swaps and its kit as above, then `capture_animations` for its sprites | `customBro` |
| A bro's animations | `capture_animations` (a tool, not a scenario) | |
| Menus or a mod's settings UI | `scenario-menus` | `mod`, the UnityModManager mod id |
| Co-op | `scenario-player-join` | `driver`: `bot` or `idle`; `bot` hands the game's follower bot the hero's own path agent, working around a game defect that leaves a late-enabled bot without one, and places the bro a few blocks from player 1, since the follower stops at an idle leader |
| A level mechanic | `scenario-level-run`, with `survey: true` first to see what the level has | `campaign`, `level`, `requireMechanics` |

Run one with `run_test_script`, e.g. `script: "scenario-bro-swap", args: { "customBro": "Bronobi" }`. `scenario-menus` returns to the main menu, so run it on its own.

Reading the reply:

- **passed** is the verdict: every step held and no report says `"passed": false`
- **report** is the scenario's own: `checks` (`name`, `passed`, `detail`) say what held, `outcome` how the run ended (`finished`, `duration`, `timeout`, `level-failed`, `error`, or `survey` for a `survey: true` run), and the level run adds `progress`, `mechanics` (`found`, `exercised`, `missed`, `unknown`), `characters` (each character a driven player had, with its presses and how often its special and melee ran), `events` and `stuck`
- **logs** is what the game and the mods wrote during the run: errors, warnings and floods by mod
- **resultsFile** holds every step's full result when a preview was cut

A failure is `passed: false` with either a failed step, whose `preview` says which expectation went unmet, or a report check with `passed: false`, whose `detail` says why, e.g. `reachedExit` with the run's progress toward the exit, `drivenAfterSwap` with no presses since the swap, or `customBroUsedKit` with what the bro never ran and whether it was swapped out first. A level run that times out still reports how far it got.

Mod settings in the profile the game runs shape the results:

- **Utility Mod `disableEnemySpawn`** leaves a level with no enemies. The level-run driver, which the bro swap also runs, turns it off in memory for its run and restores it, and reports that under `enemySuppression`; a settings save during the run still writes it on. The player join and the menu pass leave it as it is
- **Utility Mod `infiniteLives`** pins every player's lives, so the level run's forced death costs no life and the bro swap's `lives` has no effect

The level run refuses a level on an IronBro save, whose lives and dead bros a run would write, unless it only surveys; a level run that reaches the exit leaves the level finished, with its outcome held so the save is not written, until the next load; from arming until the run's level is left or the script unloaded, a won level's outcome and a campaign finish are skipped, whatever finished the level, and a freed bro or an unlock never reaches the progress, so a rescue still hands the player a bro but counts toward no unlock. Its timeout and its kit holds, like the player join's phases, do not count time under the pause menu.

The level run and the bro swap default to campaign 0 level 0, Intro level 1, which a level run finishes in about 25 s with five enemies, a door, a ladder and a cage. The player join and the menu pass default to campaign 1 level 0.

## See Also

- Check `tests/` for complete working examples
- See main README.md for Unity Inspector setup
- Unity Inspector Mod documentation for available game commands
