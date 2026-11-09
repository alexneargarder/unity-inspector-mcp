---
paths:
  - "index.js"
  - "lib/unity-client.js"
  - "lib/remote-files.js"
  - "lib/game-process.js"
  - "lib/animation-capture.js"
  - "lib/script-library.js"
  - "test/remote*.test.js"
---

# Remote game target

A game on another machine, reached through an ssh tunnel on loopback or at a LAN address. User-facing setup is `docs/remote-game.md`.

## Declaration

- `launch_game { remote: { host, port, tokenFile } }` sets the target to `remote` (`declaredRemote` in `index.js`, a config carrying `declared: true` and `remote`) and launches nothing. `launchGame()` hands any `remote` argument to `declareRemote()` before anything else.
- **Validation** (`parseRemote()`), before anything is touched, every refusal ending `Nothing was changed.`: an object; no key but `host`, `port`, `tokenFile`, checked here since `schemaProblem()` skips nested keys; a nested `null` is missing. `host` is non-empty with no whitespace, `/` or bracket, and a `:` only as an IPv6 literal, whose brackets are stripped; `port` an integer from 1 to 65535; `tokenFile` an absolute local path, which need not exist yet. `steam`, `vanilla` or `restart` true, or a non-empty `launchArgs`, is refused beside it.
- **Order**: validation, `resolveTarget()`, `refuseWhileInFlight('launch')`, then `refuseWhileBound()` unconditionally (a remote-to-remote re-declaration keeps the target kind), naming the remote being declared; then `launch_game` counts itself in `boundCalls`, sets `declaredRemote`, drops the socket (every declaration does), `setTarget('remote')`, and makes one `pollUntilResponsive(0, …)` attempt. A sweep refuses it in `callTool()` as it refuses any launch. A refused declaration leaves the target and `declaredRemote` as they were.
- **The reply**: the poll's `success`, `state` and `message` (`This server now points at … which answered` or `which did not answer … : <poll message>`, with `lastError`), `target: "remote"`, `remote`, and a `targetNote` when the target changed. The target stays declared when nothing answers.
- **Switching back**: `launch_game {}` and `{ steam: true }` switch as for any target; `switchedAwayNote()` says the remote game was left as it was, never asking whether it runs.
- `targetOf()` is `remote` only for a declared config, and `launchedWithoutMods()` answers false for any `remote` config without reading `vanillaGames`. `targetPort()` is the declared `port`. `resetTargetResolution()` clears `declaredRemote`.

## The env path

- `userGame()` gives the `steam` config `remote: { host, port: null, tokenFile: null, fromEnv: true }` when `UNITY_INSPECTOR_HOST` is set, not loopback (`isLoopbackHost()`) and not under WSL; a loopback host is this machine, and WSL keeps its own host handling (`game-process.md`). The target still reports `steam`, on `defaultPort()`.
- Its token is `UNITY_INSPECTOR_TOKEN_FILE` alone; `UNITY_INSPECTOR_LOG`, when set, stays authoritative and is read as a local file with no mirror.
- `launch_game` onto it (`{ steam: true }`, or `{}` with no instance) switches and pings through `pingRemote()` and never launches; `vanilla`, `restart` and `launchArgs` are refused naming `userGameOutOfReach()`'s reason.

## Reach

- `userGameOutOfReach()` returns the remote reason for any config carrying `remote`, before it looks at the host or the platform. `isGameRunning`, `gameStartTime`, `activeUmmLog` and `runningGameDir` answer null from it and `gameDataLocations()` nothing; `ownedGameProcesses()` throws it before its scan; `ownsProcess()` throws on a `remote` config.
- The default proc reader is built only after the reach check (`reader = null` defaults): the tests' `recordingProcReader()` asserts no call on any tool on a remote target.
- The client skips its crash poll in `sendCommand`, `#connectFailure` rewords nothing, and `#lostConnectionMessage()` reads no process. `pollUntilResponsive()`'s `isGameRunning` is null there, so `wait_for_game` and the declaration end `unknown` (`Could not reach <target> …`), never `no-process` or `connection-refused`. `run_test_script`'s default `isRunning`, `capture_animations`' `gameWatch` and `targetBuild()`'s `gameBuild()` likewise read nothing: `build` carries the running version with a null `store`, `storeBuild` and `gameDir`.
- `stop_game` returns `success: false` naming the reason before `steamKillRefusal()` and `killGame()`; nothing on either machine is touched.
- The session's instance fields and its `owner.pid` claim still describe this machine, and the reaper stops the instance at session end as without a remote.

## Token and client

- `targetTokenSearch()` gives a remote target `remoteTokenSearch(<file>)` (the declared `tokenFile`, or `UNITY_INSPECTOR_TOKEN_FILE` on the env path): that one file, `override: true`, `remote: true`, reread on every connect, so a recopied file works on the next command.
- `#hostCandidates()` returns the remote host alone; neither `UNITY_INSPECTOR_HOST` nor the WSL gateway applies. `pointAt()` keys the socket by host and port, so re-declaring the same port on another host gets a fresh socket.
- Handshake refusals on a remote search add `REMOTE_COPY_HINT` (copy the game's current `unity-inspector-<port>.token` again; the next command rereads it): a malformed file, a refused token, a missing file (`No token file at …`), and on the env path an unset `UNITY_INSPECTOR_TOKEN_FILE`.
- **Failure replies** (`#remoteFailure()`, `#lostConnectionMessage()`, `reachHint()`), each worded by whether the host is loopback:
  - connect failure on loopback: nothing listening, so the ssh tunnel is not running, with `ssh -N -L <local port>:127.0.0.1:<mod port> <host>`; on a direct host: the error code, the mod's "Allow remote connections" setting and the firewall
  - a close during the hello: on loopback nothing is behind the tunnel (the game not running there, its mod's server stopped, or the tunnel forwarding to another port); direct, the mod's server stopped or restarting or another program on the port
  - a close under a command: the command may have run, naming the tunnel only on loopback
- `REMOTE_GONE_MESSAGE` in `lib/unity-client.js` matches those messages, and `run_test_script` reads a match as the game gone: rewording one means updating it.

## Transfers (`lib/remote-files.js`)

- The code's constraints, the reply shape and the per-call bounds are in `lib/AGENTS.md`. Each transfer needs the game's main thread, since no mod command is involved.
- `pullFiles()` stats the set first and names a file missing, or changed while it was read, in `failed`; every local file a pull writes is written as `.part` and renamed once whole. A write's reply is the file's length, checked after each chunk.

## Local copies

- Root: `UNITY_INSPECTOR_REMOTE_DIR`, else `serverStateDir()/remote`; then the session's folder (`sessionFolder()`: `CLAUDE_SESSION_ID`, else `pid-<parent pid>`). Each use touches the session folder's mtime, and at most once an hour other session folders idle for 7 days are removed.
- **Screenshots**: on a remote config `translateScreenshotPath()` calls `pullScreenshot()`, the one point the tool, a test-script step and plain and backdrop shots all go through, and never maps the path through this machine's Proton prefix or drives. The file lands in `screenshots/` under its game-side name, the newest 50 kept; `screenshotReply()` adds the game's path as `gamePath` beside the local `path`. A failed pull is a tool error naming the game's path.

## Logs

- Each endpoint (`host:port`, IPv6 bracketed; the env path's port is `defaultPort()`) has a mirror of the player log and UMM's log, `logs/<endpoint>/Player.log` and `Log.txt` (`logMirrorPaths()`). `ummLogSearch()` returns those paths, the active-log lookup is skipped, and with no start time staleness is off.
- **Game side** (`logSyncCode()`): the player log is the newest by mtime of `persistentDataPath/Player.log`, `persistentDataPath/output_log.txt`, `dataPath/output_log.txt` and on macOS `$HOME/Library/Logs/Unity/Player.log`; UMM's is `UnityModManager.Logger.filepath`.
- **A sync** sends, per log, the mirror's game-file offset (in-memory `base` plus the mirror's length), its last 256 bytes and the game path it came from. When those bytes still sit just before that offset in the same file and no more than `LOG_READ_MAX_BYTES` (4 MiB) was appended, the mirror is appended to; otherwise it is truncated to 0 in place (same inode) and refilled with the newest window, cut forward to a line start, `base` set to the window's start. A first sync, a server restart, a rotated or shrunk file and a gap past the window all refill, and `onlyNew` then rebaselines through its own guard. A log missing on the game deletes its mirror. The mirror's mtime is set to the game file's.
- The first call's budget is 2 MiB across both logs; later chunks go at offsets fixed at the first call, each carrying the first call's size and last 256 bytes, and a chunk finding the file shorter or those bytes changed aborts the sync with an error, the mirror untouched; the next sync refills.
- `withLogMirrors(client, endpoint, use)` queues per endpoint and runs `use` inside the queue after the sync, so `read_log`, `onlyNew`, `run_test_script`'s refreshes and the sweep's log mark and tail never interleave. `targetLogPaths()` returns the mirror paths without syncing, so `game_state` sends nothing.
- `read_log` syncs before every read, and a failed sync is its error. `UNITY_INSPECTOR_LOG` is ignored on a declared remote (`logOverride()`).
- **`onlyNew` per target**: `newLinesStates` is keyed `instance`, `steam` or `remote <endpoint>`, so alternating targets keeps each position.

## run_test_script

- `refreshLogs` (passed when the target has a mirror) syncs before the snapshot, after the run, and again after the UMM flush wait; a failed refresh makes `logs` `{error: "log refresh failed: …"}`.
- Game-gone on a remote target rests on step failures matching `REMOTE_GONE_MESSAGE`, never the process table; a gone remote game's `logs` is an error saying its log was not fetched, since no sync can reach it.

## capture_animations

- A `gameOut` on a remote config (declared or env) is refused before anything is sent. `sweepRefusal()` there does not offer `stop_game`.
- **Prep**: before the claim, one listing of `temporaryCachePath/capture-animations` (`REMOTE_CAPTURE_DIR`); `gameOut` is `<that root>/<claim token>`. The claim's lease adds `remoteSetupMs()`: one `execute_code` budget per leftover removal, per states write and per log-sync call. Only once the claim holds are up to 8 (`LEFTOVER_REMOVALS_PER_RUN`) leftover folders removed, since a held claim means no live run owns one, and `states.json` written in chunks.
- **The sweep** passes the script `hold` (seconds of `fetchLeaseMs()`), which keeps the slot claimed after `Finish()` (`lib/animation-capture/AGENTS.md`). The sentinel and `capture.json`'s progress are polled through `readSentinel()` every `REMOTE_POLL_MS` (2s), a failed probe counting as no news. `markCaptureLog()` and `captureLogTail()` take `withLog`, syncing the mirror first. With no process to watch, a dead remote game ends as `timeout`.
- **The `finally`**: once the script started and unless the server is stopping (`sweep.stopping`), `sweep.claim` is set back and one `leaseCode()` replaces the sweep entry (or a free slot) with this run's lease before the teardown's unload, so the slot never reads free; after the teardown `fetchSweep()`, bounded by `FETCH_BUDGET_MS` (60s), lists `gameOut`, pulls `capture.json` and every `.png` into `out`, removes the folder, and releases the claim in its own `finally`. It runs on done, error, timeout and cancel; a cancel still writes no `report.md`. What did not arrive goes to `report.md` as a summary count and a `Not fetched` section; a folder that could not be listed is one entry saying nothing was fetched, and with `capture.json` unfetched the report lists no state as never reached. A shutdown fetches nothing.
- `callTool()`'s sweep deadline on remote is `claimLeaseMs(options, {})` (the setup calls with no removals) plus `timeout` plus `fetchLeaseMs()`.

## Restart

- `restart_server` and a crash respawn start a new process, which has no declaration. `staleCodeNotice()` on a remote target says a restart forgets it. The wrapper's `FORGOTTEN_TARGET` sentence is in every `restart_server` note and appended as an extra `content` item to the first `tools/call` reply after a crash respawn (`wrapper.md`).
