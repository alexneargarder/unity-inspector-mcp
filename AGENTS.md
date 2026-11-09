# Unity Inspector MCP Server

Node.js MCP server bridging an MCP client to the Unity Inspector Mod, the C# mod inside Broforce, a project in [BroforceMods](https://github.com/alexneargarder/BroforceMods) built and installed separately.

**Test**: `npm test`; `.claude/rules/testing.md` has the fixtures and the set to run before a pull request.

After editing `index.js` or anything under `lib/`, call `restart_server` instead of reconnecting the client; after editing `wrapper.js`, reconnect the client (`/mcp` in Claude Code).

## Architecture

```
MCP client --stdio/MCP--> wrapper.js --stdio--> index.js --TCP:9999--> Unity Inspector Mod (C#) --> Unity Game
```

- `wrapper.js` is a hot-reload proxy that injects `restart_server`. `index.js` starts its transport only when run directly, so tests import from it.
- **stdio carries the MCP protocol** — NEVER let a child process write to stdout.

### Adding a New MCP Tool

1. Tool definition (schema + description): declare every argument the `case` reads in `inputSchema.properties`, with the `type` the mod reads it as (`integer` for an int); `handleToolCall()` refuses an undeclared key and checks each value against its `type`.
2. A `case` in the `handleToolCall()` switch.
3. Game access: `result = await unityClient.sendCommand("method_name", params)`; a flag that picks a different mod command goes in `toolCommand()`, which `run_test_script`'s steps also go through. Node-only work (file ops, process management) sends nothing.
4. A matching handler in the Unity Inspector Mod's message handler, reading numbers and booleans through its `ReadInt`, `ReadLong`, `ReadFloat` and `ReadBool`.

## Docs and tool descriptions

- **The README is not a manual**: one line or one short paragraph per setting, tool or install step. Internals, rationale, and what a launcher or the build files must do in depth go in `docs/` (user-facing, linked from the README in one line) or the `AGENTS.md` and `.claude/rules/` files (agent-facing); decide which before adding more than a sentence to the README.
- **The tool list is sent on every session start.** A description says what the tool does and what each argument means, in a few sentences; mechanics, rationale, edge cases and history go in the `AGENTS.md` files, the rules files or `docs/`. A description over about 600 characters needs a reason; `test/tool-list.test.js` caps each tool's JSON at 2,020 characters and the list at 18,500. Prefer a library script under `scripts/csharp/` to a new tool for a one-off procedure.
- Repo docs (`AGENTS.md` files, READMEs, tool descriptions) state the current contract only: no other project's defects, transitional caveats or fixes in progress.

## Code style

- Comment only a genuinely complex algorithm or an engine or runtime gotcha the code can't show: at most two lines, at the point of use, never wrapped to a column width. No labels, rationale, ordering or coupling notes, contracts, restatements, deletions or history; keep existing label comments.
- No doc blocks (JSDoc or XML `///`) on files, functions, classes or fields.

## C# scripts

**Tools:** `execute_script` (`compileOnly` compiles without running), `list_scripts`, `unload_script`.

Write one-off scripts to the system temp directory. A reusable utility can go in the committed library at `scripts/csharp/`, which requires this header:
```
// #name Script Name
// #description What it does
// #tags tag1, tag2
// #args paramName: Description
```

**`ScriptContext` API**, available in `Main()` and `Unload()`:
- `ScriptContext.Harmony` — isolated Harmony instance, auto-unpatched on unload
- `ScriptContext.Logger(string msg)` — `Action<string>`, logs as `[Script:name]`
- `ScriptContext.GameObjects` — `List<GameObject>`, auto-destroyed on unload
- `ScriptContext.Args` — `Dictionary<string, string>` of passed arguments
- `ScriptContext.GetArg(key, defaultValue)` — safe getter

**Lifecycle:** `public static void Main()` (entry point) and `public static void Unload()` (cleanup), both optional.
- Re-running a loaded script restarts it: `Unload()`, the Harmony unpatch and the tracked-GameObject destroy run first, then `Main()`. `Main()` need not be idempotent; `Unload()` must fully undo `Main()`.
- `ScriptContext.Logger` is never null but carries the `[Script:name]` prefix only while `Main()` or `Unload()` runs; a script logging later (e.g. from `Update()`) captures it into a field in `Main()`.
- `ScriptContext.Args` in `Unload()` holds the args of the run being unloaded.
- Log through `ScriptContext.Logger`, never `UnityEngine.Debug.Log`: its output never reaches the Unity Mod Manager log.

**Auto-imported namespaces** (`execute_script` and `execute_code`): `System`, `System.Collections`, `System.Collections.Generic`, `System.IO`, `System.Linq`, `System.Reflection`, `System.Text`, `UnityEngine`, `HarmonyLib`, `Unity_Inspector_Mod`, with `Object` aliased to `UnityEngine.Object`.

**Constraints:**
- .NET 3.5: no `GetValueOrDefault`, no `async`/`await`. LINQ works. `string.Join` has only the `(string, string[])` and 4-argument `string[]` forms, so an `IEnumerable<string>` or `List<string>` fails with CS1502: call `.ToArray()` first.
- No local functions (use a delegate local) and no `@$"` strings (use `$@"`).
- Every loaded assembly is referenced, and a type outside the auto-imported namespaces needs a `using` or its full name: the game's namespaced types (`Utility.SceneLoader`, `World.Generation.MapGenV4.ProcGenGameMode`, `TFBGames.Systems.GameSystems`), every mod's (`RocketLib`, `BroMakerLib`, `Utility_Mod`, …) and `UnityModManagerNet`'s.
- Private and internal members, nested types and another assembly's top-level `internal` types are reachable by name, as public ones are; a bare `Main` is this mod's own, so another mod's `Main` takes its full name or an alias.
- The game's global `Math` class (`Sin`, `Cos`, `GetAngle`; no `Min`, `Max`, `Log` or `Abs`) shadows `System.Math`, so `Math.Min` fails with CS0117: use `System.Math` or `Mathf`.
- Unity 2017.4: no `GameObject.TryGetComponent`, `Object.FindAnyObjectByType`/`FindObjectsByType` or `Random.onUnitCircle`; use `GetComponent` plus a null check, the `FindObjectOfType`/`FindObjectsOfType` family and `Random.insideUnitCircle`.
- 3D physics: `Physics`, `Collider`, `RaycastHit`, `BoxCollider`. `Physics2D` and `Collider2D` appear nowhere in the game or the mods; `Rigidbody2D` only in a few vanilla joint rigs, never in mods.
- A script-defined enum used as a field type (at compile) or a local (at run) crashes the game natively, so the script compiler rejects any reference to an enum a script or `execute_code` defined, from any script or `execute_code`; use `int` constants or an enum from a mod DLL.
- Iterator methods (`yield return`) work.
- MonoBehaviours die on scene load unless marked `DontDestroyOnLoad`; `ScriptContext.GameObjects` handles cleanup, not persistence.
- Script-defined types are reachable from `execute_code` by reflection, and by name except enums; a script can name the types of other loaded scripts and `execute_code`'s latest declarations, enums again excepted. A replaced or unloaded script's types are gone.
- `execute_code` input may open with `using` directives and type declarations, then continue with statements. Those declarations persist across calls, and are the only way `execute_code` input adds a `using` or a type that outlives the call.
- On a member whose signature names an absent assembly or holds a function pointer, a `GetParameters`/`Invoke`-style read still ends the game when the reflection guards miss it: through a delegate, an `Expression` tree or a generic type parameter, or made by library code for the script, such as `Type.GetMethod` with a type list naming such a method.

## Animation capture

`capture_animations` loads a level, swaps the bro, waits until the bro is sweepable, runs the in-game `AnimationCapture` script and waits for its `done`/`error` sentinel. It sweeps on the server's own client, so it goes to the server's current target. The script writes one PNG strip per state, `capture.json` (each frame's sheet cell and what the level did) and the sentinel into `gameOut`; the server writes `states.json` and `report.md` (cells against the state list) into `out`.

- `out`: the prep deletes every `.png` in it, so a non-empty one is accepted only when it holds the `.capture-animations` mark an earlier sweep wrote.
- `gameOut` must be absolute, in either path style; set it whenever the server's and the game's path spaces differ (Proton, WSL). A wrong one surfaces as the script's `state file not found` refusal. On a declared remote, or a `UNITY_INSPECTOR_HOST` naming another machine outside WSL, `gameOut` is refused and the server picks the game's folder itself (`.claude/rules/remote.md`).
- `settle` waits after the level reports its player, who goes live about a second before the world renders. A bro's intro cutscene starts about half a second after `go_to_level` replies where the bro spawns straight in; a `settle` shorter than that misses it and the readiness wait refuses it. Raise `settle` for a bro still on the level-start helicopter.
- `bro` is the `list_bros` roster name. A locked or filtered bro goes in with `ignoreUnlocks`, which is not Swap Bros Mod's selection, so a respawn brings the selection back. A slot left holding another bro (a BroMaker substitution that left plain Rambro) fails the run before any sweep.
- `swapSettle`: `swap_bro` answers while the old character is still drawn; a sweep freezing the clock there strips the wrong bro.
- `states` layers (a single string is one layer; a relative name must stay inside `lib/animation-capture/states/`, an absolute path is used as given) merge by name, later winning: a same-name entry replaces the earlier one whole, in its position. Names whose strip files would collide (`a b` and `a_b`, `Run` and `run`) fail the run. `only` filters the merged list; a repeated name, or one the list lacks, fails the run; `includeLethal` and `allowSideEffects` still gate what it names.
- `allowSideEffects`: without it the swept bro's attack and special calls and the game's damaging `Map`/`MapController` calls are skipped and counted on each state's `suppressed`; with it they run, counted on `damageCalls`.
- `box`: the script refuses one whose widest strip passes the GPU texture limit.
- `backdrop`, here and on `take_screenshot`: any value other than `true`, `false` or a `#RRGGBB` string is refused before anything is sent. Only the characters, their guns and effects are drawn; the level's sky, background, scenery, terrain and UI are hidden for that one render. `take_screenshot` refuses it with `highlight`. A failed render is a tool error on `take_screenshot` and a filed state error in a sweep.
- `timeout` bounds each wait, and a sweep with no progress: every finished state rewrites `capture.json` and moves the deadline on.

Reply: `success` is true only when the sentinel was `done` and no state errored; a cell mismatch is a finding, not a failure. A state that errors is filed as `skipped: "error: …"` and the sweep moves on. `status` is `done`, `error`, `timeout` or `game-gone`; `report` is `report.md`'s text. `report.md` and `capture.json` land even when the client stops waiting, but a cancelled call writes no `report.md`. A run that never reaches the sweep is a tool error with no report.

A sweep holds the game exclusively: while it runs, every tool that could change the game is refused, a highlighted `take_screenshot` included, and only `stop_game` and the read-only tools pass. `stop_game` ends every wait within one poll: the sentinel wait with `status: "game-gone"`, a setup wait with a tool error saying the game stopped. Another server's sweep or setup in the same game fails the run before it changes anything. A server stopped mid-sweep tries to unload the script, which puts the clock back; when the unload fails, the teardown sets the speed read at readiness (the pre-sweep `timeScale`, 1 when that was 0). Each command gets 800ms and the whole teardown 2s, then the server exits anyway and can leave the game frozen, warning only in the wrapper log.

On the server, `index.js` records the sweep in `activeSweep` with nothing awaited between its refusals and the record, and only the call that set it clears it. `refuseDuringSweep()` runs in `callTool()` before and after a call's target wait and after `execute_script`'s and `unload_script`'s file reads, so a call sent in the sweep's turn cannot slip past. `capture_animations` is refused while a `run_test_script` or a `launch_game` runs.

## Rules files

Claude Code loads each when a file matching its `paths:` is read; otherwise read the one the work needs directly.

- `.claude/rules/instances.md` — per-session instances: target, launcher probe, instances root, ownership, launch, stop, `owner.pid`, the help channel
- `.claude/rules/game-process.md` — process detection, `launch_game`'s paths and waits, `stop_game`, `pollUntilResponsive()`, crash detection, the server's shutdown triggers
- `.claude/rules/connection.md` — the handshake and token search, command timeouts, cancellation
- `.claude/rules/wrapper.md` — `restart_server`, the respawn lockout, the wrapper's log, the reaper at session end
- `.claude/rules/tool-behaviour.md` — per-tool behaviour and reply fields, argument checking, `list_enemies`, the `execute_code` contract
- `.claude/rules/scripts.md` — the C# script library, `execute_script`, `run_test_script`'s shape, cleanup and `logs`
- `.claude/rules/logs.md` — `read_log`: which file, in what order, staleness, `onlyNew`
- `.claude/rules/remote.md` — the remote game target: declaration, the env path, reach, the token search and the connection's failure replies, file transfers and local copies, screenshots, the log mirror, `run_test_script` and `capture_animations` on it, restart
- `.claude/rules/testing.md` — the test fixtures and fences, the set to run before a pull request, the rule for changes, the matrix's conventions
- `.claude/rules/testing-matrix-server.md` — input-class matrix: server tests of the other tools and the handshake
- `.claude/rules/testing-matrix-node-tools.md` — input-class matrix: server tests of `capture_animations`, `list_scripts`, `list_test_scripts`, `read_log`, `restart_server`, `run_test_script`
- `.claude/rules/testing-matrix-launch-stop.md` — input-class matrix: server tests of `launch_game`, `stop_game`, `wait_for_game`
- `.claude/rules/testing-matrix-in-game.md` — input-class matrix: in-game steps
- `.claude/rules/testing-matrix-in-game-scripts.md` — input-class matrix: in-game steps of `capture_animations`, `execute_code`, `execute_script`, `run_test_script`, `unload_script`

## Folder AGENTS.md files

- `lib/AGENTS.md` — the TCP protocol and command queue, the animation-capture sweep driver (claim, cutscenes, swap), the backdrop render, the remote file transfers and the shared command and log helpers
- `lib/animation-capture/AGENTS.md` — animation-capture state lists and the in-game capture script's mechanics
