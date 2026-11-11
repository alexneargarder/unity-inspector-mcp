# lib

## The TCP client

- Protocol: `{"id":"...","method":"...","params":{...}}\n` → `{"id":"...","success":true,"result":{...}}\n`. Every connection opens with the hello, `{"id":"...","method":"hello","params":{"token":...,"protocol":1}}`; `connect()` resolves only once the mod accepts it (Handshake in `.claude/rules/connection.md`).
- The mod answers one line at a time per connection, so `sendCommand` queues: a command is written only once the previous one settled, and its timeout starts at its own write. A command that times out, or is cancelled while the mod still runs it, drops the socket, so the next command gets a fresh connection and mod receive thread. Replies route by `id`; one arriving after its command timed out is dropped.

## The animation-capture sweep driver

`animation-capture.js` is the host side of `capture_animations`.

- The script goes to the game as `SCRIPT_NAME`, unique per server process, since the mod restarts or replaces a loaded script of the same name.
- **The claim between servers.** Right after its `ping`, a run claims the game with one `execute_code` (`claimCode()`), a single main-thread action so two servers' claims cannot interleave. It sets the `AppDomain` slot `UnityInspector.AnimationCapture.Live` to its token, `gameOut` and a lease (`claimLeaseMs()`) covering every wait setup can spend, unless the slot holds a live sweep or another run's unexpired claim. The slot is in the `AppDomain` because every compile is its own assembly with its own statics. The script's `Main()` replaces the claim with the sweep; a failed setup releases it (`releaseClaim()`) only while the slot still holds its token. `liveRule()` and the script's `LiveSweep()` are one rule: change both together.
- **Cutscenes.** A bro's intro, played when a load spawns a bro in `yetToBePlayedUnlockedHeroes`, holds until a key. Where bros arrive by transport, `go_to_level` answers at once with `cutscene: "CutscenePause"`, pressed past before the level wait; where the bro spawns straight in, it starts after the reply. One `game_state` after the settle (before the swap with no `level`) looks for one, since a bro swapped in under a cutscene is lost and respawned, and is also the swap's snapshot. While it reads `CutscenePause` the tool presses `start` for `player`, again whenever the pause outlasts a press by `CUTSCENE_REPRESS_MS`, since the game ignores a skip in a cutscene's first second; after a press it waits `settle` again (3s without a `level`) and looks once more. With no `level`, the readiness wait also presses a cutscene, one that started after the swap included, then waits 3s. Only `CutscenePause` is pressed; any other pause is the caller's.
- **The swap.** Only a `swap_bro` refusal with `reason: "unreachable"` is retried with `ignoreUnlocks`. The slot is then polled until it holds a live character, one other than the snapshot's when the reply named none; a reply naming the snapshot's own character is `swap.alreadyHeld`, the slot already holding that bro, which the swap respawned all the same, and is not polled. Every landed swap is confirmed with `list_bros {playerNum}`, whose `currentBro` is compared to `bro` without regard to case, and the readiness wait follows at once: the new character is in the slot when `swap_bro` replies, and the script removes the recalled one.

## The backdrop render

- **The source** is a class body, read at call time. `backdropClassSource()` wraps it in a top-level `PlainBackdrop` for `execute_code`, declared again on every shot, which replaces the earlier one; `includeBackdrop()` nests the same class into the capture script at its `// #include PlainBackdrop` line, the last in the script's class so the script's own line numbers hold, whether or not `backdrop` was asked for. It must declare no enum and no generic type: `execute_code` rebuilds its Evaluator after a generic declaration, and the class is declared on every shot.
- **The render** (`Render()`) composites the capture script's screen cameras, less any that draw nothing or a UI layer, through one temporary camera that copies each in turn and clears only depth, so no game camera is touched and none of their image effects run.
- **The hide rule** (`HiddenRenderers()`): walking up from each enabled renderer, the first object whose markers decide settles it. A placed throwable decides only under the map root, where it is hidden; otherwise keep markers decide before hide markers on the same object, and with no deciding object the renderer is kept. Types match by name along each component's type chain, so a type a game build lacks is skipped.
- **Restore**: exactly the renderers the render disabled are enabled again in a `finally`, before the readback and in the same main-thread action, so no frame runs while anything is hidden.

## Remote file transfers

`remote-files.js` moves files to and from a game on another machine (`.claude/rules/remote.md`) through server-sent `execute_code`, a transfer taking as many calls as its bounds need, each under its own command timeout.

- The code writes `System.IO` names in full, quotes every path through `csString()`, declares no generic type or enum, and opens the game files it reads with `FileShare.ReadWrite` (`openShared()`).
- A read's result is one string, a JSON object of index → base64 (null for a file it could not read), never an array, since a result array is cut at 100 items. A call carries at most `TRANSFER_MAX_BYTES` (2 MiB) of file bytes, a larger file going in 2 MiB segments, and a write at most `WRITE_CHUNK_BYTES` (96 KiB).
- The code's first line is `CODE_MARK`, the operation and its JSON parameters. The stub mod in `test/support/remote-fs.js` rebuilds the code from those parameters (a write's data read back from the body) with the same builder, refuses code that differs, then answers from its own model: the check catches a parameter missing from the header and code no builder made, not a change to what the C# does, so changing a builder's behaviour needs the same change in the stub's answers.

## Shared helpers

- `tokenizeCommand()` is the one splitter for every setting holding a command plus arguments.
- The log readers share `linesBackward()` (bounded backward read), `sameLogRun()` (the relaunch check), `readDelta()` (what a log gained, capped by `LOG_READ_MAX_BYTES`) and `markLogEnd()`.
