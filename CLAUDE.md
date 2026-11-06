# Unity Inspector MCP Server

Node.js MCP server bridging Claude to the Unity Inspector Mod running inside Broforce.

**Test**: `nix-shell -p nodejs_22 --run "npm test"`, in the foreground of its own `nix-shell`, since `nix-shell` deletes its TMPDIR, and with it every test's temp directories, when its command exits; `.claude/rules/testing.md` has the fixtures and the set to run before a pull request.

After editing `index.js` or anything under `lib/`, call `restart_server` instead of asking the user to `/mcp`. Editing `wrapper.js` itself does need a manual `/mcp` or Claude Code restart.

## Architecture

```
Claude Code --stdio/MCP--> wrapper.js --stdio--> index.js --TCP:9999--> Unity Inspector Mod (C#) --> Unity Game
```

- `index.js` — the MCP server: tool schemas, the `handleToolCall()` switch, log resolution, the MCP resource. Starts the transport only when run directly, so tests can import from it
- `wrapper.js` — hot-reload proxy between Claude Code and `index.js`; injects the `restart_server` tool
- `lib/unity-client.js` — TCP client (`UnityInspectorClient`, `commandTimeout`), the connection handshake and the token search (`unityDataDirs()`, `steamTokenSearch()`, `readTokenFile()`), and `toolCommand()`, which maps a tool name and params to the mod command to send, the flag that chose it stripped
- `lib/game-process.js` — process detection, kill, launch, start time
- `lib/steam-launch.js` — the user's game's own launch through Steam: the Steam executable, the profile, the Doorstop arguments, Proton or native, the `user.reg` override and the `*.sh` chmod
- `lib/instance.js` — the instance derivation: the session id, the configured launcher, its launcher commands, and `withRoot()`, which hangs the instance's paths off the roots the launcher reported
- `lib/command-line.js` — `tokenizeCommand()`, shared by every setting that holds a command plus arguments
- `lib/script-library.js` — C# script library and JSON test scripts
- `lib/log-delta.js` — what the target's log gained during a `run_test_script` run, grouped by source, and the bounded reads every log reader shares: `linesBackward()`, the relaunch check `sameLogRun()` and `markLogEnd()`
- `lib/animation-capture.js` — the animation-capture sweep `capture_animations` drives: the state-list merge and `only` filter, the level, swap, bro and readiness waits, the sentinel wait and the report
- TCP JSON protocol: `{"id":"...","method":"...","params":{...}}\n` → `{"id":"...","success":true,"result":{...}}\n`. The first line on every connection is the hello, `{"method":"hello","params":{"token":...,"protocol":1}}`, and `connect()` resolves only once the mod accepted it (see Handshake in `.claude/rules/connection.md`). The mod reads, runs and answers one line at a time per connection, so `sendCommand` queues: a command is written only once the one before it has settled, and its timeout starts at its own write. A command that times out, or whose call is cancelled while the mod is still running it, drops the socket, so the next command gets a fresh connection and a fresh receive thread in the mod rather than queueing behind it; the timeout's message says the game may still carry the command out. Responses route to their request by `id`; a reply arriving after its command timed out is dropped, never handed to the next command
- Env vars, all of them the `steam` target's and never an instance's: `UNITY_INSPECTOR_PORT` (default 9999, must match the mod's serverPort), `BROFORCE_LAUNCH_CMD` (how `launch_game` starts the user's game), `BROFORCE_PROFILE` (the r2modman profile the Steam launch loads, a name or an absolute folder, default `Default`), `BROFORCE_LAUNCH_TYPE` (`auto`, `native` or `proton`, the Linux Steam launch only), `BROFORCE_STOP_CMD` (how `stop_game` stops it), `UNITY_INSPECTOR_LOG` (explicit log path), `UNITY_INSPECTOR_TOKEN_FILE` (explicit token file, authoritative: no search), `UNITY_INSPECTOR_HOST` (the host the user's game runs on, authoritative: no other host is tried; never the instance's, which is always `127.0.0.1`). `UNITY_INSPECTOR_TEST_RESULTS_DIR` overrides the root under which `run_test_script` writes each session's full results. `UNITY_INSPECTOR_MCP_STOP_WAIT_MS` shortens the wrapper's shutdown wait for the tests, and `UNITY_INSPECTOR_MCP_CLAIM_FILE` is the path the wrapper hands its child to record the `owner.pid` it wrote
- **stdio carries the MCP protocol** — NEVER let a child process write to stdout

### Adding a New MCP Tool

1. Tool definition (schema + description) in `toolDefinitions()`; every argument the `case` reads is declared in `inputSchema.properties`, since `handleToolCall()` refuses an undeclared key, with the `type` the mod reads it as (`integer` for an int), since that is what the value is checked against
2. `case` in the `handleToolCall()` switch
3. Game access: `result = await unityClient.sendCommand("method_name", params)`; a flag that picks a different mod command goes in `toolCommand()`, which `run_test_script`'s steps go through too
4. Node-only (file ops, process management): handle directly, no `sendCommand`
5. Matching handler in `BroforceMods/Unity Inspector Mod/Unity Inspector Mod/MessageHandler.cs`, reading numbers and booleans through its `ReadInt`, `ReadLong`, `ReadFloat` and `ReadBool`

## Rules files

Each loads when a file matching its `paths:` is read; read it directly when the work starts from the tools' side.

- `.claude/rules/instances.md` — per-session instances: target, launcher probe, instances root, ownership, launch, stop, `owner.pid`, the help channel
- `.claude/rules/game-process.md` — process detection, `launch_game`'s paths and waits, `stop_game`, `pollUntilResponsive()`, crash detection, the server's shutdown triggers
- `.claude/rules/connection.md` — the handshake and token search, command timeouts, cancellation
- `.claude/rules/wrapper.md` — `restart_server`, the respawn lockout, the wrapper's log, the reaper at session end
- `.claude/rules/tool-behaviour.md` — per-tool behaviour and reply fields, argument checking, `list_enemies`, the `execute_code` contract
- `.claude/rules/scripts.md` — the C# script library, `execute_script`, `run_test_script`'s shape, cleanup and `logs`
- `.claude/rules/logs.md` — `read_log`: which file, in what order, staleness, `onlyNew`
- `.claude/rules/animation-capture.md` — `capture_animations`: running a sweep, its server state and teardown, state lists, the in-game script
- `.claude/rules/testing.md` — the test fixtures and fences, the set to run before a pull request, the rule for changes, the matrix's conventions
- `.claude/rules/testing-matrix-server.md` — input-class matrix: server tests of the other tools and the handshake
- `.claude/rules/testing-matrix-node-tools.md` — input-class matrix: server tests of `capture_animations`, `list_scripts`, `list_test_scripts`, `read_log`, `restart_server`, `run_test_script`
- `.claude/rules/testing-matrix-launch-stop.md` — input-class matrix: server tests of `launch_game`, `stop_game`, `wait_for_game`
- `.claude/rules/testing-matrix-in-game.md` — input-class matrix: in-game steps
- `.claude/rules/testing-matrix-in-game-scripts.md` — input-class matrix: in-game steps of `capture_animations`, `execute_code`, `execute_script`, `run_test_script`, `unload_script`

