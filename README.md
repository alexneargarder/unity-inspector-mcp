# unity-inspector-mcp

This lets an MCP client inspect and change things in Broforce while the game is running. It's mainly for modding and debugging. It works with the Unity Inspector Mod, a C# mod loaded by Unity Mod Manager, and the two talk over TCP on localhost, port 9999 by default. The server runs on Linux, Windows and macOS.

## Requirements

- Node.js 18 or newer. I've tested on 22, and the MCP SDK is the only npm dependency.
- Broforce with Unity Mod Manager and the Unity Inspector Mod.
- An MCP client. There are configs below for Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code and Windsurf.

## Installing the mod

Install the mod first. There's no prebuilt download, so clone the [BroforceMods repo](https://github.com/alexneargarder/BroforceMods) and build the Unity Inspector Mod project yourself, then put the built folder in Broforce's `Mods` directory like any other Unity Mod Manager mod. On r2modman it goes in `UMM/Mods` inside the profile folder instead. Here's a [guide for installing Unity Mod Manager and mods](https://steamcommunity.com/sharedfiles/filedetails/?id=2434812447) if you haven't done that before.

Open the Unity Mod Manager overlay in game (Ctrl+F10 by default) and click on the mod. Its panel shows whether the TCP server is running, the port, the address it's bound to and how many clients are connected, and there's a Start Server button if it's stopped. If you change the port from 9999, set `UNITY_INSPECTOR_PORT` on the server side to match.

## Installing the server

```bash
git clone https://github.com/alexneargarder/unity-inspector-mcp
cd unity-inspector-mcp
./setup.sh
```

`setup.sh` checks for Node, installs the dependencies and prints the client config with the absolute path already filled in. A plain `npm install` works too, you just don't get the printed config.

## Client configuration

The config has to point at `wrapper.js`, not `index.js`. The wrapper provides the `restart_server` tool and respawns the server if it crashes.

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

The `env` block is optional and so is each variable in it. On Windows the backslashes have to be escaped: `"C:\\path\\to\\unity-inspector-mcp\\wrapper.js"`. That config works as is in Claude Desktop, Cursor, Windsurf and Cline:

- Claude Desktop: `claude_desktop_config.json`, at `~/.config/Claude/` on Linux, `~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows.
- Cursor: `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one.
- Windsurf: `~/.codeium/windsurf/mcp_config.json`. It doesn't interpolate environment variables, so use literal values, no `${VAR}`. None of these settings are secrets so nothing is lost by inlining them.

Claude Code takes a command instead:

```bash
claude mcp add unity-inspector -- node /absolute/path/to/unity-inspector-mcp/wrapper.js
```

Environment variables go in as `--env KEY=value` arguments before the `--`. You can also put a `.mcp.json` in the project root with the standard config plus `"type": "stdio"` next to `"command"`.

Codex CLI uses `~/.codex/config.toml`:

```toml
[mcp_servers.unity-inspector]
command = "node"
args = ["/absolute/path/to/unity-inspector-mcp/wrapper.js"]

[mcp_servers.unity-inspector.env]
BROFORCE_LAUNCH_CMD = "/home/you/bin/launch-broforce --modded"
```

Or `codex mcp add unity-inspector -- node /absolute/path/to/unity-inspector-mcp/wrapper.js`.

VS Code uses `.vscode/mcp.json`, where the top level key is `servers`, not `mcpServers`, and each server also needs `"type": "stdio"`.

### WSL

If the game is on Windows and your MCP client is in WSL, the server runs in WSL and connects to the Windows host IP it gets from `ip route show default`:

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

Launching and stopping the game don't work from there, since `pgrep` can't see Windows processes. You'd start the game on Windows yourself. This setup also needs the mod's "Allow remote connections (LAN)" setting turned on. The mod compiles and runs whatever C# gets sent to its port and there's no authentication on it, so any process that can reach the port can run code as whoever is running the game. It binds to 127.0.0.1 by default, and remote connections rebind it to 0.0.0.0, so while that's on, anyone on your network can run code on the game machine.

## Environment variables

All of these are optional and go in the `env` block (the `[mcp_servers.unity-inspector.env]` table in Codex, literal values only in Windsurf).

| Variable | Default | Effect |
|---|---|---|
| `UNITY_INSPECTOR_PORT` | `9999` | TCP port the mod listens on. |
| `BROFORCE_LAUNCH_CMD` | the Steam protocol launch of app 274190 | Command line `launch_game` runs to start your own game. |
| `BROFORCE_INSTANCE_CMD` | unset, and there are no instances | The launcher that creates and runs this session's own game instance. |
| `BROFORCE_STOP_CMD` | unset, and the game is stopped by signalling its own process | Command line `stop_game` runs to stop your own game. |
| `UNITY_INSPECTOR_LOG` | unset, and the server searches for the log itself | Path to the Unity Mod Manager log. |

The other four are about your own game, never about a session's instance, which takes its port and its logs from `BROFORCE_INSTANCE_CMD`'s launcher instead.

`launch_game` goes through Steam by default. `BROFORCE_LAUNCH_CMD` replaces that with a full command line, like a Proton launcher script, parsed into a command plus arguments with shell-style quoting. It runs exactly as you configured it, with `--vanilla` added for a vanilla launch and whatever `launchArgs` holds appended.

If your launch command's `--help` lists `--args-help`, the server runs the command again with that flag and quotes what it prints in `launch_game`'s description, capped at 1 KB. A command whose `--help` doesn't list the flag is never handed it, and the description says instead that no argument help is published and `launchArgs` pass through as given.

`stop_game` and `launch_game { restart: true }` run `BROFORCE_STOP_CMD` to stop your own game. If it doesn't stop the game, the server signals the game's own process and the reply says so. Leave it unset and the signal is all there is. It is never run for a session's instance, which stops through its own launcher.

## Separate game instances

On Linux, each Claude Code session can get its own game instance. An instance is a second copy of the game with its own profile, settings, saves, logs, TCP port and virtual display, so an agent can play with its own game while you play yours. `BROFORCE_INSTANCE_CMD` turns this on and names the launcher that creates and runs the instance. Leave it unset and there are no instances, and the server serves your own game.

`launch_game` with no arguments starts this session's instance and points the server at it, and `launch_game { steam: true }` launches your own game and points the server there instead. The two games never touch each other. `stop_game` stops whichever one the server is pointed at, and `stop_game { remove: true }` deletes the instance directory afterwards, so the next launch builds it fresh. `game_state` names the target on every reply, along with the instances currently running. `read_log` and `watch_log` read the instance's own `profile/UMM/Core/Log.txt` and `home/unity3d/Free Lives/Broforce/Player.log`.

Your session's instance is stopped when the session ends. Reconnecting the client on the same session id keeps it running, and the new server picks it up.

None of this applies off Linux, where the server serves the one game it finds.

Writing a launcher of your own: [docs/launcher-contract.md](docs/launcher-contract.md) is the contract it has to implement.

## Tools

There are 35, 34 from the server and `restart_server` from the wrapper.

| Tool | Description |
|---|---|
| `ping` | Test the connection to the mod. |
| `game_state` | The loaded level, game mode, player status and bro type in one call. `scene` is the one Unity scene every level plays in, so `campaignName`, `campaignDisplay`, `levelName` and `levelNumber` are what identify the level. |
| `list_gameobjects` | List GameObjects in the scene. |
| `query_gameobjects` | Search GameObjects by name pattern and/or component type. A component type on its own works, and it matches base types and interfaces, so asking for `Projectile` finds subclasses too. |
| `inspect_gameobject` | Inspect one GameObject by path, with optional component details. |
| `inspect_component` | Inspect a single component, including its static fields and properties. |
| `take_screenshot` | Capture the game window and return the path. An optional `highlight` outlines a GameObject path or a `{x, y, width, height}` rectangle in world units for that one frame. |
| `inspect_player` | Detailed state for the active player(s). |
| `teleport_player` | Move a player (or all players) to a coordinate. |
| `set_player_health` | Set a player's health. |
| `list_bros` | List usable bros and which one each player has. Requires Swap Bros Mod. |
| `set_bro` | Choose the bro a player spawns as next. Does not change the current one. Requires Swap Bros Mod. |
| `swap_bro` | Swap a player's bro immediately, in place, mid-level. Requires Swap Bros Mod. |
| `list_enemies` | List the live enemies in the loaded level, from the game's own unit registry plus a scene sweep, classified by the game's own enemy test, so aliens, hell units, vehicles and bosses are covered as well as mooks. An empty list says whether a level is loaded at all. If one is, `enemySpawnSuppressed` says a suppressor is active right now (Utility Mod with `disableEnemySpawn` on) and `enemySpawnPrefixOwners` lists every mod that could suppress spawning. |
| `spawn_entity` | Spawn a unit at a coordinate in the loaded level, with optional initial velocity. The type is any RocketLib `UnitType`, given as its enum name or its display name. The prefab comes from the level's theme or the shared assets, and most units are the theme's, so a type this level's theme holds no prefab for fails naming that. Try a level whose theme has it. An unknown name comes back with the list of the names that exist. |
| `modify_component` | Write fields and properties on a component, instance or static. Each property that could not be written comes back with a reason: not found, read-only, or a conversion error. |
| `set_game_speed` | Set the time scale (1.0 is normal). |
| `simulate_input` | Press or hold a game action for a player, with an optional hold duration or repeat count, or run an ordered sequence of held steps and pauses in one call. |
| `list_campaigns` | List campaigns with their indices. |
| `go_to_level` | Go directly to a campaign/level pair. |
| `restart_level` | Restart the current level, clearing checkpoints and trigger state. |
| `execute_code` | Run C# in the Unity context: statements, local declarations and a trailing `return` all work, and a trailing expression comes back as the value. Locals last for the one call. Exceptions thrown by submitted code come back with their stack trace, plus the line and text of the statement that was running. |
| `execute_script` | Compile and run a full C# script in the game, Harmony patches and private members included. |
| `compile_script` | Compile a script without running it, to check for compiler errors. |
| `list_scripts` | List the C# script library with descriptions, tags and arguments. |
| `unload_script` | Unload a running script, unpatching it and destroying its GameObjects. |
| `list_test_scripts` | List the JSON test scripts. |
| `run_test_script` | Run a JSON command sequence and report each step, checking any per-step `expect` so a step can be required to fail. |
| `capture_animations` | Sweep a bro's animation states into PNG frame strips with the game clock held at zero, and report which sprite-sheet cells each state addressed against what the state list expected. |
| `read_log` | Read the last N lines of the mod manager log, with an optional filter. |
| `watch_log` | Return only the log lines written since the previous call. |
| `launch_game` | Launch Broforce and wait until it answers, with `restart`, `vanilla` and `launchArgs` options. If it never answers, it reports which failure mode it hit, same as `wait_for_game`. |
| `stop_game` | Stop the Broforce process this server is responsible for. |
| `wait_for_game` | Poll until the game responds, or time out. A timeout says which case it was: no process, nothing listening on the port, connected but no reply, or a connection that got closed. |
| `restart_server` | Restart `index.js` in place to pick up code changes. Provided by `wrapper.js`. |

Under Proton and WSL the game returns Windows paths for screenshots, and the server translates those into paths you can open locally.

## C# scripts

`scripts/csharp/` has a library of scripts committed to the repo: `find-by-type`, `inspect-private-fields`, `watch-field`, `trace-method-calls`, `spawn-capture` and `dump-harmony-patches`, which work on any modded install, plus `menu-tweaker` and `diff-component` (both need the RocketLib mod) and `rogueforce-runner` (needs the Rogueforce mod). Each one has a header of `// #name`, `// #description`, `// #tags` and `// #args` comments. `list_scripts` and the `execute_script` tool description both report that metadata, so the agent can pick a script and fill in its arguments on its own.

A script gets its own Harmony instance, a logger and a dictionary of its arguments, and its patches and GameObjects are cleaned up when it unloads. The format, the lifecycle, the ScriptContext API and the .NET 3.5 constraints are in [scripts/csharp/README.md](scripts/csharp/README.md). You can run a script that isn't in the library by passing an absolute path to it, it just won't show up in the catalog.

Once a script is loaded, the types it defines are in scope for `execute_code`, by name or through reflection. `GetMethodBody()` on one of its methods takes the game process down though.

## Test scripts

Test scripts are JSON files with a sequence of game commands and optional waits between the steps, for reproducing the same scenario identically every run. Every test script in the repo is in `scripts/tests/`: three examples and the repo's own contract checks. A script of your own runs by absolute path, and the format is covered in [scripts/README.md](scripts/README.md). Steps go straight to the game, so server side tools like `read_log` and `launch_game` get rejected before the run starts.

The `capture_animations` tool drives its own in-game script end to end — level, bro swap, sweep, report — out of `lib/animation-capture/`, where relative `states` names resolve and `states/base-states.json` is the shape a state list follows.

## Troubleshooting

"Game is not running. Use launch_game to start it." means the server couldn't open the TCP connection. Most likely causes, in order:

1. The game isn't running, or the mod didn't load. Check that the Unity Mod Manager overlay lists the mod and that it's enabled.
2. The mod's TCP server is stopped. Its settings panel shows the status and has a Start Server button.
3. The mod is on a port other than the default one. Set `UNITY_INSPECTOR_PORT` to match, or set the mod back to 9999.
4. You're on WSL with "Allow remote connections (LAN)" turned off. The mod is bound to the Windows loopback and WSL can't reach it.

If the game process is there but doesn't answer, `launch_game` reports that instead of starting a second copy. That's almost always the mod failing to load, and the log will have the reason.

Most commands get 6 seconds. The level and bro changing ones, plus `take_screenshot`, `execute_code` and `unload_script`, get 10, and `execute_script` and `compile_script` get 30 since compiling is slow. The mod gives `execute_code` 9 seconds of its own, just under the server's 10, so code that runs too long comes back as the mod's diagnostic rather than a bare client side timeout. A timeout usually just means the game is busy with a long level load or a script that's overloading the main thread, and if the game dies partway through a command the server notices within half a second and reports a likely crash.

`read_log` and `watch_log` look for the Unity Mod Manager log at `~/.config/r2modmanPlus-local/Broforce/profiles/<profile>/UMM/Core/Log.txt` on Linux and `%APPDATA%\r2modmanPlus-local\Broforce\profiles\<profile>\UMM\Core\Log.txt` on Windows. They also check the Unity player log (`Player.log` or `output_log.txt`, depending on the Unity version), under `~/.config/unity3d/Free Lives/Broforce/` on Linux, `%USERPROFILE%\AppData\LocalLow\Free Lives\Broforce\` on Windows, the same folder inside the Proton prefix, `~/Library/Logs/` on macOS, and `Broforce_Data/output_log.txt` next to the game. The player log is always there and gets the same Unity Mod Manager and mod lines, while on a doorstop launch the Unity Mod Manager log sometimes never turns up, and sometimes appears a few seconds after startup and is written to alongside the player log. While the game is running they prefer the profile it was launched from, when the launcher's command line reveals it, and fall back to the player log when that profile has no log the running game has written to. Otherwise they check every candidate and take the most recently written one. A direct Unity Mod Manager install gets checked too, at `<game>/Mods/UnityModManager/Log.txt`. `UNITY_INSPECTOR_LOG` overrides the search entirely, and if no log turns up the error lists every path that was tried.

Both tools report which file they read and when it was last written, and if the game is running and that file is older than the game process, they say so instead of quietly handing back a log nothing is writing to. Since a fresh Unity Mod Manager log wins as soon as it exists, the file being read can switch from the player log to it once during a run, at the point it appears, and `watch_log` starts a new baseline when that happens, so you get the new file's tail rather than a slice cut at the old file's offset.

If the MCP server itself crashes, the wrapper restarts `index.js` and any in-flight requests get an error back, though it gives up after three crashes inside 30 seconds. `/tmp/mcp-wrapper-<pid>.log` has the wrapper's log plus everything the server wrote to stderr, and `restart_server` starts it back up once you've fixed the problem.

## Development

After editing `index.js` or anything in `lib/`, the `restart_server` tool restarts the server in place and replays the MCP initialize handshake, so the client keeps its session. Editing `wrapper.js` itself needs a reconnect on the client side (`/mcp` in Claude Code).

Adding a tool takes two edits. In `index.js` it needs a definition in the `ListToolsRequestSchema` handler and a case in the switch, where game tools call `unityClient.sendCommand("method_name", params)`. Then it needs a matching handler in `Unity Inspector Mod/MessageHandler.cs` over in the BroforceMods repo. If it takes longer than the 6 second budget, add a timeout for it in `commandTimeout()` in `lib/unity-client.js`.

The tests are `npm test` with Node's built in runner and no test dependencies, and none of them need the game running. Watch out for stdout, since it carries the MCP protocol and one stray `console.log` corrupts it.
