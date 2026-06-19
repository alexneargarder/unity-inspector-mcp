# Unity Inspector MCP Server
<!-- claude-config: commit edits in this repo -->

Node.js MCP server bridging Claude to the Unity Inspector Mod running inside Broforce.

## Architecture

```
Claude Code --stdio/MCP--> wrapper.js --stdio--> index.js --TCP:9999--> Unity Inspector Mod (C#) --> Unity Game
```

- `wrapper.js` is a hot-reload proxy — proxies MCP messages between Claude Code and `index.js`, injects a `restart_server` tool
- `index.js` is the actual MCP server with all tool implementations
- **stdio** carries the MCP protocol — NEVER let child processes write to stdout (use `spawn` with `stdio: "ignore"`)
- TCP JSON protocol: `{"id":"...","method":"...","params":{...}}\n` → `{"id":"...","success":true,"result":{...}}\n`
- Some tools are Node.js-only (file operations, process management), others route through TCP to the game

### Hot Reload (wrapper.js)

- `.mcp.json` points to `wrapper.js`, which spawns `index.js` as a child
- `restart_server` tool: kills the child, respawns it, replays the MCP `initialize` handshake — Claude Code doesn't notice the swap
- Use `restart_server` after modifying `index.js` instead of asking the user to `/mcp`
- The wrapper itself is thin (~200 lines) — changes to wrapper.js still require manual `/mcp` or Claude Code restart
- **id=0 gotcha**: MCP protocol uses `id: 0` for the init message — always use `!== undefined && !== null` checks, never truthiness checks on message ids

### Adding a New MCP Tool

1. Add tool definition in `ListToolsRequestSchema` handler (schema + description)
2. Add `case` in `CallToolRequestSchema` handler switch
3. If it needs game access: `result = await unityClient.sendCommand("method_name", params)`
4. If Node.js-only (file ops, process management): handle directly without `sendCommand`
5. Add matching handler in `BroforceMods/Unity Inspector Mod/Unity Inspector Mod/MessageHandler.cs`

### Timeouts

Default TCP timeout is 2 seconds. Override in `sendCommand()` for slow operations:
- `execute_script` / `compile_script`: 30 seconds
- `unload_script`: 10 seconds
- `simulate_input` with count: calculated from count × interval

### Crash Detection

`sendCommand` polls `pgrep` every 500ms while waiting for a response. If the game process dies, immediately returns `"Game process died — the command likely caused a crash"` instead of waiting for timeout.

### C# Script System (Node.js side)

- **Script library**: `scripts/csharp/` — source-controlled `.cs` files with comment-header metadata
- **Metadata parsing**: `parseScriptMetadata()` reads `// #name`, `// #description`, `// #tags`, `// #args` from file headers
- **`list_scripts`**: Node.js-only — scans `scripts/csharp/`, parses metadata, returns catalog
- **`execute_script` / `compile_script`**: Node.js reads the file, sends source over TCP (not file path — game may run under Proton with different filesystem)
- **Dynamic tool description**: `execute_script` tool description includes current script catalog, rebuilt on each `ListToolsRequestSchema` call
- **MCP resource**: `scripts://csharp/catalog` exposes script catalog (not auto-injected, but available for explicit reading)

### Game Process Management

- `launch_game`: spawns `bf` with detached stdio, polls for TCP connectivity
- `stop_game`: kills via `pkill` with detached stdio
- Both use `spawn` with `stdio: "ignore"` — NEVER `exec()` which inherits stdio and corrupts MCP transport
