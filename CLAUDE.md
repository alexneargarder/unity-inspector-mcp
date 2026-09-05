# Unity Inspector MCP Server

Node.js MCP server bridging Claude to the Unity Inspector Mod running inside Broforce.

**Test**: `nix-shell -p nodejs_22 --run "npm test"` — `node --test` executes every file under `test/`, so shared stubs live in `test-support/` instead.

## Architecture

```
Claude Code --stdio/MCP--> wrapper.js --stdio--> index.js --TCP:9999--> Unity Inspector Mod (C#) --> Unity Game
```

- `index.js` — the MCP server: tool schemas, the `handleToolCall()` switch, log resolution, the MCP resource. Starts the transport only when run directly, so tests can import from it
- `wrapper.js` — hot-reload proxy between Claude Code and `index.js`; injects the `restart_server` tool
- `lib/unity-client.js` — TCP client (`UnityInspectorClient`, `commandTimeout`)
- `lib/game-process.js` — process detection, kill, launch, start time
- `lib/script-library.js` — C# script library and JSON test scripts
- TCP JSON protocol: `{"id":"...","method":"...","params":{...}}\n` → `{"id":"...","success":true,"result":{...}}\n`. Responses route to their request by `id`; a reply arriving after its command timed out is dropped, never handed to the next command
- Env vars: `UNITY_INSPECTOR_PORT` (default 9999, must match the mod's serverPort), `BROFORCE_LAUNCH_CMD` (how `launch_game` starts the game), `UNITY_INSPECTOR_LOG` (explicit log path)
- **stdio carries the MCP protocol** — NEVER let a child process write to stdout

### Hot Reload (wrapper.js)

- After editing `index.js` or anything under `lib/`, call `restart_server` instead of asking the user to `/mcp`. Editing `wrapper.js` itself does need a manual `/mcp` or Claude Code restart
- `restart_server` kills the child, respawns it, and replays the MCP `initialize` handshake. An unexpected child exit triggers the same sequence automatically; the third death within 30s stops respawning and requests get a JSON-RPC error until `restart_server` clears the lockout
- `UNITY_INSPECTOR_MCP_CHILD` / `UNITY_INSPECTOR_MCP_WRAPPER_LOG` let the tests drive the wrapper against a stub child
- **id=0 gotcha**: MCP uses `id: 0` for init — check ids with `!== undefined && !== null`, never truthiness

### Adding a New MCP Tool

1. Tool definition (schema + description) in the `ListToolsRequestSchema` handler
2. `case` in the `handleToolCall()` switch
3. Game access: `result = await unityClient.sendCommand("method_name", params)`
4. Node-only (file ops, process management): handle directly, no `sendCommand`
5. Matching handler in `BroforceMods/Unity Inspector Mod/Unity Inspector Mod/MessageHandler.cs`

### Timeouts

`commandTimeout()` in `lib/unity-client.js`:
- default 6s — keep above the game's 5s `MainThreadDispatcher` budget
- `execute_script` / `compile_script`: 30s
- `unload_script` / `execute_code`: 10s — keep above the mod's own 9s `execute_code` budget
- scene commands (`go_to_level`, `restart_level`, `swap_bro`, `set_bro`, `take_screenshot`): 10s
- `simulate_input` with count > 1: (count − 1) × interval + 1s, floored at the 6s default
- connect: 5s

### execute_code Contract

- Input compiles as its own block: statements, local declarations, a trailing `return expr;`, or a trailing expression as the value. Locals do not persist between calls; no lambda wrapping needed
- Read the **inner** result's `success` — the TCP envelope's own `success:true` only means the request was handled. Three shapes: `resultSet:true` with `result`; `success:true, resultSet:false` for ran-but-void; `success:false` with `error`
- `stackTrace` is set only when the failure happened before user code started running
- **Submitted code must never read an exception's `StackTrace`, nor `Exception.ToString()`, which reads it** — walking dynamically compiled frames crashes the game process

### Crash Detection

`sendCommand` polls `isGameRunning()` every 500ms while waiting and answers `"Game process died — the command likely caused a crash"` when the process disappears. Death is declared only after the process was seen alive during that command; where detection is unavailable the command degrades to a normal timeout.

### Log Files

`resolveLogFile()` in `index.js` picks the file for `read_log` and `watch_log`; every response carries `path` and `modifiedAt`.

- **Candidates**: `r2modmanPlus-local/Broforce/profiles/*/UMM/Core/Log.txt` under the r2modman config roots (profile names are arbitrary — glob, never hardcode); `Mods/UnityModManager/Log.txt` and `Mods/Log.txt` under the detected game path; the Unity player log (`Player.log` / `output_log.txt`) under each platform's Unity log root, the Proton prefix, and `<gamePath>/Broforce_Data` — `playerLogPaths()` has the list. `Player-prev.log` is never a candidate
- `resolveLogFile()` resolves the running game's r2modman profile `Log.txt` first, falling back to the Unity player log paths (`Player.log` / `output_log.txt`) — the player log always exists and carries UMM's and every mod's output
- **Order**: `UNITY_INSPECTOR_LOG` is authoritative — a missing file there is the error, no fallback. Otherwise, with the game running and exactly one r2modman profile found in the launcher-chain command lines: newest of that profile's `Log.txt`, then newest player log, both ignoring files last written before the game started; with no known start time the newest of profile and player logs wins outright. Anything else — game closed, ambiguous scan, non-r2modman launch, nothing written since start — takes the most recently modified candidate
- **Staleness**: `gameStartTime()` in `lib/game-process.js` (null when unavailable) minus a 3s tolerance is the cutoff; a chosen file predating it carries `stale: true` and a `warning`
- **`watch_log`**: 64KB per call, remainder flagged truncated. `isBaseline` is explicit on every read — `true` on the first call, on `reset`, and whenever the file underneath changes: offsets key on `dev`+`ino` as well as path, so Unity rotating `Player.log` at launch rebaselines instead of slicing at the old offset, and the `path` can switch once mid-run to the profile log when UMM's log appears

### C# Script System (Node.js side)

- `scripts/csharp/` holds source-controlled `.cs` files; `parseScriptMetadata()` reads `// #name`, `// #description`, `// #tags`, `// #args` headers
- `list_scripts` is Node-only. The `execute_script` tool description embeds the catalog, rebuilt on each `ListToolsRequestSchema` call; `scripts://csharp/catalog` exposes the same catalog as an MCP resource
- `execute_script` / `compile_script` read the file in Node and send **source** over TCP, never a path — the game may run under Proton with a different filesystem
- **Path safety**: absolute script paths are allowed; relative names must stay inside `scripts/csharp/`
- `list_test_scripts` / `run_test_script` cover `scripts/` and `scripts/examples/`. Steps dispatch straight to the game, so `validateTestScriptSteps()` rejects Node-only tools as steps, and `execute_script` / `compile_script` steps without inline `params.source`

### Game Process Management

- Everything lives in `lib/game-process.js`; nothing in the tool layer spawns processes directly
- Every spawn uses `stdio: "ignore"` (or `runChild`'s piped capture) and an `error` handler; never `exec()` inheriting stdio
- **Bracket trick**: pgrep/pkill patterns bracket their first character *and* the extension (`[B]roforce.*[.]e[x]e`) so the wrapping `sh -c` command line can't match itself. Verify any new pattern with the game closed and confirm a non-zero exit
- `launch_game`: `BROFORCE_LAUNCH_CMD` when set (parsed into command + args), otherwise a platform-appropriate Steam protocol launch of appid 274190. Spawn failures come back as a tool error naming `BROFORCE_LAUNCH_CMD`. A `launchArgs` string (tokenized shell-style) is appended to the custom command; Steam launches can't take it and say so
- `stop_game`: `pkill` on POSIX, `taskkill` on Windows. "Nothing matched" and "the tool is missing" are distinct results — the latter answers `unknown: true`
- `wait_for_game` and `launch_game`'s post-launch wait share `pollUntilResponsive()` in `index.js`: always at least one attempt, 60s/3s fallback for a non-finite or negative budget, and the call can overrun its deadline by the 5s connect timeout plus the 1s ping floor. `connected-unresponsive` means only a ping-stage command timeout; a non-timeout ping failure is `no-process` when process detection confirms the game is not running, else `connection-dropped`
