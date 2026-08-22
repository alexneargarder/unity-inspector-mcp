# Unity Inspector MCP Server

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent a live connection to a
running copy of [Broforce](https://store.steampowered.com/app/274190/Broforce/). It talks to the
**Unity Inspector Mod** inside the game over TCP, so the agent can walk the scene graph, read and
write component fields, move the player, simulate input, jump between levels, take screenshots, and
compile and run arbitrary C# — including Harmony patches — inside the live game process.

It is a modding and debugging tool: the loop of "change something, run it, look at what the game
actually did" happens without leaving the conversation.

```
MCP client (Claude Code, Codex, Cursor, ...)
        │  stdio (MCP)
        ▼
   wrapper.js          hot-reload proxy: injects restart_server,
        │  stdio       respawns index.js if it dies
        ▼
    index.js           MCP server: 33 tools, script library, log readers
        │  TCP 127.0.0.1:9999 (newline-delimited JSON)
        ▼
 Unity Inspector Mod   C# mod loaded by Unity Mod Manager
        │
        ▼
     Broforce
```

## Features

- **Scene inspection** — list and query GameObjects, dump components, read private fields.
- **State manipulation** — set component properties, teleport players, set health, change time scale.
- **Input simulation** — press or hold any game action for any player, including repeated presses.
- **Level control** — list campaigns, jump straight to a level, restart the current one.
- **Bro control** — list bros, set the next spawn, or hot-swap the current bro mid-level.
- **Runtime C#** — evaluate expressions, or compile whole classes, MonoBehaviours, and Harmony
  patches into the running game and unload them again cleanly.
- **A reusable script library** — source-controlled C# utilities with metadata the agent sees in
  the tool description, so it can pick the right one without being told.
- **Test scripts** — JSON command sequences for repeatable, scripted runs.
- **Log access** — read the mod manager log, or poll only what is new since the last check.
- **Process control** — launch, stop, and wait for the game; commands fail fast if it crashes.

## Requirements

- **Node.js 18 or newer** (tested on 22). No other runtime dependencies — the only npm dependency
  is the MCP SDK.
- **Broforce** with **Unity Mod Manager** and the **Unity Inspector Mod** installed.
- An MCP client — Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code, Windsurf, or any other
  MCP client.

## Installation

### 1. Install the Unity Inspector Mod

Nothing here works until the game side is in place. The mod lives in the
[BroforceMods](https://github.com/alexneargarder/BroforceMods) repository as the subproject
**Unity Inspector Mod**. Build or download it, install it with
[Unity Mod Manager](https://www.nexusmods.com/site/mods/21), and start the game.

Open the Unity Mod Manager overlay (`Ctrl+F10` by default) and find **Unity Inspector Mod**. It
shows the TCP server status, the port, the address it is bound to, and the number of connected
clients. The server auto-starts with the mod by default; if it is stopped, press **Start Server**.

The default port is **9999**. If you change it in the mod's settings, set `UNITY_INSPECTOR_PORT` to the same value in this server's `env` block so the two agree.

### 2. Install this server

```bash
git clone https://github.com/alexneargarder/unity-inspector-mcp
cd unity-inspector-mcp
./setup.sh
```

`setup.sh` checks for Node, installs dependencies, and prints client configuration with the correct
absolute path already filled in. Running `npm install` yourself does the same thing minus the
printout.

### 3. Configure your MCP client

Point the client at **`wrapper.js`**, not `index.js`. The wrapper is what provides
`restart_server` and keeps the server alive across crashes.

This is the standard configuration, and it works as-is in most MCP clients — Claude Desktop,
Cursor, Windsurf, Cline, and others:

```json
{
  "mcpServers": {
    "unity-inspector": {
      "command": "node",
      "args": ["/absolute/path/to/unity-inspector-mcp/wrapper.js"],
      "env": {
        "BROFORCE_LAUNCH_CMD": "/home/you/bin/launch-broforce --modded",
        "UNITY_INSPECTOR_PORT": "9999",
        "UNITY_INSPECTOR_LOG": "/path/to/UMM/Core/Log.txt"
      }
    }
  }
}
```

The whole `env` block is optional — see [Environment variables](#environment-variables) below. On
Windows, escape the backslashes in the path: `"C:\\path\\to\\unity-inspector-mcp\\wrapper.js"`.

Where each client keeps that config:

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add unity-inspector -- node /absolute/path/to/unity-inspector-mcp/wrapper.js
```

Environment variables go in `--env KEY=value` arguments before the `--`. Or write `.mcp.json` in
your project root using the standard config above, with `"type": "stdio"` alongside `"command"`.

</details>

<details>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json`, using the standard config above:

- Linux: `~/.config/Claude/claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

</details>

<details>
<summary><b>Codex CLI</b></summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.unity-inspector]
command = "node"
args = ["/absolute/path/to/unity-inspector-mcp/wrapper.js"]

[mcp_servers.unity-inspector.env]
BROFORCE_LAUNCH_CMD = "/home/you/bin/launch-broforce --modded"
```

Or from the CLI:

```bash
codex mcp add unity-inspector -- node /absolute/path/to/unity-inspector-mcp/wrapper.js
```

</details>

<details>
<summary><b>Cursor</b></summary>

The standard config above, in either:

- `~/.cursor/mcp.json` (all projects)
- `.cursor/mcp.json` (one project)

</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json`. Note the top-level key is **`servers`**, not `mcpServers`:

```json
{
  "servers": {
    "unity-inspector": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unity-inspector-mcp/wrapper.js"]
    }
  }
}
```

</details>

<details>
<summary><b>Windsurf</b></summary>

The standard config above, in `~/.codeium/windsurf/mcp_config.json`.

Windsurf does not interpolate environment variables in that file, so write literal values — no
`${VAR}` syntax. None of this server's settings are secrets, so nothing is lost by inlining them.

</details>

**WSL** (game on Windows, client in WSL) — run the server inside WSL and let it reach out to the
Windows host:

```json
{
  "mcpServers": {
    "unity-inspector": {
      "command": "wsl",
      "args": ["node", "/home/you/unity-inspector-mcp/wrapper.js"]
    }
  }
}
```

This setup **requires** enabling *Allow remote connections (LAN)* in the mod's settings — read
[Security](#security) first.

### Environment variables

All three are optional, and all three work the same way in any client that supports an `env` block
(in Codex's TOML, in an `[mcp_servers.unity-inspector.env]` table; in Windsurf, as literal values
only).

| Variable | Effect |
|---|---|
| `BROFORCE_LAUNCH_CMD` | Command line `launch_game` runs instead of the Steam URL. |
| `UNITY_INSPECTOR_PORT` | TCP port the mod listens on, if you changed it from 9999. |
| `UNITY_INSPECTOR_LOG` | Path to the Unity Mod Manager log, if it is somewhere unusual. |

`launch_game` uses Steam by default. If Broforce starts some other way on your machine — a wrapper
script, a Proton or distrobox launcher, a modded shortcut — set `BROFORCE_LAUNCH_CMD` to the full
command line. The value is tokenized like a shell command line, so quotes and escapes work as
expected.

## Platform notes

The server runs anywhere Node does, and detects its platform at startup.

| | Connection | `launch_game` | Process detection |
|---|---|---|---|
| **Linux** | `127.0.0.1:9999` | `steam steam://rungameid/274190`, falling back to `xdg-open` | `pgrep` / `pkill` |
| **Windows** | `127.0.0.1:9999` | `cmd /c start "" steam://rungameid/274190` | `tasklist` / `taskkill` |
| **macOS** | `127.0.0.1:9999` | `open steam://rungameid/274190` | `pgrep` / `pkill` |
| **WSL** | Windows host IP from `ip route show default` | as Linux (usually not useful — start the game on Windows) | `pgrep` / `pkill`, which cannot see Windows processes |

`BROFORCE_LAUNCH_CMD` overrides the launch column everywhere.

On Linux with a Proton install, and under WSL, screenshot paths returned by the game are Windows
paths; the server translates them into paths you can actually open (`Z:` and the Proton
`dosdevices` prefix on Linux, `/mnt/c/...` under WSL).

## Security

**The mod executes arbitrary C# for any client that can reach its port.** There is no
authentication, no allow-list, and no sandbox. Anything that can open a TCP connection to port 9999
can run code as your user.

By default the mod binds **127.0.0.1**, so only programs on the same machine can connect. That is
the configuration to stay in.

The mod's settings include **Allow remote connections (LAN)**, which rebinds the server to
`0.0.0.0`. This exists for one case: the MCP server running in a VM — typically WSL — while the
game runs on the host. Turning it on means **anyone on your network can run arbitrary code on the
machine running the game**. Only enable it on a network you trust, and turn it off when you are
done. The mod prints a warning to the log and to its settings panel while remote connections are
enabled.

## Tools

34 tools: 33 from the server plus `restart_server` from the wrapper.

### Game state and inspection

| Tool | Description |
|---|---|
| `ping` | Test the connection to the Unity Inspector Mod. |
| `game_state` | One-call orientation: scene, game mode, level, player status, bro type. |
| `list_gameobjects` | List GameObjects in the scene, with limits for inactive objects and result count. |
| `query_gameobjects` | Search GameObjects by name pattern and/or component type. |
| `inspect_gameobject` | Inspect one GameObject by path, optionally with full component details. |
| `inspect_component` | Inspect a single component on a GameObject. |
| `take_screenshot` | Capture the game window and return a path you can open locally. |

### Players and bros

| Tool | Description |
|---|---|
| `inspect_player` | Detailed state for the active player(s). |
| `teleport_player` | Move a player (or all players) to a coordinate. |
| `set_player_health` | Set a player's health. |
| `list_bros` | List every usable bro and report which one each player has selected. |
| `set_bro` | Choose the bro a player spawns as next — does not change the current one. |
| `swap_bro` | Swap a player's bro immediately, in place, mid-level. |

### Entities and world state

| Tool | Description |
|---|---|
| `list_enemies` | List enemies currently in the scene. |
| `spawn_entity` | Spawn an entity at a coordinate (limited entity coverage). |
| `modify_component` | Write properties on a component of a GameObject. |
| `set_game_speed` | Set the time scale (1.0 normal, 0.5 half, 2.0 double). |

### Input

| Tool | Description |
|---|---|
| `simulate_input` | Press or hold a game action for a player — `up`, `down`, `left`, `right`, `fire`, `jump`, `special`, `highFive`, `gesture`, `sprint`, `start`, `escape` — with optional hold duration or repeat count and interval. |

### Levels

| Tool | Description |
|---|---|
| `list_campaigns` | List campaigns with their indices. |
| `go_to_level` | Jump directly to a campaign/level pair. |
| `restart_level` | Restart the current level, clearing checkpoints and trigger state. |

### C# execution and the script library

| Tool | Description |
|---|---|
| `execute_code` | Evaluate a C# expression in the Unity context (expressions only — no `return`). |
| `execute_script` | Compile and run a full C# script file in the game: classes, MonoBehaviours, Harmony patches, private member access. |
| `compile_script` | Compile a script without running it, to check for compiler errors. |
| `list_scripts` | List the C# script library with each script's description, tags, and arguments. |
| `unload_script` | Unload a running script — unpatches its Harmony patches, destroys its GameObjects, calls its `Unload()`. |

### Test scripts

| Tool | Description |
|---|---|
| `list_test_scripts` | List the JSON test scripts in `scripts/` and `scripts/examples/`. |
| `run_test_script` | Run a JSON command sequence step by step and report per-step results and timings. |

### Logs

| Tool | Description |
|---|---|
| `read_log` | Read the mod manager log — last N lines, optionally filtered by substring. |
| `watch_log` | Return only log lines written since the previous call. Built for iterative debug loops. |

### Process management

| Tool | Description |
|---|---|
| `launch_game` | Launch Broforce and wait until it answers, with `restart` and `vanilla` options. |
| `stop_game` | Kill the running Broforce process. |
| `wait_for_game` | Poll until the game's TCP server responds, or time out. |

### Server management

| Tool | Description |
|---|---|
| `restart_server` | Restart `index.js` in place to pick up code changes. Provided by `wrapper.js`. |

## C# script library

`scripts/csharp/` holds source-controlled C# utilities that compile and run inside the game.
Each carries a metadata header (`// #name`, `// #description`, `// #tags`, `// #args`) that feeds
both `list_scripts` and the `execute_script` tool description, so the agent can choose a script and
supply its arguments unprompted. Scripts get an isolated Harmony instance, a logger, an argument
dictionary, and automatic cleanup of patches and GameObjects on unload.

Format, lifecycle, the `ScriptContext` API, and the .NET 3.5 constraints are documented in
[`scripts/csharp/README.md`](scripts/csharp/README.md).

Included scripts:

| Script | What it does |
|---|---|
| `find-by-type` | Find all live instances of a type with key state info. |
| `inspect-private-fields` | Dump every field, private included, of a component on a named GameObject. |
| `watch-field` | Log a field's value every time it changes, until unloaded. |
| `trace-method-calls` | Harmony-patch a method and log every call with its arguments. |
| `dump-harmony-patches` | List all Harmony patches on a method, with owner, type, and priority. |
| `menu-tweaker` | Live-edit FlexMenu element properties without rebuilding. **Requires the RocketLib mod.** |
| `rogueforce-runner` | Test harness for Rogueforce runs. **Requires the Rogueforce mod.** |

The other five work on any modded Broforce install.

Scripts outside the library can be run by absolute path; they simply do not appear in the catalog.

## Test scripts

JSON files describing a sequence of game commands with optional waits between them — useful for
reproducing a scenario the same way every time. `scripts/examples/` has three complete examples;
the format and tips are in [`scripts/README.md`](scripts/README.md).

Test script steps are dispatched straight to the game, so they can only use game-side commands.
Server-side tools (`read_log`, `watch_log`, `launch_game`, `wait_for_game`, ...) are rejected up
front with a message naming the offending step rather than failing partway through a run.

## Troubleshooting

**"Game is not running. Use launch_game to start it."** — the server could not open a TCP
connection. In order of likelihood:

1. Broforce is not running, or the Unity Inspector Mod did not load. Open the Unity Mod Manager
   overlay and check the mod is listed and enabled.
2. The mod's TCP server is stopped. Its settings panel shows the status; press **Start Server**.
3. The mod is on a non-default port. Set `UNITY_INSPECTOR_PORT` to match it (or set the mod back to 9999).
4. You are in WSL and *Allow remote connections (LAN)* is off. The mod is bound to the Windows
   machine's loopback, which WSL cannot reach. See [Security](#security) before enabling it.

If a Broforce process is running but not answering, `launch_game` says so explicitly instead of
starting a second copy — that combination almost always means the mod failed to load, and the log
will say why.

**Command timeouts.** Most commands allow 6 seconds. Scene-changing commands (`go_to_level`,
`restart_level`, `swap_bro`, `set_bro`, `take_screenshot`) get 10, `execute_code` and
`unload_script` get 10, and `execute_script` and `compile_script` get 30 because compilation is
slow. `simulate_input` with a repeat count is given time proportional to the count. A timeout
usually means the game is busy — a long level load, or a script doing too much work on the main
thread. If the game process actually dies, the server notices within half a second and reports a
likely crash instead of waiting out the timeout.

**Where the log is.** `read_log` and `watch_log` look for the Unity Mod Manager log in:

- Linux: `~/.config/r2modmanPlus-local/Broforce/profiles/<profile>/UMM/Core/Log.txt`
- Windows: `%APPDATA%\r2modmanPlus-local\Broforce\profiles\<profile>\UMM\Core\Log.txt`

Every r2modman/Thunderstore profile is checked and the most recently written log wins. A direct
Unity Mod Manager install is also probed at `<game>/Mods/UnityModManager/Log.txt`. If the log
lives somewhere else, set `UNITY_INSPECTOR_LOG` to its path — that override is authoritative, and
when nothing matches, the tools list every path they tried.

**The MCP server itself died.** The wrapper restarts `index.js` automatically, and answers any
in-flight request with an explanatory error. If the child crashes three times within 30 seconds the
wrapper stops respawning it and tells you where to look: `/tmp/mcp-wrapper-<pid>.log` holds both
the wrapper's log and everything the server wrote to stderr. Fix the problem, then call
`restart_server`.

## Development

**Hot reload.** After editing `index.js` or anything in `lib/`, call the `restart_server` tool.
The wrapper kills the child, spawns a fresh one, and replays the MCP `initialize` handshake, so the
client never notices the swap — no reconnect, no client restart. It is an ordinary MCP tool, so it
works from any client. Editing `wrapper.js` itself is the exception: that still needs a client-side
reconnect (in Claude Code, `/mcp`).

**Adding a tool** takes two edits in two repos:

1. In this repo, `index.js` — add the tool definition to the `ListToolsRequestSchema` handler, and
   a `case` in the `CallToolRequestSchema` switch. Tools that only need Node (file and process
   work) are handled there directly; game-side tools call
   `unityClient.sendCommand("method_name", params)`.
2. In [BroforceMods](https://github.com/alexneargarder/BroforceMods), `Unity Inspector
   Mod/MessageHandler.cs` — add the matching handler so the game knows the method.

If the tool can take longer than the default budget, give it a timeout in `commandTimeout()` in
`lib/unity-client.js`.

**Tests** run on Node's built-in test runner, with no test dependencies:

```bash
npm test
```

They cover the TCP client's framing, timeout, and reconnect behavior against a stub server, plus
the script library, launch-command resolution, and tool dispatch. Nothing in the suite needs the
game.

**Layout:**

```
wrapper.js              hot-reload proxy and restart_server
index.js                MCP server: tool definitions and dispatch
lib/unity-client.js     TCP client, framing, timeouts, crash detection
lib/game-process.js     launch/kill/detect Broforce per platform
lib/script-library.js   C# script catalog and JSON test-script runner
scripts/csharp/         C# script library
scripts/examples/       example JSON test scripts
test/                   node --test suites
test-support/           shared stubs for the test suite
```

One rule matters more than any other when working on this code: **stdout carries the MCP
protocol**. Child processes must be spawned with stdio ignored or piped, never inherited, and
diagnostics go to `console.error`. A single stray `console.log` corrupts the transport.

## License

GPL-3.0. See [LICENSE](LICENSE).
