---
paths:
  - "test/**"
  - "scripts/tests/**"
---

# Testing

## The suite

`npm test` runs `node --test test/*.test.js`, naming only the test files, so shared stubs live in `test/support/` without ever being run as tests themselves. Every test file imports `test/support/session.js` first, before `index.js` or anything under `lib/`: it deletes `CLAUDE_SESSION_ID`, `BROFORCE_INSTANCE_CMD`, `BROFORCE_STOP_CMD`, `BROFORCE_PROFILE`, `BROFORCE_LAUNCH_TYPE`, `STUB_STAGE_ROOT`, `UNITY_INSPECTOR_MCP_CLAIM_FILE`, `UNITY_INSPECTOR_HOST` and `XDG_CONFIG_HOME` (a test that wants the last sets a temp value of its own), sets the WSL probe to `NOT_WSL` through `setWslProbe()` (a test that wants WSL sets its own and restores that) and points `BROFORCE_LAUNCH_CMD` at a no-op command, `UNITY_INSPECTOR_TEST_RESULTS_DIR` at a scratch directory it removes at exit, `UNITY_INSPECTOR_REMOTE_DIR` at `remote` inside it (`REMOTE_FILES_SCRATCH`), `UNITY_INSPECTOR_TOKEN_FILE` at a file in it that never exists (`NO_TOKEN_FILE`) and, through `setWslUsersRoot()` from a dynamic import made after those settings, the WSL users root at a directory in it that never exists (`NO_WSL_USERS_ROOT`), so the session running the tests never gives them an instance, a real command to run, a stage of its own, a live wrapper's claim file to write, or the real config home or `/mnt/c/Users` for the user's game's token and log searches to read. A file that wants one sets its own id and points the setting at a script from `test/support/stub-launcher.js` — `writeStubLauncher()` for the launcher (control files under the instances root drive its refusals, its `--args-help`, and whether its `--help` offers one; `useStubLauncher()` sets `STUB_INSTANCES_ROOT` and `STUB_STAGE_ROOT`, the two roots the stub reports in its list header and the only way the server learns where the test's instances and stages are) and `writeStubStopCommand()` for a user's-game stop — so no test can reach a real launcher or start a game. The stub launcher creates a missing instance itself, as the contract has it, and refuses one whose directory holds no `profile/`, so a test launching into an instance that already exists seeds it with `seedInstanceDir()`. **A launch through Steam is fenced off three times**, since it starts the user's real game: `session.js` points `BROFORCE_LAUNCH_CMD` at a no-op command (`NO_OP_LAUNCH_CMD`, which `useStubLauncher()` restores rather than deletes); it sets `UNITY_INSPECTOR_TEST`, on which `resolveLaunchCommand()` throws before it resolves Steam; and under that same marker in `process.env` every Steam lookup a test did not inject throws, whatever `env` the test passed. A test wanting its own launch command sets one; a unit test wanting a Steam launch's shape passes its own `env` object and lookups (`registry`, `onPath`, `steamRoots`, `findSteamGame`, `profilesRoot`, `flatpakDataRoot`) and only resolves it, and one driving the wait through `launch_game` points `setLaunchResolver()` at such a resolve with a stub `steam.sh` in a fixture root, or for a Flatpak r2modman profile with the resolve's `command` replaced by a stub script. **A signal is fenced too**: under that marker the server's real `kill` (`realKill()` in `lib/game-process.js`) throws for any signal but 0, naming the pid, since with no launcher every Broforce process counts as the user's game; a test that reaches a stop injects `kill` (`setKillSignaller()` or the `kill` option), and the liveness probe, signal 0, still runs. Off Linux, `killGame()` throws under the marker before a by-name kill (`taskkill`, `pkill`) unless the test injected `run`. **The port is fenced the same way**: `session.js` sets `UNITY_INSPECTOR_PORT` to `NO_LISTENER_PORT`, port 1, since unset the `steam` target falls back to 9999 and the tests would reach the user's running game, and every place that would clear the variable restores that value instead. **The process table is fenced too**: under that marker `defaultProcReader()` in `lib/game-process.js` throws rather than read the real `/proc`, since another session's game can start or stop between two reads of it, so every uninjected `isGameRunning`, `gameStartTime`, kill scan and pidfile check fails, a caller that swallows the error (the client's crash poll, a sweep's game watch) reads detection as unavailable, and `gameDataLocations()` reads it as nothing derived. A test whose outcome turns on whether a game is running reads a fixed table on Linux — `setProcReader(fakeProcReader(...))` from `test/support/fake-proc.js`, `fakeProcReader({})` for none, `conditionalProcReader()` for a game that appears once its launch has run, or an injected `isRunning`; a fake's `cmdline` or `environ` given as an array keeps each entry whole, spaces included — and a test that must read the real one opts in with `setProcReader(createProcReader())` and checks for a game before and after. `test/support/wrapper-harness.js` drives `wrapper.js` itself against `test/support/stub-child.js`. **Every fake mod answers the hello**: `startStubServer()` and `fakeInspector()` take a `hello` mode (`answerHello()` in `test/support/stub-server.js`: accept by default, `old-mod`, `{ protocol }`, `{ acceptAs }`, `refuse`, `silent`, `close`, or a function of the hello's params), settable between connections, record each connection's first line and every hello's params, and refuse a first line that is not a hello; a command handler never sees the hello. Like the mod, `serveConnection()` hands a handler the next line only once it has written to the socket or ended it, and records every command line in `lines`. A stub on `127.0.0.2` whose port must refuse on `127.0.0.1` comes from `startStubBesideLoopback()`, which takes a port below the ephemeral range: another file's `listen(0)` on `127.0.0.1` can hold or take the port an ephemeral bind on `127.0.0.2` returns. A tool change runs the set below, this suite plus the in-game scripts on a game of one's own, before its PR, and adds its input classes to the matrix in `testing-matrix-server.md`, `testing-matrix-node-tools.md`, `testing-matrix-launch-stop.md`, `testing-matrix-in-game.md` and `testing-matrix-in-game-scripts.md`.

## Running the set

### In-game scripts

Run each script below with `run_test_script` on a game of your own: this session's instance where instances are configured, never a game someone else is using.

- Start each script in campaign 0 level 2 (`go_to_level {campaignIndex: 0, levelIndex: 1}`).
- Run `scripts-lifecycle.json` twice in one game.
- A failing precondition step in `game-states.json` (the loading and world-map checks) is a timing miss: run it again.
- The `example-*.json` and `scenario-*.json` scripts are not part of the set.

| script | needs |
|---|---|
| `bros.json` | Swap Bros Mod with BroMaker enabled and `alwaysChosen` on; Cobro, Test_Rambro, Bronobi, R.J. Brocready and Test_LegacySpriteKey installed and unlocked; Control Enemies Mod disabled, or its spawn-as-enemy off |
| `game-states.json` | Swap Bros Mod; BroMakerLib; a current save slot holding a campaign; Control Enemies Mod disabled, or its spawn-as-enemy off |
| `player-states.json` | Swap Bros Mod; BroMakerLib; the second player slot empty; Control Enemies Mod disabled, or its spawn-as-enemy off |
| `execute-code-shapes.json` | RocketLib; BroMakerLib with Cobro; Swap Bros Mod |
| `execute-code-errors.json` | BroMakerLib and RocketLib |
| `compiler-access.json` | Utility Mod; BroMakerLib; RocketLib |
| `finally-recursion.json` | nothing beyond the inspector |
| `script-constants.json` | nothing beyond the inspector |
| `scripts-lifecycle.json` | RocketLib; BroMakerLib; Swap Bros Mod |
| `inspection.json` | Swap Bros Mod; BroMakerLib |
| `spawning.json` | Swap Bros Mod; BroMakerLib; Utility Mod enabled with `disableEnemySpawn` on; campaign 16 |
| `input.json` | Swap Bros Mod; BroMakerLib; a current save slot holding a campaign that is not IronBro; Control Enemies Mod disabled, or its spawn-as-enemy off |
| `param-types.json` | nothing beyond the inspector |
| `input-sequence.json` | nothing beyond the inspector |
| `levels.json` | Swap Bros Mod; BroMakerLib; Utility Mod enabled with `disableEnemySpawn` on; a save slot holding a campaign that is not an IronBro run; Control Enemies Mod disabled, or its spawn-as-enemy off |
| `library-scripts.json` | RocketLib; a vanilla bro for player 1; Control Enemies Mod disabled, or its spawn-as-enemy off |

## Rule for changes

1. A tool change adds a row, and a test, for every input class it introduces: a server test for a branch in `index.js` or `lib/`, a step in an in-game script for a branch in the mod or a game state.
2. A class no step can produce gets a row whose cell reads `not produced by any step:` with its server test, or the reason it has none. One that belongs to no single tool goes under Not produced by any step in `testing-matrix-in-game.md`.
3. An in-game script's first steps undo whatever an earlier failed run of it left changed and its first press retries with `until`, so a run started on the loading screen waits it out; every restore its later steps make is repeated in `cleanup`, and a script that changes level reloads the one it started in when it ends. A record of what the run found, which its last steps compare against or reload, is taken on every run, never only when absent, and `cleanup` clears it, so a halted run leaves none for the next.
4. A script that loads levels polls with `until` after its restore steps until any load in progress has settled — `game-states.json`'s third step: the scene unchanged for 4 s, not `LoadingScreen`, and in a level, the level built and not moving on — before it records the level it started in, and after each load whose next steps need a level or a bro, other than a `go_to_level` step, which replies once a slot's bro is alive, polls `game_state` until `"state": "alive"`. The first load after a launch takes about 20 s.
5. Then run the whole set: the server suite, then the in-game scripts.

## The matrix

A row goes in the file for what covers it:

- `testing-matrix-in-game.md`: an in-game step of any tool but those below, alone or beside a server test, or a cell reading `not produced by any step:`
- `testing-matrix-in-game-scripts.md`: an in-game step of capture_animations, execute_code, execute_script, run_test_script and unload_script
- `testing-matrix-node-tools.md`: server tests of capture_animations, list_scripts, list_test_scripts, read_log, restart_server and run_test_script
- `testing-matrix-launch-stop.md`: server tests of launch_game, stop_game and wait_for_game
- `testing-matrix-server.md`: server tests of every other tool, of every tool at once, and of the connection handshake

A class is one kind of input a tool sees in real use. The first column groups the rows:

- **N** a schema or server branch
- **S** a game state
- **C** a call shape, or a branch of the mod's own handler
- **M** a mod in the set

Server tests are cited by file and full test name. In-game steps are cited by script and step number, counted from 1.

| abbr | file | | abbr | file |
|---|---|---|---|---|
| CA | `test/capture-animations.test.js` | | LV | `test/launch-vanilla.test.js` |
| CL | `test/connection-lifecycle.test.js` | | PI | `test/process-identity.test.js` |
| GP | `test/game-process.test.js` | | SL | `test/script-library.test.js` |
| IL | `test/instance-launch.test.js` | | TH | `test/tool-handler.test.js` |
| INST | `test/instance.test.js` | | TL | `test/tool-list.test.js` |
| IT | `test/instance-target.test.js` | | UC | `test/unity-client.test.js` |
| LH | `test/launch-help.test.js` | | W | `test/wrapper.test.js` |
| WG | `test/wait-for-game-states.test.js` | | WIS | `test/wrapper-instance-stop.test.js` |
| LD | `test/log-delta.test.js` | | RTS | `test/run-test-script.test.js` |
| RL | `test/read-log.test.js` | | WS | `test/wrapper-stderr.test.js` |
| WL | `test/wrapper-log.test.js` | | STL | `test/steam-launch.test.js` |
| HS | `test/handshake.test.js` | | HT | `test/handshake-tools.test.js` |
| SS | `test/server-shutdown.test.js` | | SI | `test/simulate-input.test.js` |
| PP | `test/process-platforms.test.js` | | SC | `test/stale-code.test.js` |
| RT | `test/remote-target.test.js` | | RF | `test/remote-files.test.js` |
| RC | `test/remote-capture.test.js` | | GD | `test/game-data.test.js` |
