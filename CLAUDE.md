# Unity Inspector MCP Server

Node.js MCP server bridging Claude to the Unity Inspector Mod running inside Broforce.

## Architecture

```
Claude Code --stdio/MCP--> wrapper.js --stdio--> index.js --TCP:9999--> Unity Inspector Mod (C#) --> Unity Game
```

- `wrapper.js` is a hot-reload proxy — proxies MCP messages between Claude Code and `index.js`, injects a `restart_server` tool
- `index.js` is the actual MCP server: tool schemas, the tool-call switch, and the MCP resource
- `lib/unity-client.js` — TCP client (`UnityInspectorClient`, `commandTimeout`)
- `lib/game-process.js` — platform-aware process detection, kill, and launch
- `lib/script-library.js` — C# script library and JSON test-script handling
- `test/` — `node --test` suite, run with `nix-shell -p nodejs_22 --run "npm test"`. `test-support/` holds shared stubs and lives outside `test/` because the runner executes every file under `test/`
- Env vars: `UNITY_INSPECTOR_PORT` (TCP port, default 9999 — must match the mod's serverPort setting), `BROFORCE_LAUNCH_CMD` (how `launch_game` starts the game), `UNITY_INSPECTOR_LOG` (explicit UMM log path)
- **stdio** carries the MCP protocol — NEVER let child processes write to stdout (use `spawn` with `stdio: "ignore"`)
- TCP JSON protocol: `{"id":"...","method":"...","params":{...}}\n` → `{"id":"...","success":true,"result":{...}}\n`
- Responses are routed to their request by `id`; a reply arriving after its command timed out is dropped, never handed to the next command
- Some tools are Node.js-only (file operations, process management), others route through TCP to the game
- `index.js` starts the transport only when run directly, so tests can import `handleToolCall` from it

### Hot Reload (wrapper.js)

- `.mcp.json` points to `wrapper.js`, which spawns `index.js` as a child
- `restart_server` tool: kills the child, respawns it, replays the MCP `initialize` handshake — Claude Code doesn't notice the swap
- An unexpected child exit triggers the same respawn + init replay automatically. The third death within 30s stops respawning and requests get a JSON-RPC error; `restart_server` clears that lockout
- Requests forwarded to a child that stops answering — because it crashed or because `restart_server` replaced it — get an error response, so the session never goes silent
- `UNITY_INSPECTOR_MCP_CHILD` / `UNITY_INSPECTOR_MCP_WRAPPER_LOG` exist so the test suite can drive the wrapper against a stub child
- Use `restart_server` after modifying `index.js` instead of asking the user to `/mcp`
- Changes to wrapper.js itself still require manual `/mcp` or Claude Code restart
- **id=0 gotcha**: MCP protocol uses `id: 0` for the init message — always use `!== undefined && !== null` checks, never truthiness checks on message ids

### Adding a New MCP Tool

1. Add tool definition in `ListToolsRequestSchema` handler (schema + description)
2. Add a `case` to the switch in `handleToolCall()` (registered for `CallToolRequestSchema`)
3. If it needs game access: `result = await unityClient.sendCommand("method_name", params)`
4. If Node.js-only (file ops, process management): handle directly without `sendCommand`
5. Add matching handler in `BroforceMods/Unity Inspector Mod/Unity Inspector Mod/MessageHandler.cs`

### Timeouts

Budgets live in `commandTimeout()` in `lib/unity-client.js`. Default is 6 seconds — above the game's 5-second `MainThreadDispatcher` budget, so a frame hitch can't produce a spurious client-side timeout.
- `execute_script` / `compile_script`: 30 seconds
- `unload_script` / `execute_code`: 10 seconds
- scene-affecting commands (`go_to_level`, `restart_level`, `swap_bro`, `set_bro`, `take_screenshot`): 10 seconds
- `simulate_input` with count: calculated from count × interval
- Connecting has its own 5-second timeout, so an unreachable host fails fast instead of stalling on the OS TCP timeout

### Crash Detection

`sendCommand` polls `isGameRunning()` every 500ms while waiting for a response and returns `"Game process died — the command likely caused a crash"` when the process disappears. Death is only declared after the process was positively seen alive during that command's polling — where detection is unavailable, the command degrades to a normal timeout rather than a false crash report.

### Log Files

`read_log` / `watch_log` resolve the log of the **profile the running game was launched from**: with the game process confirmed running, launcher-chain command lines (`run_umm.sh` / doorstop args) are scanned for the r2modman profile path, and the profile is used only when exactly one distinct name appears. A closed game, an ambiguous scan, or a launch that never went through r2modman falls back to searching for the UMM log and using the **most recently modified** match: every `r2modmanPlus-local/Broforce/profiles/*/UMM/Core/Log.txt` under `~/.config` and `%APPDATA%` (profile names are arbitrary — `Default`, `UMM_Local_Install`, … — so the profile directory is globbed, never hardcoded), plus `Mods/UnityModManager/Log.txt` and `Mods/Log.txt` under the detected game path. Game-path detection runs from the log search itself, so it works with the game closed. `UNITY_INSPECTOR_LOG` overrides the whole search and is authoritative — if it points at a missing file, that is the error, with no fallback to another log. A miss reports every path searched. `watch_log` returns at most 64KB per call and flags the remainder as truncated.

### C# Script System (Node.js side)

- **Script library**: `scripts/csharp/` — source-controlled `.cs` files with comment-header metadata
- **Metadata parsing**: `parseScriptMetadata()` reads `// #name`, `// #description`, `// #tags`, `// #args` from file headers
- **`list_scripts`**: Node.js-only — scans `scripts/csharp/`, parses metadata, returns catalog
- **`execute_script` / `compile_script`**: Node.js reads the file, sends source over TCP (not file path — game may run under Proton with different filesystem)
- **Dynamic tool description**: `execute_script` tool description includes current script catalog, rebuilt on each `ListToolsRequestSchema` call
- **MCP resource**: `scripts://csharp/catalog` exposes script catalog (not auto-injected, but available for explicit reading)
- **Path safety**: absolute script paths are allowed; relative names must stay inside `scripts/csharp/`
- **Test scripts**: `list_test_scripts` and `run_test_script` cover both `scripts/` and `scripts/examples/`. Steps dispatch straight to the game, so Node-only tools can't be used as steps — `validateTestScriptSteps()` rejects them up front

### Game Process Management

- Everything lives in `lib/game-process.js`; nothing in the tool layer spawns processes directly
- `launch_game`: uses `BROFORCE_LAUNCH_CMD` when set (parsed into command + args), otherwise a platform-appropriate Steam protocol launch of appid 274190. Spawn failures come back as a tool error naming `BROFORCE_LAUNCH_CMD`, never an uncaught exception. A `launchArgs` string (tokenized shell-style) is appended to the custom command; Steam launches can't take it and report it as ignored
- `stop_game`: `pkill` on POSIX, `taskkill` on Windows. "Nothing matched" and "the tool is missing" are distinct results — the latter reports `unknown: true` rather than claiming a clean stop
- **Bracket trick**: pgrep/pkill patterns bracket their first character *and* the extension (`[B]roforce.*[.]e[x]e`) so the wrapping `sh -c` command line can't match itself. Verify any new pattern by running it with the game closed and confirming a non-zero exit
- Every spawn uses `stdio: "ignore"` (or piped stdout captured by `runChild`) and an `error` handler — NEVER `exec()` inheriting stdio, which corrupts the MCP transport
