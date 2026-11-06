# unity-inspector-mcp

This lets an MCP client inspect and change things in Broforce while the game is running. It's mainly for modding and debugging. It works with the Unity Inspector Mod, a C# mod loaded by Unity Mod Manager, and the two talk over TCP on localhost, port 9999 by default. The server runs on Linux, Windows and macOS.

## Requirements

- Node.js 18 or newer. I've tested on 22, and the MCP SDK is the only npm dependency.
- Broforce with Unity Mod Manager and the Unity Inspector Mod.
- An MCP client. There are configs below for Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code and Windsurf.

## Installing the mod

Install the mod first. There's no prebuilt download, so clone the [BroforceMods repo](https://github.com/alexneargarder/BroforceMods) and build the Unity Inspector Mod project yourself, then put the built folder in Broforce's `Mods` directory like any other Unity Mod Manager mod. On r2modman it goes in `UMM/Mods` inside the profile folder instead. Here's a [guide for installing Unity Mod Manager and mods](https://steamcommunity.com/sharedfiles/filedetails/?id=2434812447) if you haven't done that before.

Open the Unity Mod Manager overlay in game (Ctrl+F10 by default) and click on the mod. Its panel shows whether the TCP server is running, the port, the address it's bound to and how many clients are connected, and there's a Start Server button if it's stopped. If you change the port from 9999, set `UNITY_INSPECTOR_PORT` on the server side to match. Update the mod and the server together, since a mismatched pair refuses to connect and the error says which one to update.

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

If the game is on Windows and your MCP client is in WSL, the server runs in WSL and tries `127.0.0.1` first, then the Windows host it gets from the default route in `ip route show default`:

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

`launch_game` and `stop_game` refuse your own game there, since the server can't see Windows processes from WSL and so can't tell whether it is running or stop it. You'd start and stop the game on Windows yourself. Under WSL2's default NAT networking the game is reached only through the Windows host, which needs the mod's "Allow remote connections (LAN)" setting turned on and Broforce allowed through the Windows firewall; WSL1 and WSL2's mirrored networking reach it on `127.0.0.1` with that setting off. The mod binds to 127.0.0.1 by default, and remote connections rebind it to 0.0.0.0, so its port is open to your network while that's on. `UNITY_INSPECTOR_HOST` names the host outright. The server finds the mod's token file under every `/mnt/c/Users/<user>/AppData/LocalLow/Free Lives/Broforce`, or under the drive root your `/etc/wsl.conf` `[automount]` names.

## Environment variables

All of these are optional and go in the `env` block (the `[mcp_servers.unity-inspector.env]` table in Codex, literal values only in Windsurf).

| Variable | Default | Effect |
|---|---|---|
| `UNITY_INSPECTOR_PORT` | `9999` | TCP port the mod listens on. |
| `BROFORCE_LAUNCH_CMD` | Steam's `-applaunch` of app 274190 with the `BROFORCE_PROFILE` profile's Doorstop arguments; on macOS, or with no Steam executable found, the Steam protocol launch | Command line `launch_game` runs to start your own game. |
| `BROFORCE_PROFILE` | `Default` | The r2modman profile the Steam launch loads Unity Mod Manager from: a name, or the profile's folder as an absolute path. Unset, with no `Default` profile, the game starts the way its own install loads mods. |
| `BROFORCE_LAUNCH_TYPE` | `auto`, which is Proton when the game folder has a `.forceproton` file or an `.exe` | `native` or `proton`: how the Steam launch on Linux runs the game. |
| `BROFORCE_INSTANCE_CMD` | unset, and there are no instances | The launcher that creates and runs this session's own game instance. |
| `BROFORCE_STOP_CMD` | unset, and the game is stopped by signalling its own process | Command line `stop_game` runs to stop your own game. |
| `UNITY_INSPECTOR_LOG` | unset, and the server searches for the log itself | Path to the log `read_log` reads: Unity's player log, or the Unity Mod Manager log. |
| `UNITY_INSPECTOR_TOKEN_FILE` | unset, and the server searches the game's data folders itself | Path to the token file the mod writes. |
| `UNITY_INSPECTOR_HOST` | `127.0.0.1`, or on WSL that and then the Windows host | Host your own game runs on. A game on another machine needs the mod's "Allow remote connections (LAN)" setting on, and a copy of its token file named in `UNITY_INSPECTOR_TOKEN_FILE`, taken again each time the mod's server starts; the server can't see or stop that game's process. |

The other eight are about your own game, never about a session's instance, which takes its port, its logs and its token from `BROFORCE_INSTANCE_CMD`'s launcher instead.

`launch_game` goes through Steam by default. `BROFORCE_LAUNCH_CMD` replaces that with a full command line, like a Proton launcher script, parsed into a command plus arguments with shell-style quoting. It runs exactly as you configured it, with `--vanilla` added for a vanilla launch and whatever `launchArgs` holds appended. `launchArgs` reach whichever launch the call runs, this command with `steam: true` and the instance launcher's `instance <id> launch` by default, so an option of one is not an option of the other.

If your launch command's `--help` lists `--args-help`, the server runs the command again with that flag and quotes what it prints in `launch_game`'s description. The instance launcher is asked the same way once its `--help` has shown it runs instances and this session has an instance of its own, and each answer is quoted under the launch it belongs to, 1 KB of each. A program that runs both launches can label what each one takes, in the form [the launcher contract](docs/launcher-contract.md) gives. A command whose `--help` doesn't list the flag is never handed it, and the description says instead that no argument help is published and `launchArgs` pass through as given.

`stop_game` and `launch_game { restart: true }` run `BROFORCE_STOP_CMD` to stop your own game. If it doesn't stop the game, the server signals the game's own process and the reply says so. Leave it unset and the signal is all there is. It is never run for a session's instance, which stops through its own launcher.

## Separate game instances

On Linux, each Claude Code session can get its own game instance. An instance is a second copy of the game with its own profile, settings, saves, logs, TCP port and virtual display, so an agent can play with its own game while you play yours. `BROFORCE_INSTANCE_CMD` turns this on and names the launcher that creates and runs the instance. Leave it unset and there are no instances, and the server serves your own game.

`launch_game` with no arguments starts this session's instance and points the server at it, and `launch_game { steam: true }` launches your own game and points the server there instead. The two games never touch each other. `stop_game` stops whichever one the server is pointed at, and `stop_game { remove: true }` deletes the instance directory afterwards, so the next launch builds it fresh. `game_state` names the target on every reply, along with the instances currently running and which store's build the game is. `read_log` reads the instance's own `home/unity3d/Free Lives/Broforce/Player.log`, or its `profile/UMM/Core/Log.txt` when the game is not writing the player log.

Your session's instance is stopped 15 seconds after the session ends. Reconnecting the client on the same session id within that time keeps it running, and the new server picks it up.

None of this applies off Linux, where the server serves the one game it finds.

Writing a launcher of your own: [docs/launcher-contract.md](docs/launcher-contract.md) is the contract it has to implement.

## Tools

There are 33, 32 from the server and `restart_server` from the wrapper. A call that fails comes back as an MCP error: a reply whose `success` is false keeps its JSON body, and a refused or thrown call is `Error: <message>`.

| Tool | Description |
|---|---|
| `ping` | Test the connection to the mod, and whether the game's main thread answers. |
| `game_state` | The loaded level, game mode, player status and bro type in one call. `scene` is the one Unity scene every level plays in, so `campaignName`, `campaignDisplay`, `levelName` and `levelNumber` are what identify the level, all null off a level. |
| `list_gameobjects` | List the root GameObjects of the loaded scenes, each with its `instanceId`. |
| `query_gameobjects` | Search the loaded scenes' GameObjects by name pattern and/or component type. A component type on its own works, and it matches base types and interfaces, so asking for `Projectile` finds subclasses too. |
| `inspect_gameobject` | Inspect one GameObject by path or `instanceId`, with optional component details. |
| `inspect_component` | Inspect a single component, including its static fields and properties, or read one member of it. |
| `take_screenshot` | Capture the game window and return the path. An optional `highlight` outlines a GameObject path, an `{instanceId}`, or a `{x, y, width, height}` rectangle in world units for that one frame. |
| `inspect_player` | Detailed state for the active player(s). |
| `teleport_player` | Move a player (or all players) to a coordinate. |
| `set_player_health` | Set a player's health. |
| `list_bros` | List usable bros and which one each player has. Requires Swap Bros Mod. |
| `swap_bro` | Swap a player's bro immediately, in place, mid-level. `ignoreUnlocks` allows bros not yet unlocked for that one swap, every installed custom bro, locked or disabled included. `nextSpawn` instead chooses the bro the player spawns as next and leaves the current one. Requires Swap Bros Mod. |
| `list_enemies` | List the enemies in the loaded level, dead ones still lying there included with `isAlive: false` and left out of `aliveCount`, from the game's own unit registry plus a scene sweep, classified by the game's own enemy test, so aliens, hell units, vehicles and bosses are covered as well as mooks. `mapLoaded` says whether a level is loaded at all. If one is, every reply carries `enemySpawnSuppressed`, which says a suppressor is active right now (Utility Mod with `disableEnemySpawn` on) and `enemySpawnPrefixOwners` lists every mod that could suppress spawning. |
| `spawn_entity` | Spawn a unit at a coordinate in the loaded level, with optional initial velocity. The type is any RocketLib `UnitType`, given as its enum name or its display name. An unknown name comes back with the list of the names that exist. `ignoreSuppression` lifts Utility Mod's `disableEnemySpawn` for that one spawn. |
| `trace_spawns` | Record the game's mook, projectile and (on request) doodad spawn calls, then read them back by sequence number, until stopped or the server reconnects, which `restart_server` always does. |
| `modify_component` | Write fields and properties on a component, instance or static, and read each back. Each property that could not be written, or did not hold the value, comes back with a reason. |
| `set_game_speed` | Set the time scale (1.0 is normal), checked a frame later; a scene load, a cutscene or the game's own slow motion resets it. |
| `simulate_input` | Press or hold a game action for a player, with an optional hold duration or repeat count, run an ordered sequence of held steps and pauses in one call, or press a mod's RocketLib key binding by name; the reply counts the frames on which the game read each press. |
| `list_campaigns` | List campaigns with their indices. |
| `go_to_level` | Go directly to a campaign/level pair, replying once the level is in play or a cutscene holds it. |
| `restart_level` | Restart the current level, clearing checkpoints and trigger state, replying once it is in play again or a cutscene holds it. |
| `execute_code` | Run C# in the Unity context: statements, local declarations and `return` all work, and a trailing expression comes back as the value. Locals last for the one call. Exceptions thrown by submitted code come back with their stack trace, plus the line and text of the statement that was running. Code still running after 9 seconds is stopped at its next loop iteration or method call. |
| `execute_script` | Compile and run a full C# script in the game, Harmony patches and private members included. `compileOnly` compiles without running, to check for compiler errors. |
| `list_scripts` | List the C# script library with descriptions, tags and arguments. |
| `unload_script` | Unload a running script, unpatching it and destroying its GameObjects and the components it added. |
| `list_test_scripts` | List the JSON test scripts. |
| `run_test_script` | Run a JSON command sequence and report each step, checking any per-step `expect` so a step can be required to fail. |
| `capture_animations` | Sweep a bro's animation states into PNG frame strips with the game clock held at zero, and report which sprite-sheet cells each state addressed against what the state list expected. |
| `read_log` | Read the last N lines of the game's log, with an optional filter, or with `onlyNew` only the lines written since the previous such call. |
| `launch_game` | Launch Broforce and wait until it answers, with `restart`, `vanilla` and `launchArgs` options. If it never answers, it reports which failure mode it hit, same as `wait_for_game`. |
| `stop_game` | Stop the Broforce process this server is responsible for. |
| `wait_for_game` | Poll until the game responds, or time out. A timeout says which case it was: no process, nothing listening on the port, connected but no reply, or a connection that got closed. A connection the mod refuses ends it at once. |
| `restart_server` | Restart `index.js` in place to pick up code changes. Provided by `wrapper.js`. |

Under Proton and WSL the game returns Windows paths for screenshots, and the server translates those into paths you can open locally, for a game in any Steam library, Flatpak Steam's included.

## C# scripts

`scripts/csharp/` has a library of scripts committed to the repo: `find-by-type`, `inspect-private-fields`, `watch-field`, `trace-method-calls`, `spawn-capture` and `dump-harmony-patches`, which work on any modded install, plus `menu-tweaker` and `diff-component` (both need the RocketLib mod) and `rogueforce-runner` (needs the Rogueforce mod), whose `action` starts a run while `execute_code` calls `RogueforceRunner.Status()`, `Skip()`, `Layout()`, `Seed()` or `Seed(n)` on a loaded one. Each one has a header of `// #name`, `// #description`, `// #tags` and `// #args` comments. `list_scripts` reports that metadata, so the agent can pick a script and fill in its arguments on its own.

A script gets its own Harmony instance, a logger and a dictionary of its arguments, and its patches and GameObjects are cleaned up when it unloads. The format, the lifecycle, the ScriptContext API and the .NET 3.5 constraints are in [scripts/csharp/README.md](scripts/csharp/README.md). You can run a script that isn't in the library by passing an absolute path to it, it just won't show up in the catalog.

Once a script is loaded, the types it defines are in scope for `execute_code`, by name or through reflection. `GetMethodBody()` on one of its methods and a Harmony patch on one are refused, since reading that method's body would take the game process down.

## Test scripts

Test scripts are JSON files with a sequence of game commands and optional waits between the steps, for reproducing the same scenario identically every run. Every test script in the repo is in `scripts/tests/`: three examples, the repo's own contract checks and the `scenario-*` scripts that play through the menus, a level, bro swaps and player joins. A script of your own runs by absolute path, and the format is covered in [scripts/README.md](scripts/README.md). Steps go straight to the game, so server side tools like `read_log` and `launch_game` get rejected before the run starts.

The `capture_animations` tool drives its own in-game script end to end — level, bro swap, sweep, report — out of `lib/animation-capture/`, where relative `states` names resolve and `states/base-states.json` is the shape a state list follows.

## Troubleshooting

"Game is not running. Use launch_game to start it." means the server couldn't open the TCP connection. Most likely causes, in order:

1. The game isn't running, or the mod didn't load. Check that the Unity Mod Manager overlay lists the mod and that it's enabled.
2. The mod's TCP server is stopped. Its settings panel shows the status and has a Start Server button.
3. The mod is on a port other than the default one. Set `UNITY_INSPECTOR_PORT` to match, or set the mod back to 9999.
4. You're on WSL2's default networking with "Allow remote connections (LAN)" turned off, or the Windows firewall blocks Broforce. The mod is bound to the Windows loopback and WSL can't reach it.

When the game is running but nothing answers, the error says the mod may still be loading, its server may be stopped or the port may differ; when the game's process can't be seen, as on WSL or with `UNITY_INSPECTOR_HOST`, it says it can't tell whether the game is running.

If the mod refuses the connection, the error says why. The mod writes its token to `unity-inspector-<port>.token` in the game's Unity data folder, which is `~/.config/unity3d/Free Lives/Broforce/` on Linux, `%USERPROFILE%\AppData\LocalLow\Free Lives\Broforce\` on Windows, the same folder inside the game's Proton prefix in whichever Steam library holds it, Flatpak Steam's folders, and `~/Library/Application Support/Free Lives/Broforce/` on macOS. Set `UNITY_INSPECTOR_TOKEN_FILE` if yours is elsewhere.

If the game process is there but doesn't answer, `launch_game` reports that instead of starting a second copy. That's almost always the mod failing to load, and the log will have the reason.

Each command's time budget sits above the longest the mod takes to answer it; a timeout usually means the game is busy with a long level load or a script overloading the main thread, and if the game dies partway through a command the server reports a likely crash.

`read_log` reads Unity's player log (`Player.log` or `output_log.txt`, depending on the Unity version), which gets every Unity Mod Manager and mod line the moment it is logged, plus Unity's own errors. It looks under `~/.config/unity3d/Free Lives/Broforce/` on Linux, `%USERPROFILE%\AppData\LocalLow\Free Lives\Broforce\` on Windows, the same folder inside the Proton prefix, Flatpak Steam's folders, `~/Library/Logs/` on macOS, and `Broforce_Data/output_log.txt` next to the game. When no player log has been written since the game started, it falls back to the Unity Mod Manager log: the profile's `UMM/Core/Log.txt` under `~/.config/r2modmanPlus-local/Broforce/profiles/` on Linux or `%APPDATA%\r2modmanPlus-local\Broforce\profiles\` on Windows, and for a direct install in a Steam library on Linux, `Broforce_Data/Managed/UnityModManager/Log.txt` in the game folder. `UNITY_INSPECTOR_LOG` overrides the search entirely, and if no log turns up the error lists every path that was tried.

It reports which file it read and when it was last written, and if the game is running and that file is older than the game process, it says so instead of quietly handing back a log nothing is writing to. `onlyNew` starts a new baseline when the game is relaunched onto the same file.

If the MCP server itself crashes, the wrapper restarts `index.js` and any in-flight requests get an error back, though it gives up after three crashes inside 30 seconds. `mcp-wrapper-<pid>.log` in `~/.local/state/unity-inspector-mcp/` (`$XDG_STATE_HOME` when set; the system temp directory on Windows) has the wrapper's log plus everything the server wrote to stderr, readable by you alone and cleared a week after its last write, and `restart_server` starts it back up once you've fixed the problem.

## Development

After editing `index.js` or anything in `lib/`, the `restart_server` tool restarts the server in place and replays the MCP initialize handshake, so the client keeps its session. Editing `wrapper.js` itself needs a reconnect on the client side (`/mcp` in Claude Code).

Adding a tool takes two edits. In `index.js` it needs a definition in `toolDefinitions()`, which must declare each argument its case reads, with its type, and a case in the switch, where game tools call `unityClient.sendCommand("method_name", params)`. Then it needs a matching handler in `Unity Inspector Mod/MessageHandler.cs` over in the BroforceMods repo. If it takes longer than the 6 second budget, add a timeout for it in `commandTimeout()` in `lib/unity-client.js`.

The tests are `npm test` with Node's built in runner and no test dependencies, and none of them need the game running. Watch out for stdout, since it carries the MCP protocol and one stray `console.log` corrupts it.
