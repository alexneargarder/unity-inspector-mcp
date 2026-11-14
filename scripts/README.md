# Test Scripts

`tests/` holds the JSON test scripts: sequences of tool calls with optional waits and checks, for running the same scenario the same way every time.

## Script Format

```json
{
  "name": "Runner",
  "description": "Arms a runner script, loads a level and collects the runner's report",
  "args": { "level": { "default": 0, "description": "Level index" } },
  "steps": [
    { "command": "execute_script", "params": { "path": "my-runner" } },
    { "command": "go_to_level", "params": { "campaignIndex": 1, "levelIndex": "{{level}}" } },
    { "command": "execute_code", "params": { "code": "return MyRunner.Phase;" },
      "until": { "timeout": 300, "interval": 2 }, "expect": { "contains": ["done"] } },
    { "command": "execute_code", "params": { "code": "return MyRunner.ReportJson;" }, "report": true }
  ],
  "cleanup": [ { "command": "unload_script", "params": { "path": "my-runner" } } ]
}
```

### Fields

- **name** (required): display name for the script
- **description** (optional): what the script tests
- **steps** (required): the steps to run, in order
- **cleanup** (optional): steps run after `steps` however they ended, unless the game is gone
- **continueOnFailure** (optional): `true` records a failed step and moves on instead of stopping
- **args** (optional): the arguments the script takes, each `{ "default": <value>, "description": "..." }`; `run_test_script`'s `args` override the defaults

### Step Fields

- **command** (required): the name of a game-side tool. Steps go straight to the game, so server-side tools such as `read_log` and `launch_game` can't be steps
- **params** (optional): the tool's arguments, except that an `execute_script` step can give inline `source` and the `name` it loads under in place of `path`. `{{name}}` in a string is replaced by that arg, and a string that is only the placeholder takes the arg's own type
- **wait** (optional): milliseconds to wait after the step
- **expect** (optional): `success` (boolean), `contains` and `notContains` (substrings of the result). The step passes when every check holds, so a step can be expected to fail
- **until** (optional, needs `expect`): `{ "timeout": <seconds>, "interval": <seconds, default 1> }` re-sends the step until its `expect` holds or the timeout passes
- **report** (optional): `true` lifts the step's result, a JSON object, into the run's `report`

A key the format doesn't have, or a placeholder or arg that doesn't match, is rejected before the script runs.

## Running Scripts

Run one with `run_test_script`, giving `script` as a name in `tests/` (with or without `.json`) or an absolute path, and `args` for its arguments. `list_test_scripts` lists the scripts in `tests/` with the args each takes. The `example-*.json` scripts are short ones to start from.

The reply has `passed`, any `report`, the log errors the run caused and a preview of each step; the whole run, every step's full result included, goes in `resultsFile` under `~/.local/state/unity-inspector-mcp/test-results/` (`UNITY_INSPECTOR_TEST_RESULTS_DIR` to choose another folder).

## Scenarios for a Mod Change

The `scenario-*.json` scripts run a mod change end to end in the game. Pick by what changed:

| Change | Run | Args to set |
| --- | --- | --- |
| A bro's kit, an ability | `scenario-bro-swap`, which swaps to the bro and holds it until it has fired and run its melee and special | `customBro`, the bro's BroMakerLib name; `kitHoldSec`, the seconds each check allows |
| A new bro | `scenario-bro-swap`, then `capture_animations` for its sprites | `customBro` |
| A bro's animations | `capture_animations` (a tool, not a scenario) | |
| Menus or a mod's settings UI | `scenario-menus`, on its own, since it returns to the main menu | `mod`, the UnityModManager mod id |
| Co-op | `scenario-player-join` | `driver`: `bot` or `idle` |
| A level mechanic | `scenario-level-run`, with `survey: true` first to see what the level has | `campaign`, `level`, `requireMechanics`; `bro`, the roster name of the bro to run as |

A call looks like `script: "scenario-bro-swap", args: { "customBro": "Bronobi" }`. Each scenario's description, which `list_test_scripts` shows, says what it needs. Its `report` carries `checks` (`name`, `passed`, `detail`), where a failed check's `detail` says why, and `outcome`, how the run ended.
