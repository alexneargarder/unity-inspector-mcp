# unity-inspector-mcp

> The Unity Inspector Mod isn't released yet. Until it is, its source is in the [Unity Inspector Mod folder](https://github.com/alexneargarder/BroforceMods/tree/master/Unity%20Inspector%20Mod) of BroforceMods.

This lets an MCP client inspect and change things in Broforce while the game is running. It's mainly for modding and debugging. It works with the Unity Inspector Mod, a C# mod loaded by Unity Mod Manager, and the two talk over TCP on localhost, port 9999 by default. The server runs on Linux, Windows and macOS.

## Requirements

- Node.js 18 or newer. I've tested on 22, and the MCP SDK is the only npm dependency.
- Broforce with Unity Mod Manager, RocketLib and the Unity Inspector Mod.
- An MCP client, such as Claude Code, Claude Desktop, Codex CLI, Cursor, VS Code or Windsurf.

## Installing the mod

Install the mod first. It's on Thunderstore as [`AlexN-Unity_Inspector_Mod`](https://thunderstore.io/c/broforce/p/AlexN/Unity_Inspector_Mod/), and installing it with r2modman pulls in RocketLib too. You can also install it by hand by putting its folder in Unity Mod Manager's `Mods` folder. Here's a [guide for installing Unity Mod Manager and mods](https://steamcommunity.com/sharedfiles/filedetails/?id=2434812447) if you haven't done that before.

Update the mod and the server together, since a mismatched pair refuses to connect and the error says which one to update.

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
        "UNITY_INSPECTOR_PORT": "9999"
      }
    }
  }
}
```

The `env` block is optional. Claude Desktop, Cursor, Windsurf and Cline take this as is in their MCP config file. VS Code's `.vscode/mcp.json` calls the top level key `servers` instead, and each server there needs `"type": "stdio"`. Claude Code takes a command, with any settings as `--env KEY=value` before the `--`, and Codex CLI the same with `codex mcp add`:

```bash
claude mcp add unity-inspector -- node /absolute/path/to/unity-inspector-mcp/wrapper.js
```

### WSL

If the game is on Windows and your MCP client is in WSL, run the server in WSL:

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

Under WSL2's default NAT networking, turn on the mod's "Allow remote connections (LAN)" setting and allow Broforce through the Windows firewall. That opens the mod's port to your network while it's on. `launch_game` and `stop_game` can't manage a game on Windows from WSL, so start and stop it there yourself.

## Environment variables

All of these are optional and go in the `env` block. `~/.local/state` below means `$XDG_STATE_HOME` when that is set.

| Variable | Default | Effect |
|---|---|---|
| `UNITY_INSPECTOR_PORT` | `9999` | TCP port the mod listens on. |
| `BROFORCE_LAUNCH_CMD` | [the Steam launch](#launching-your-game-through-steam) | Command line `launch_game` runs to start your own game ([docs/launcher-contract.md](docs/launcher-contract.md#your-own-games-launch-command)). |
| `BROFORCE_PROFILE` | `Default` | The r2modman profile the Steam launch loads mods from: a name, or the profile folder's absolute path. |
| `BROFORCE_LAUNCH_TYPE` | `auto` | `native` or `proton`: how the Steam launch runs the game on Linux. |
| `BROFORCE_STOP_CMD` | unset | Command line `stop_game` runs to stop your own game. Unset, the server signals the game's process. |
| `BROFORCE_INSTANCE_CMD` | unset | The launcher for [separate game instances](#separate-game-instances). |
| `UNITY_INSPECTOR_HOST` | `127.0.0.1` | Host your own game runs on ([docs/remote-game.md](docs/remote-game.md#environment-variables)). |
| `UNITY_INSPECTOR_TOKEN_FILE` | searched for | Path to the token file the mod writes. |
| `UNITY_INSPECTOR_LOG` | searched for | Path to the log `read_log` reads. |
| `UNITY_INSPECTOR_TEST_RESULTS_DIR` | `~/.local/state/unity-inspector-mcp/test-results` | Folder `run_test_script` writes full results under. |
| `UNITY_INSPECTOR_REMOTE_DIR` | `~/.local/state/unity-inspector-mcp/remote` | Folder files fetched from a game on another machine go under. |
| `UNITY_INSPECTOR_LAUNCHES_DIR` | `~/.local/state/unity-inspector-mcp/launches` | Folder each session's record of its last launch goes in. |

## Launching your game through Steam

When `BROFORCE_LAUNCH_CMD` isn't set, `launch_game` starts your own game with mods through Steam, from the r2modman profile `BROFORCE_PROFILE` names. On Linux, Broforce's Launch Options in Steam need the line r2modman's Linux setup screen gives you, except under Proton with the regular r2modman, which needs none. The details for each platform are in [docs/steam-launch.md](docs/steam-launch.md).

## Separate game instances

On Linux, each Claude Code session can get its own game instance: a second copy of the game with its own profile, saves, logs, port and virtual display, so an agent can play its own game while you play yours. `BROFORCE_INSTANCE_CMD` turns this on by naming the launcher that creates and runs instances. `launch_game` then starts the session's instance, and `launch_game { steam: true }` points the server at your own game instead. [docs/launcher-contract.md](docs/launcher-contract.md) is what a launcher has to implement.

## Remote game

`launch_game` can also point the server at a game on another machine, through an ssh tunnel or over the LAN: see [docs/remote-game.md](docs/remote-game.md).

## Tools

There are 33, 32 from the server and `restart_server` from the wrapper.

| Tool | Description |
|---|---|
| `ping` | Test the connection to the mod, and whether the game's main thread answers. |
| `game_state` | The loaded level, game mode, players and bro type, and which game the server is pointed at. |
| `list_gameobjects` | List the root GameObjects of the loaded scenes. |
| `query_gameobjects` | Search GameObjects by name pattern and/or component type. |
| `inspect_gameobject` | Inspect one GameObject by path or `instanceId`. |
| `inspect_component` | Inspect a component's fields and properties, or read one member of it. |
| `modify_component` | Write fields and properties on a component and read each back. |
| `take_screenshot` | Capture the game window, optionally outlining a target or drawing only the characters on a flat colour. |
| `inspect_player` | Each player's bro, position and state. |
| `teleport_player` | Move a player (or all players) to a coordinate. |
| `set_player_health` | Set a player's health. |
| `list_bros` | List the bros players can swap to. Requires Swap Bros Mod. |
| `swap_bro` | Swap a player's bro mid-level, or choose the bro they spawn as next. Requires Swap Bros Mod. |
| `list_enemies` | List the enemies in the loaded level. |
| `spawn_entity` | Spawn a unit, villager or animal at a coordinate. |
| `trace_spawns` | Record the game's spawn calls and read them back. |
| `set_game_speed` | Set the time scale (1.0 is normal). |
| `simulate_input` | Press or hold game actions or a mod's key binding, alone or in sequences. |
| `list_campaigns` | List campaigns with their indices. |
| `go_to_level` | Go directly to a campaign level. |
| `restart_level` | Restart the current level. |
| `execute_code` | Run C# statements in the game and return the result. |
| `execute_script` | Compile and run a C# script file in the game. |
| `list_scripts` | List the C# script library. |
| `unload_script` | Unload a running script, removing its patches and objects. |
| `list_test_scripts` | List the JSON test scripts. |
| `run_test_script` | Run a JSON test script and report each step. |
| `capture_animations` | Capture a bro's animation states as PNG strips and check them against a state list. |
| `read_log` | Read the game's log, or only the lines written since the last read. |
| `launch_game` | Launch Broforce and wait until it answers, or point the server at a running or remote game. |
| `stop_game` | Stop the game this server is pointed at. |
| `wait_for_game` | Wait until the game answers. |
| `restart_server` | Restart `index.js` in place to pick up code changes. Provided by `wrapper.js`. |

## Scripts

- C# scripts: `scripts/csharp/` is a library of scripts that `execute_script` runs in the game, and `list_scripts` lists. Writing one: [scripts/csharp/README.md](scripts/csharp/README.md).
- Test scripts: `scripts/tests/` holds JSON sequences of tool calls that `run_test_script` runs, for reproducing a scenario the same way every time. The format: [scripts/README.md](scripts/README.md).

## Troubleshooting

"Game is not running. Use launch_game to start it." means the server couldn't open the TCP connection. Most likely causes, in order:

1. The game isn't running, or the mod didn't load. Check that the Unity Mod Manager overlay (Ctrl+F10) lists the mod and that it's enabled.
2. The mod's TCP server is stopped. The mod's panel in the overlay shows its status and has a Start Server button.
3. The mod is on a port other than 9999. Set `UNITY_INSPECTOR_PORT` to match.
4. On WSL2, "Allow remote connections (LAN)" is off or the Windows firewall blocks Broforce.

If the mod refuses the connection, the error says why. If the mod's token file or the game's log is somewhere the server doesn't look, set `UNITY_INSPECTOR_TOKEN_FILE` or `UNITY_INSPECTOR_LOG`; the error lists the paths it tried.

If the game process is there but doesn't answer, the mod most likely failed to load, and `read_log` will have the reason.

If the server crashes three times inside 30 seconds, the wrapper stops restarting it until you call `restart_server`. The wrapper's log, with everything the server wrote to stderr, is `mcp-wrapper-<pid>.log` in `~/.local/state/unity-inspector-mcp/` (the system temp folder on Windows).

## Development

The tests are `npm test`, with Node's built in runner and no test dependencies, and none of them need the game. [AGENTS.md](AGENTS.md) covers the architecture, adding a tool and the repo's conventions.
