---
paths:
  - "test/**"
---

# Input-class matrix: server tests of the game tools

## Every tool

| | class | covered by |
|---|---|---|
| N | no `arguments` member | TH `a call with no arguments member is the same call as one with {}`, `tool calls with no "arguments" member do not throw` |
| N | an unknown tool | TH `an unknown tool reports an error rather than throwing` |
| N | an argument the schema does not declare | TH `every tool refuses an argument its schema does not declare, naming it and the valid ones`, `the misnamed keys real calls sent are refused, never run without them`; TL `the argument check reads the same schemas the tool list carries` |
| N | a value of the wrong type, nested ones and several at once; an argument outside an `enum` | TH `every tool refuses an argument of the wrong type, naming it, the type and what was sent`, `a value inside an argument is checked against the schema it carries` |
| N | a string or a number for a boolean flag | TH `a string for a flag is refused, never read as true` |
| N | a non-integer where an integer is meant; a whole number written as a float; a non-finite number | TH `a non-integer where an integer is meant, and a number past the finite range, are refused` |
| N | a null argument, optional and required | TH `a null argument is an absent one` |
| N | a main-thread stall on a tool other than `game_state` | TH `a main-thread stall comes back as an error with its body, on every tool but game_state` |
| N | a reply whose `success` is false | TH `a reply whose success is false comes back as an error, its body unchanged`; every failure body IL, IT and CA read goes through a helper asserting `isError` alongside it |
| N | a target with no port | IT `list_campaigns with no game gives the same no-port reason as every tool`, `an instance with no allocated port has no port to connect to` |
| N | nothing listening: no game, the game running, detection unable to tell (WSL) | UC `a command with nothing listening says the game is not running`, `a refused connection to a running game blames the listener, not the game`, `on WSL a refused connection says it cannot tell, names the hosts tried and the setting` |
| N | the game dies under a command | UC `a game that dies under a command is reported as a crash` |
| N | the socket resets or closes under a command, the game gone or still running; a zombie game | UC `a socket reset under a command reads as a closed connection`, `a closed connection rejects in-flight commands`, `a connection the inspector closes while the game keeps running is not called a crash`; GP `a game process that has exited but is not yet reaped is not running` |
| N | a disconnect under a command | UC `a disconnect under a command gives the command the reason it was dropped` |
| N | a reply after its command timed out; the next command | UC `a response that arrives after its command timed out does not resolve the next command`, `all.after-timeout: the next command goes out on a fresh connection and gets its own answer` |
| N | a command sent while another runs; a call cancelled with its command running or queued | UC `a command is written only once the one before it settles, and its budget starts at its write`, `cancelling a call drops its running command and lets the next one through on a fresh connection`, `cancelling a call takes its queued command out unwritten and leaves the running one alone` |
| N | a started main-thread action that answers late | UC `all.started-action-timeout: a started main-thread action's answer reaches the caller` |
| N | a null-id error reply, alone or with a command queued | CL `a null-id response is delivered when exactly one command is in flight`, `a null-id response goes to the one command written, with another queued behind it` |
| N | a reply split inside a multi-byte character; concurrent commands on a cold client | UC `a reply split inside a multi-byte character reaches the caller whole`, `concurrent sendCommand calls on a cold client all settle` |
| N | an error reply carrying its id, alone or with another command queued | UC `errors are routed to the request that caused them`, `an error reply fails its own command and the next one is written` |
| N | `UNITY_INSPECTOR_HOST`; WSL's loopback then gateway; an invalid port setting; concurrent platform detection | UC `UNITY_INSPECTOR_HOST points the user's game elsewhere, and never the instance`, `on WSL the Windows host behind the default route is tried after loopback`, `the Windows host is the word after via on the default route, and nothing without one`, `an invalid UNITY_INSPECTOR_PORT is logged once, not on every call`, `concurrent platform detections share one, so none sees it half done`; RTS `a take_screenshot step through the real client reports the path this machine reads` |
| N | the tool list's size and listing; no removed tool listed or named | TL `the tool list stays within its size limits`, `every tool has a name, description and input schema`, `the server announces a tool list that changes`, `the merged tools are gone from the list` |
| N | a flag that routes the call to another mod command: stripped, refused alike in steps, the mod command's budget | UC `toolCommand picks the mod command and strips the flag that chose it`, `toolCommand refuses a flag the chosen command would ignore`, `a routed tool call waits on its mod command's budget`; RTS `a step reaches the mod the way the tool does, with the flag stripped and the record as written`; SL `a step gets the same refusals as the tool` |
| N | the session ends with an instance claimed | WIS (all), WS (all) |
| N | the session ends: stdin end, SIGHUP, a dead stdout | SS (all) |
| N | the session's instance not yet placed: refused, then served once the launcher answers | IL `a list the launcher cannot print leaves the session with no target until it can`, `a launcher that answers after startup has its running instance claimed and served` |
| N | a game of the instance that came up after startup; a server whose wrapper died | IL `a game of the instance that comes up after startup is claimed by the next command`, `a server whose wrapper has died claims nothing in its name` |
| N | the startup claim: a directory and no game; no directory until a launch elsewhere creates it | IL `at startup the id is taken whenever the instance directory exists, game or none`, `a startup with no instance directory takes the id once a launch elsewhere creates it` |
| N | a vanilla game: every command says it runs no inspector | LV `a vanilla launch the command carries out reports the game started without mods` |
| N | a `/proc` read that hangs | PP `a /proc read that hangs is given up on and not asked again while it hangs` |

## Connection handshake

| | class | covered by |
|---|---|---|
| N | the hello accepted | HS `a connection opens with a hello carrying the token, and a command follows only once it is accepted`, `no command is sent while the hello is unanswered` |
| N | a mod older than the handshake | HS `a mod older than the handshake is named, and the socket is dropped`, `sendCommand passes a refusal on unchanged`; HT `a command and capture_animations alike fail with the refusal's own message` |
| N | a protocol mismatch, the mod's higher or lower | HS `a protocol mismatch says which side to update` |
| N | the token refused, with a file | HS `a refused token names the file it came from and the mod's own words`, `the token is read again on every connect` |
| N | no token file | HS `with no token file the hello carries none and the refusal names where it looked`, `the user's game names UNITY_INSPECTOR_TOKEN_FILE when that file is missing` |
| N | no reply to the hello | HS `a hello with no reply times out within the connect budget and is not a refusal` |
| N | the socket closed during the hello | HS `a socket closed during the hello is the closed-connection path, not a refusal` |
| N | the token search on the instance | IT `an instance's hello carries the token from its own data folder, never UNITY_INSPECTOR_TOKEN_FILE` |
| N | the token search on the user's game: `XDG_CONFIG_HOME`, `~/.config` | HS `the user's game is searched for in every data folder, XDG_CONFIG_HOME first when absolute`, `the newest token file wins` |
| N | the token search on the user's game: the Proton prefix, WSL | HS `the search reaches the Proton prefix and, on WSL, every Windows user` |
| N | the game in a second Steam library; under Flatpak Steam, its own libraries included; no Steam at all | HS `libraryfolders.vdf names every library, escapes undone`, `the game and its Proton prefix are found in a second Steam library, and the token search reaches that prefix`, `a game under Flatpak Steam is found, its own libraries included, and its data folders are searched`, `no Steam install finds no game` |
| N | `UNITY_INSPECTOR_TOKEN_FILE` set, the file there or missing | HS `UNITY_INSPECTOR_TOKEN_FILE is the file, with no search`, `the user's game names UNITY_INSPECTOR_TOKEN_FILE when that file is missing` |

## execute_code

| | class | covered by |
|---|---|---|
| N | `code` missing or empty | TH `a missing required argument is refused before anything reaches the game` |
| N | the code reaches the game byte for byte | TH `execute_code sends the code byte for byte` |
| N | a reply past the run budget and grace; past a start at the end of its start budget | UC `execute_code.long-running: the mod's own late answer reaches the caller`, `execute_code.long-running, started at the end of its start budget: the mod's own late answer reaches the caller` |

## execute_script

| | class | covered by |
|---|---|---|
| N | `path` missing or not a string; `script` sent instead | TH `a missing required argument is refused before anything reaches the game`, `a script name or path that is not a string is refused in plain words, before anything reaches the game`, `the misnamed keys real calls sent are refused, never run without them` |
| C | a library name, with or without `.cs` | SL `readScriptSource loads a library script by bare name`, `readScriptSource takes a library name with its .cs as well as without` |
| C | a catalog display name | TH `a catalog display name runs the script it names`; SL `a catalog display name resolves to the file carrying it, in any case`, `a display name several scripts carry is refused, naming each of them` |
| N | a relative path out of the library | SL `readScriptSource refuses relative paths that escape the library`, `a display name never lifts the path rules` |
| C | an absolute path; one through a symlinked directory | SL `readScriptSource reads an absolute path as given, named after its file`, `readScriptSource sends one origin and name for a file reached through a symlinked directory` |
| N | no such file or name; no file at an absolute path | SL `a name matching neither a file nor a catalog name says where it looked and what is closest`, `readScriptSource words a missing file by how it took the path`; TH `execute_script names a missing absolute path, and says how it took it, instead of the raw ENOENT text` |
| N | the game gets source, never a path; `args` absent or given; `args` not an object | TH `execute_script sends the source and its name, never the path, with compileOnly too`, `execute_script refuses args that are not an object and sends nothing` |
| N | the file read is sent as the origin | TH `execute_script sends the file it read as the origin, whatever form named it` |
| N | a test step by `path`; with neither or both of `path` and `source` | RTS `a library script step sends the file's source, by bare name, .cs name and catalog display name`; SL `a script step names a library script or inlines source, never both` |
| N | `compileOnly`: reaches the mod as compile_script without the flag; false; with `args` | TH `execute_script with compileOnly reaches the mod as compile_script, without the flag or args`, `execute_script without compileOnly still runs, its args passed through`, `execute_script refuses compileOnly with args and sends nothing` |

## game_state

| | class | covered by |
|---|---|---|
| N | the server's fields over the game's answer | IT `game_state merges the server's fields over the game's own answer` |
| N | no game answering | IT `game_state carries the target, the instance and the logs with no game answering` |
| N | the main thread not answering | TH `ping and game_state pass on whether the main thread answered` |
| N | why there is no instance: no id, malformed id, no launcher, no instance mode, unanswered `--help`, unreadable list, off Linux | IT `no session id means the user's game on the usual port`, `a malformed session id serves the user's game and says why`, `without a configured instance launcher there is no instance`, `a launcher without instance mode serves the user's game, never a refusal`; IL `game_state recovers the root for a session with no instance of its own`, `game_state alone drives the probe retry and the discovery after it`, `off Linux the launcher is asked nothing at all`, `a list the launcher cannot print leaves the session with no target until it can`, `a launcher that cannot be run says why, not only that it did not answer` |
| N | `runningInstances` on either target; `instance.port` with and without a game of ours | IT `game_state merges the server's fields over the game's own answer`, `game_state carries the target, the instance and the logs with no game answering` |
| N | `build` on a hung game, and on one that answers later; a version query that fails | IL `a hung game is asked for no version, and one that answers later gets its version` |
| N | `build`: GOG and Steam depots, Proton, no game, Windows | IL `game_state names the store and build of the game it is pointed at`; PP `the store of a game directory is read from the file each store leaves`, `the running game's directory comes from its executable, or from Proton's Windows path`, `Windows processes are read through CIM, and wmic only when PowerShell cannot answer` |

## go_to_level

| | class | covered by |
|---|---|---|
| N | an index missing; zeros | TH `a missing required argument is refused before anything reaches the game`, `a zero is an answer, not a missing value` |
| N | nothing sent after the load | TH `go_to_level sends nothing of its own after the load` |
| N | the budget: the load request, then the in-play wait | UC `commandTimeout pins each command's budget` |
| N | integer indices; the description of the wait | TL `the state tools declare the arguments the mod reads as integers as integers`, `the level tools say they reply once the level is in play` |

## inspect_component

| | class | covered by |
|---|---|---|
| N | `path` or `componentType` missing | TH `a missing required argument is refused before anything reaches the game` |
| N | `instanceId` in place of `path`, 0 included | TH `an instanceId addresses the object in place of a path, a zero included` |
| N | `component` sent for `componentType` | TH `the misnamed keys real calls sent are refused, never run without them` |
| N | a dotted `memberPath` | TH `a dotted member path reaches the game unchanged` |

## inspect_gameobject

| | class | covered by |
|---|---|---|
| N | `path` missing; `detailed` default | TH `a missing required argument is refused before anything reaches the game`, `the defaults a tool fills in reach the game` |
| N | `instanceId` in place of `path` | TH `an instanceId addresses the object in place of a path, a zero included` |

## list_bros

| | class | covered by |
|---|---|---|
| N | `playerNum` default; an integer | TH `the defaults a tool fills in reach the game`; TL `the state tools declare the arguments the mod reads as integers as integers` |

## list_enemies

| | class | covered by |
|---|---|---|
| N | corpses and `aliveCount` in the description | TL `list_enemies advertises the classification and the suppression answer` |

## list_gameobjects

| | class | covered by |
|---|---|---|
| N | defaults; `false` and `0` kept | TH `the defaults a tool fills in reach the game` |

## modify_component

| | class | covered by |
|---|---|---|
| N | path, component or properties missing | TH `a missing required argument is refused before anything reaches the game` |
| N | `instanceId` in place of `path` | TH `an instanceId addresses the object in place of a path, a zero included` |
| N | the budget for the write and the next frame's read | UC `commandTimeout pins each command's budget` |
| N | dotted names | TH `a dotted member path reaches the game unchanged` |
| N | a write that outlasts its main-thread budget | UC `modify_component.main-thread-busy: the mod's own late answer reaches the caller` |

## ping

| | class | covered by |
|---|---|---|
| C | the game answers | WG `a connected client keeps its socket through wait_for_game` |
| N | the main thread not answering | TH `ping and game_state pass on whether the main thread answered` |

## query_gameobjects

| | class | covered by |
|---|---|---|
| N | defaults; all arguments | TH `the defaults a tool fills in reach the game` |
| N | `name` sent for `namePattern` | TH `the misnamed keys real calls sent are refused, never run without them` |

## restart_level

| | class | covered by |
|---|---|---|
| N | the budget: the restart, then the in-play wait | UC `commandTimeout pins each command's budget`; TL `the level tools say they reply once the level is in play` |

## set_game_speed

| | class | covered by |
|---|---|---|
| N | `speed` missing; 0 | TH `a missing required argument is refused before anything reaches the game`, `a zero is an answer, not a missing value` |
| N | the budget: the write, then the read-back frames | UC `commandTimeout pins each command's budget`; TL `the level tools say they reply once the level is in play` |

## set_player_health

| | class | covered by |
|---|---|---|
| N | `health` missing; 0; `player` sent for `playerNum` | TH `a missing required argument is refused before anything reaches the game`, `a zero is an answer, not a missing value`, `the misnamed keys real calls sent are refused, never run without them` |
| N | integer `health` and `playerNum` | TL `the state tools declare the arguments the mod reads as integers as integers` |

## simulate_input

| | class | covered by |
|---|---|---|
| N | neither form, two of action, binding and sequence, an empty sequence alone, an empty action or binding, a non-array sequence | TH `simulate_input needs exactly one of action, binding and sequence`, `a missing required argument is refused before anything reaches the game` |
| N | an action beside an empty sequence; every action field | TH `simulate_input forwards every field of the action form` |
| N | a sequence | TH `simulate_input forwards a sequence to the game untouched` |
| N | a binding with every field of the action form; a binding step in a sequence | TH `simulate_input forwards a binding with every field of the action form, and a binding step in a sequence` |
| N | `run_in_background` and other stray keys | TH `the misnamed keys real calls sent are refused, never run without them` |
| N | a misnamed step key; a number sent as a string or a fraction; `count` 0; `duration`, `count` or `interval` beside a sequence; a pause step with a duration; an action that is not a string; `player` out of range; a step with both an action and a binding; a binding that is not a string, alone or in a step; a binding's `count` 0 or negative `duration` | TH `simulate_input refuses a malformed plan before it reaches the game` |
| N | every well-formed plan | SI `simulateInputProblem accepts every well-formed plan` |
| N | the budget for holds, repeats and sequences, binding presses and binding steps included; numeric strings; a budget past a timer's range | SI `simulate_input budgets the planned time, a frame allowance per press and the transport margin`, `a simulate_input budget is a number a timer can hold, whatever the arguments` |
| N | a plan the game answers pending: polled to its end with other commands answered meanwhile; refused at once; never finished | SI `an input plan is polled until it ends, and other commands are answered meanwhile`, `a refused plan is answered without polling`, `a plan the game never finishes times out on its own budget`; TH `simulate_input answers with the finished plan, polling the game until it ends` |
| N | an acceptance or a poll answered after the 6s default, inside the plan's budget | SI `the initial request is timed to the plan's budget, not the 6s default`, `a poll answered after the default command timeout still counts, inside the plan's budget` |
| N | a plan queued behind a slower command | SI `a plan queued behind a slower command keeps its whole budget` |
| N | a call cancelled between polls, with its poll running, with its poll queued; a cancel the game never answers or refuses, or for a finished plan; a plan past its budget; one that ends by itself | SI `a cancelled call stops its plan in the game and returns at once`, `a call cancelled with its poll running sends no cancel: the socket it drops stops the plan`, `a call cancelled with its poll queued behind another command still cancels the plan`, `a cancel the game never answers holds nothing up, and its budget drops the connection the plan is tied to`, `a plan already finished, or a cancel the game refuses, is no error`, `a plan past its budget is cancelled too, so the game stops pressing when the caller gives up`, `a plan that ends by itself sends no cancel` |
| N | a capture sweep running | CA `a sweep in progress refuses a second sweep and a launch, and releases them when it throws` |

## spawn_entity

| | class | covered by |
|---|---|---|
| N | type or a coordinate missing; zeros; `entity` sent for `type` | TH `a missing required argument is refused before anything reaches the game`, `a zero is an answer, not a missing value`, `the misnamed keys real calls sent are refused, never run without them` |
| N | `ignoreSuppression` forwarded | TH `spawn_entity forwards ignoreSuppression to the game` |
| N | a spawn that outlasts its main-thread budget | UC `spawn_entity.main-thread-busy: the mod's own late answer reaches the caller` |

## swap_bro

| | class | covered by |
|---|---|---|
| N | `broName` missing; `playerNum` and `ignoreUnlocks` forwarded | TH `a missing required argument is refused before anything reaches the game`, `the defaults a tool fills in reach the game`, `swap_bro forwards ignoreUnlocks to the game` |
| N | the budget: the swap, a 500 ms pause and the confirmation; `nextSpawn` on set_bro's | UC `commandTimeout pins each command's budget`, `a routed tool call waits on its mod command's budget` |
| N | an integer `playerNum`; `recalls` and the kept-slot check in the description | TL `the state tools declare the arguments the mod reads as integers as integers`, `swap_bro takes an optional nextSpawn flag that leaves the current bro` |
| N | `nextSpawn`: reaches the mod as set_bro without the flag; with `ignoreUnlocks`; `broName` missing; `playerNum` default | TH `swap_bro with nextSpawn reaches the mod as set_bro, without the flag`, `swap_bro refuses nextSpawn with ignoreUnlocks and sends nothing`, `a missing required argument is refused before anything reaches the game`, `the defaults a tool fills in reach the game` |

## take_screenshot

| | class | covered by |
|---|---|---|
| N | no highlight, a path, a rectangle, null, an `{instanceId}` | TH `take_screenshot sends a highlight only when one was asked for`, `take_screenshot reads a null highlight as none`, `an instanceId addresses the object in place of a path, a zero included` |
| N | the path on WSL, Proton and other drives; `Z:` with no prefix found | TH `take_screenshot translates the game-side path the way the platform needs` |
| N | a WSL automount root from `/etc/wsl.conf`, or none | TH `WSL drives sit under the automount root /etc/wsl.conf names, /mnt/ without one` |
| N | a game in another Steam library or under Flatpak Steam | HS `the game and its Proton prefix are found in a second Steam library, and the token search reaches that prefix`, `a game under Flatpak Steam is found, its own libraries included, and its data folders are searched` |
| N | a path from a game under Flatpak Steam, native and `Z:`; one in a folder granted to the sandbox; the instance target | HS `a screenshot from a game under Flatpak Steam is translated to where the sandbox put it, only when it is there` |

## teleport_player

| | class | covered by |
|---|---|---|
| N | x or y missing; zeros and `z`; `player` sent for `playerNum` | TH `a missing required argument is refused before anything reaches the game`, `a zero is an answer, not a missing value`, `the misnamed keys real calls sent are refused, never run without them` |
| N | an integer `playerNum`, fractional coordinates | TL `the state tools declare the arguments the mod reads as integers as integers` |

## trace_spawns

| | class | covered by |
|---|---|---|
| N | start, read and stop forwarded | TH `trace_spawns forwards action, targets and since to the game`, `trace_spawns forwards a stop` |
| N | what ends a trace: a port change, a target switch, a reused socket | UC `pointAt a different port drops the socket, and the same port keeps it`; IT `switching the target re-points the client and drops the other game's socket`; WG `a connected client keeps its socket through wait_for_game` |

## unload_script

| | class | covered by |
|---|---|---|
| N | `name` missing; `path` sent instead | TH `a missing required argument is refused before anything reaches the game`, `the misnamed keys real calls sent are refused, never run without them` |
| C | a catalog name, a `.cs` name, a file name, a name no file has | TH `unload_script sends the name the script was loaded under, from its catalog or file name` |

