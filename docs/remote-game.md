# Remote game

The server normally talks to a game on this machine, but you can also point it at a game on another machine, through an ssh tunnel or straight over the LAN. It's the same server, so you don't need a second MCP config entry. You declare the remote game at run time with `launch_game` and switch back later. The other machine needs the Unity Inspector Mod installed and running, as usual.

## Tunnel

On this machine run:

```bash
ssh -N -L <local port>:127.0.0.1:<mod port> <host> -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes
```

`<mod port>` is the port the mod listens on over there, 9999 unless you changed it in its settings. `<local port>` is a free port here. Don't use the port your own local game uses.

With the keepalive options ssh exits when the connection dies (about 15 seconds of no answer), so you don't end up with a dead tunnel. `ExitOnForwardFailure=yes` makes it exit right away if the local port is taken, so it never keeps running with no forward.

Leave the mod's "Allow remote connections (LAN)" setting off for the tunnel, since the tunnel reaches the mod on the other machine's 127.0.0.1.

## LAN

Turn on "Allow remote connections (LAN)" in the mod's settings on the game's machine, and allow Broforce's port through that machine's firewall. That setting binds the mod to 0.0.0.0, so its port is open to the whole network while it's on. When you declare the game, use the machine's LAN address as the host and the mod's port as the port.

## Token file

The mod writes a new token every time its server starts, which is every game start, to `unity-inspector-<mod port>.token` in the game's Unity data folder on its machine. The name uses the mod's port, never your local tunnel port. The folder is:

- Linux `~/.config/unity3d/Free Lives/Broforce/`
- Windows `%USERPROFILE%\AppData\LocalLow\Free Lives\Broforce\`
- Proton, the same Windows folder inside the game's Proton prefix
- macOS `~/Library/Application Support/Free Lives/Broforce/`

Copy it to this machine after each start of the remote game. For a Linux game machine with the mod on 9999 you can do this:

```bash
ssh <host> cat "'.config/unity3d/Free Lives/Broforce/unity-inspector-9999.token'" > /path/to/token
```

The server reads the copy again on every connect, so after you recopy it the next command works without declaring the game again. If the copy is stale the call fails, and the error names the token file and says to copy it again.

## Declaring the game

For a tunnel:

```
launch_game { remote: { host: "127.0.0.1", port: <local port>, tokenFile: "/path/to/token" } }
```

`host` is a host name or address only, with no scheme, port or path. `127.0.0.1` or `localhost` means the tunnel. `port` is an integer from 1 to 65535. `tokenFile` is an absolute path on this machine, and the file doesn't have to exist yet.

This doesn't launch anything on either machine. It pings once and the reply says whether the game answered. The target stays declared even when nothing answered, and the reply says why, for example the tunnel isn't running or a firewall is in the way. After that `game_state` shows `target: "remote"` and a `remote` field with the host, port and `tokenFile`.

Every game tool then goes to the remote game. Your own game and this session's own instance are left as they were.

## Switching back

`launch_game {}` goes back to the session's default game, which is its own instance where instances are set up, or your own game otherwise. `launch_game { steam: true }` goes to your own game. Both replies say the remote game was left as it was. You can declare it again anytime with another `launch_game { remote: ... }`.

## Refused on a remote game

- `stop_game` is refused and nothing is stopped on either machine. Stop the game on its own machine.
- `remote` together with `steam`, `vanilla`, `restart` or `launchArgs` is refused and nothing changes.
- `capture_animations` with `gameOut` is refused, since the server picks the game-side folder itself.

## Fetched files

Screenshots, logs and capture output come back over the mod's own connection, so there's no extra share or copy step. Fetching runs code on the game's main thread though, so a remote game whose main thread hangs can't send its log. In that case read it on its own machine.

Local copies go under `$XDG_STATE_HOME/unity-inspector-mcp/remote/` (or `~/.local/state/unity-inspector-mcp/remote/` with `XDG_STATE_HOME` unset), one folder per session. You can set `UNITY_INSPECTOR_REMOTE_DIR` to use a different root. A session folder that hasn't been used for 7 days is deleted.

- `take_screenshot` fetches the file into the session's `screenshots/` folder and keeps the newest 50. The reply's `path` is the local copy and `gamePath` is the file on the game's machine.
- `read_log` reads a local copy of the game's Unity player log and Unity Mod Manager log under the session's `logs/<host>_<port>/`. Every read updates it with only the new part, and the first read takes at most the newest 4 MB.
- `capture_animations` has the game write its strips into a folder in its own temporary cache. The server fetches the strips and `capture.json` into `out`, then deletes that folder on the game's machine. Any files it couldn't fetch are listed in `report.md`.

## Restarts

`restart_server` and the automatic restart after a server crash both forget the remote game and go back to the session's default target, and their reply says so. You'll have to declare it again.

## Environment variables

For a game that's always on another machine, you can set `UNITY_INSPECTOR_HOST` to its address and `UNITY_INSPECTOR_TOKEN_FILE` to the token copy. Then "your own game" is that remote game. `launch_game { steam: true }` only points at it and pings it, it never launches anything. Its `restart` and `vanilla` are refused there, and so is `stop_game`. `UNITY_INSPECTOR_HOST` set to `127.0.0.1` or `localhost` means this machine, so use the `remote` declaration for a tunnel.
