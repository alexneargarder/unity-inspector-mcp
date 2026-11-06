---
paths:
  - "test/**"
---

# Input-class matrix: server tests of the Node-only tools other than launch_game, stop_game and wait_for_game

## capture_animations

| | class | covered by |
|---|---|---|
| N | `out` missing, relative or a file | CA `capture_animations refuses an out that is missing, relative or not a directory` |
| N | `out` holding files no sweep wrote, a `states.json` of the user's or a marker of other text; `out` an earlier sweep wrote | CA `capture_animations only clears an out directory it wrote before`, `runCapture clears the previous run's strips` |
| N | a missing state list; an `out` the server cannot create | CA `capture_animations names a missing state list and an output directory it cannot write in plain words` |
| C | `states` absent; a bundled name with or without `.json` | CA `capture_animations sweeps the bundled base list alone when states is absent, with or without .json`, `capture_animations resolves a relative states name under the state-list directory` |
| C | the bundled base plus an absolute custom layer | CA `capture_animations layers an absolute custom list over the bundled base, later layers winning in place` |
| C | one absolute custom list | CA `capture_animations uses one absolute state list as given, with no base under it` |
| N | a `states` name escaping the directory; a blank or non-string entry | CA `capture_animations refuses a states path that escapes the state-list directory`, `capture_animations refuses a states entry that is blank or not a string` |
| N | a malformed layer | CA `loadStates refuses a malformed layer before the game is touched`, `runCapture refuses a malformed state file before touching the game` |
| C | `level` given | CA `capture_animations loads the level, waits for its player and settles before the sweep` |
| N | `level`, `player` or a seconds argument that does not parse | CA `capture_animations surfaces the level, player and seconds arguments it cannot parse` |
| C | `level` past the last campaign | CA `capture_animations fails with go_to_level's own range error and captures nothing` |
| C | `bro` absent, null or blank | CA `capture_animations treats a null or blank bro as no swap`, `capture_animations reports no capture file when the game wrote none` |
| C | `bro` a vanilla name | CA `capture_animations sweeps the stub game and answers with the report and its paths` |
| C | `bro` the slot already holds | CA `runCapture skips the poll when swap_bro reports the bro that was already there` |
| C | `bro` the game refuses: unknown, locked | CA `runCapture surfaces a refused bro swap as it was refused, bypassing unlocks only for an unreachable bro`, `runCapture sweeps a locked custom bro the slot already holds` |
| C | `bro` whose swap leaves another bro in the slot | CA `a swap that leaves another bro in the slot is refused before it is swept`, `confirmBro compares the roster name without regard to case, and says when list_bros cannot` |
| S | the old scene, another level or a finished one after `go_to_level` | CA `levelIsReady never takes the scene go_to_level is tearing down for the level it asked for` |
| S | a paused game, a finished level, a dead or piloting bro | CA `runCapture waits out a pause before it sweeps, and refuses a bro that never becomes sweepable`, `sweepableProblem names what keeps a bro from being swept` |
| S | a cutscene pause on a `level` sweep: one `go_to_level` names pressed before the level wait, one after the settle pressed before the swap, the settle again on the live game, none pressed at the readiness wait; without a `level`: pressed before the swap, or at the readiness wait with both settles; one outlasting a press, one that never clears; a menu pause never pressed | CA `on a level sweep a cutscene is pressed past before the swap, the settle runs again on the live game, one go_to_level names is pressed past before the level wait, and none is pressed at the readiness wait`, `without a level a cutscene up before the swap is pressed past first, and one starting after it at the readiness wait`, `dismissCutscene presses past a cutscene, settles once it clears, and names the presses when it never clears`, `dismissCutscene reads the game once when no cutscene is up, and shrugs off a game_state that fails`, `a sweep presses start past a cutscene pause and sweeps, and still refuses a menu pause with nothing pressed`, `the readiness wait presses again only once a cutscene has outlasted a press by a few seconds, settles once it clears, and names the presses when it never clears` |
| S | an empty slot before the swap; a level that never brings a player | CA `runCapture takes anything alive as the swap when the slot was empty first`, `runCapture fails before the sweep when the level never brings a player` |
| N | `gameOut` absent or in Windows form | CA `capture_animations hands the game out, or gameOut in its own separator style` |
| N | `player` 1-3; negative or past 3 | CA `capture_animations forwards players 1 to 3 to the script and the swap`, `capture_animations refuses a negative player or one past 3` |
| C | `timeout` of 120-240 s | CA `capture_animations takes a long timeout as the sweep budget` |
| N | `box` absent or under 1 | CA `capture_animations leaves box to the script unless given, and refuses one under 1` |
| N | `box` absent, `params.box` in `states.json` | CA `runCapture drives the documented command sequence against a stub game`, `runCapture passes box through to the script, and leaves it out when unset` |
| N | `before` or `after` alone | CA `validateStates takes before and after alone or together` |
| N | `box` past 256; a relative `gameOut`; `only` empty or repeating a name | CA `capture_animations refuses a box past 256, a gameOut the game cannot resolve, and a malformed only` |
| C | `only` given; naming a state the list lacks | CA `only sweeps the named states in merged-list order, and the report says how many of how many`, `selectOnly keeps the merged order and refuses a name the list does not have` |
| N | the sweep parameters into `capture.json`; the side-effects line | CA `the sweep parameters travel with the state list into capture.json, and the report says whether side effects ran` |
| N | state names that collide as strip files; a `setup`, `requires` or step pin block of the wrong shape | CA `state names that would write one strip file are refused before anything is sent`, `validateStates refuses a setup, requires or step pin block that the game would read as nothing` |
| C | `includeLethal`; `allowSideEffects` | CA `capture_animations sends lethal states only for includeLethal: true`, `capture_animations turns the script suppression off only for allowSideEffects: true` |
| N | a sweep, launch or wait during a sweep; a sweep that throws | CA `a sweep in progress refuses a second sweep and a launch, and releases them when it throws`, `a sweep that throws releases the guard too` |
| N | the budget a refusal reports, with `level` and `bro` | CA `a sweep in progress counts the level load and both swap calls in the budget its refusal reports` |
| N | a test script running, between its steps included; after it ends; a test script sent together with the sweep | TH `capture_animations is refused while a test script runs, its waits included`, `a capture sweep and a test script sent together do not both run` |
| N | a `launch_game` still running, sent together with the sweep | CA `a sweep is refused while a launch_game is still running` |
| N | two sweeps in one turn; every game-changing tool during a sweep, `run_test_script` included; the read-only ones | CA `two sweeps started together: one reaches the game and the other is refused, writing nothing`, `a sweep holds the game: every tool that could change it is refused, and the ones that only read run` |
| N | a call held in its target wait or its script file's read while a sweep starts | IL `simulate_input held in its target wait while a sweep starts is refused`, `run_test_script held in its target wait while a sweep starts is refused`, `execute_script held reading its script file while a sweep starts is refused`, `unload_script held reading its script file while a sweep starts is refused` |
| N | another run's claim or sweep holding the game; a setup or script start that fails; an expired lease; a server stopped during setup | CA `a second claim while one is held is refused before anything changes the game`, `a run claims the game for its setup, hands the claim to the script, and releases it when setup fails`, `an expired claim is taken over`, `the lease covers every wait and command of the setup it asks for`, `a server stopped during setup releases its claim before it exits` |
| N | the per-server script name; a teardown whose unload fails | CA `each server process names its capture script for itself, and unloads that name`, `teardown leaves the speed alone when the script unloaded, and restores the one from before the sweep when it did not`, `runCapture restores the speed game_state reported before the sweep when the unload fails` |
| N | another command in flight | CA `capture_animations is refused while another command is in flight` |
| N | no game | CA `capture_animations with no game to connect to says so before it touches anything` |
| N | `stop_game` during the level, swap or readiness wait | CA `the level and swap waits end at once when the game stops under them` |
| N | `stop_game` mid-sweep | CA `stop_game during a sweep is let through, and the sweep ends game-gone without a teardown`, `a game that stops mid-sweep ends the sweep instead of sitting out the timeout`, `a sweep is not declared gone against a game process detection never saw` |
| N | cancelled mid-sweep; during a setup wait; between setup commands | CA `a cancelled sweep stops waiting, tears the game down and releases the sweep`, `a cancelled run wakes from its wait, sends no further setup command and releases its claim` |
| N | SIGINT or SIGTERM mid-sweep; a teardown that never answers | CA `shutdownServer unfreezes the game before it exits`, `shutdownServer exits after its budget when the teardown never answers, and says the game may be frozen` |
| N | a sweep ending `timeout`, `error`, or with state errors; a repaired delta with no error, a non-finite value with one | CA `a sweep that times out answers with the log tail through the handler`, `runCapture tails the game log when the sweep never finishes, from where the sweep started`, `runCapture reports a script-side failure and still restores game speed`, `a sweep with state errors answers success: false with the errors listed`, `a sweep whose only finding is a repaired delta answers success: true`, `a non-finite value that lived through an Update still fails the sweep` |
| N | a sweep still making progress past `timeout`; one cut short | CA `waitForSentinel bounds a stall, not a sweep: progress in capture.json moves the deadline on`, `a sweep cut short is reported as the states it finished, the rest never reached` |
| N | more than 20 state errors | CA `the reply caps the state errors and points at the rest` |
| N | level changes, suppressed and damage calls in the report | CA `the report dates the first level change and lists each record that changed the level` |
| N | a descending walk, a held cell, a carried cell; an empty body cell beside a drawn gun | CA `a descending walk and a held cell are walks too`, `a carried-over cell never satisfies an expectation, and the report counts and lists the carried gun frames`, `a frame on an empty body cell is counted even when the gun drew something` |
| N | the bundled firing, ladder and zipline states | CA `the base list draws the gun the way the game does, recoil included, and gives the ladder and zipline states what they need` |

## list_scripts

| | class | covered by |
|---|---|---|
| N | headers parsed; a file with none | SL `list_scripts reports each script with its metadata, and a file name for one without`, `parseScriptMetadata reads a header preceded by blank lines and a banner`, `parseScriptMetadata stops at the first code line` |
| N | an unreadable file, listed under `errors`; a directory it cannot open | SL `list_scripts lists a script it cannot read under errors and reports a directory it cannot open` |
| N | the capture script left out | CA `the capture script lives outside the script directories, so nothing lists it as a script` |
| N | every script in list_scripts and the resource, scenario scripts included; none in the tool list | TL `the script catalog stays out of the tool list, and list_scripts and the resource list every script` |

## list_test_scripts

| | class | covered by |
|---|---|---|
| N | the shipped scripts | SL `list_test_scripts finds every script shipped in scripts/tests`; TH `a Node-only tool works without arguments` |
| N | a file that is not JSON, listed under `errors`; a directory it cannot read | SL `list_test_scripts lists a file that is not JSON under errors and reports a directory it cannot read` |
| N | the args a script declares | SL `list_test_scripts shows the args a script declares` |

## read_log

| | class | covered by |
|---|---|---|
| N | no arguments; `lines` | RL `read_log returns the last 50 lines by default, the trailing newline starting none` |
| N | `lines` 0, negative, fractional, not a number | RL `read_log refuses a line count that is not a whole number of at least 1` |
| C | `filter`, with `lines`, with brackets, matching nothing | RL `read_log filters case-insensitively and then takes the last lines of the matches` |
| C | over 64 KB; one line over 64 KB | RL `read_log caps its text at 64KB, keeping the newest lines and saying how many it dropped`, `read_log keeps the end of a single line longer than the cap` |
| N | the file and its time | RL `read_log reports the file it read and when it was last written` |
| N | a stale file | RL `a stale resolution reaches the response through logFileInfo`, `a log older than the running game is reported as stale, never served silently` |
| N | no log; `UNITY_INSPECTOR_LOG` missing | RL `the not-found error lists the profile globs it searched`, `an explicit UNITY_INSPECTOR_LOG that is missing is reported, not silently replaced` |
| N | which file: override, profiles, player log, start time, Windows layout; both logs live | RL (the remaining tests), `the player log beats an active profile's UMM log the game also writes, whichever was written last`, `with no profile resolved, the player log is read while both are live, never the newer of the two`; IL `the log messages on an instance name its own two logs and no environment variable`; PI `the launched profile is read from the process chain that started the game`, `two games under different profiles resolve to no profile at all`, `the profile is also read from the doorstop environment variable` |
| N | an instance's logs | IL `the log messages on an instance name its own two logs and no environment variable`; IT `UNITY_INSPECTOR_PORT and UNITY_INSPECTOR_LOG belong to the user's game alone` |
| N | the first read after a start on Proton or WSL | RL `the player log paths wait for the Proton detection, so the first read after a start finds the prefix log` |
| N | a `filter` that is not a string | RL `read_log refuses a filter that is not a string, and reads a null one as no filter` |
| N | the file vanishes, with and without `onlyNew` | RL `read_log looks the log up again when it vanishes under it, with and without onlyNew` |
| N | `onlyNew` with `lines` or `filter`; `reset` without `onlyNew` | RL `read_log refuses onlyNew with lines or filter, and reset without onlyNew` |
| C | `onlyNew`: the first call; a follow-up | RL `read_log with onlyNew starts with the last 20 lines of the log`, `read_log with onlyNew returns a baseline, then only the new lines` |
| C | `onlyNew` with `reset` | RL `a reset reports itself as a baseline restart` |
| N | `onlyNew`: a delta over 64 KB | RL `read_log with onlyNew caps a huge delta at 64KB and says so` |
| N | `onlyNew`: the resolved path changes; rotated; truncated in place; rewritten in place past the old position | RL `read_log with onlyNew restarts as a baseline when the resolved log path changes`, `read_log with onlyNew restarts as a baseline when the log is rotated behind the same path`, `read_log with onlyNew restarts as a baseline when the log is truncated in place`, `read_log with onlyNew restarts as a baseline when the game rewrote the log in place past the old position` |
| N | `onlyNew`: a line still being written, CRLF, a cut at the 64 KB cap, the baseline's last bytes | RL `read_log with onlyNew holds back a line still being written and reads CRLF lines whole`, `read_log with onlyNew cuts a huge delta at a line boundary`, `a baseline never repeats lines the next onlyNew call returns` |
| N | `onlyNew`: parallel calls; another file turning up mid-run | RL `parallel onlyNew calls hand each new line out once`, `onlyNew keeps reading the file it started on while that file is still written` |
| N | `onlyNew`: many calls | RL `read_log with onlyNew does not leak file descriptors` |

## restart_server

| | class | covered by |
|---|---|---|
| N | a running child; requests in flight | W `restart_server fails requests that were still in flight` |
| N | a request sent while the old child is stopping; one in flight on a child that crashes | W `a request sent while restart_server is stopping the old child is told to retry, not to restart`, `a request in flight when the child crashes gets an error, not silence` |
| N | after the crash-loop lockout | W `the crash-loop guard stops respawning, and restart_server recovers` |
| N | a child that ignores SIGTERM | W `restart_server kills a child that ignores SIGTERM after its grace` |
| N | the wrapper's log: its folder, its mode, old logs and claim files here and in /tmp, a live wrapper's old ones, an exited wrapper's old claim beside a fresh log, a log that cannot be opened | WL `the wrapper log is private to the user, and a start clears logs and claims nobody wrote for a week, but never a live wrapper's, nor a claim whose log is fresh`, `by default the wrapper logs to a private folder in the user's state directory, and clears its old logs from /tmp`, `a wrapper whose log cannot be opened still starts its server and lists restart_server` |
| N | during another restart; during a respawn | W `a restart_server sent during another shares it, leaving one child`, `a restart_server during a respawn waits for it, and the respawn never stops the restarted child` |
| N | a child that dies before it initializes | W `a request sent to a child that dies during a restart is answered, not left waiting`, `the wrapper replays initialize after the child dies unexpectedly` |
| N | a child that never answers `initialize` | W `a restart whose child never answers initialize fails after its 10s wait and stops that child` |
| N | the child's tool-list notification | W `a notification from the child reaches the parent as the child sent it` |
| N | an instance this session owns | WIS `restart_server replaces the child and stops no game`, `a restart queued when stdin ends never starts a server during the shutdown` |
| N | the default log and claim paths, `XDG_STATE_HOME` absolute, relative or unset, reaching the reaper | WIS `with an absolute XDG_STATE_HOME the reaper reads the default claim and logs to the default log`, `with a relative XDG_STATE_HOME the reaper reads the default claim and logs to the default log`, `with no XDG_STATE_HOME the reaper reads the default claim and logs to the default log` |
| N | an argument it does not take | W `restart_server refuses an argument it does not take and restarts nothing` |
| N | a new child whose tool list fails; the tool count on success | W `a restart whose server cannot list its tools fails, naming the error and the log, and stops it`, `restart_server succeeds only once the new server has listed its tools, and says how many` |
| N | a child dead before `initialize` is answered; one that dies under it | W `a server that cannot start still leaves the client a session in which restart_server works`, `an initialize the server dies under is answered by the wrapper rather than failed` |
| N | an answer written just before the child died; multi-byte text split across reads; a cancelled request | W `an answer the server wrote before it died reaches the client, and only once`, `text split across pipe reads reaches either side intact`, `a cancelled request is forgotten: its late answer is dropped and a later restart fails nothing for it` |

## run_test_script

| | class | covered by |
|---|---|---|
| N | a capture sweep running | CA `a sweep in progress refuses a second sweep and a launch, and releases them when it throws` |
| N | `script` missing or not a string | TH `a missing required argument is refused before anything reaches the game`, `a script name or path that is not a string is refused in plain words, before anything reaches the game` |
| C | a bare name, with `.json`, an absolute path | SL `run_test_script resolves a shipped script by name` |
| N | a name escaping `scripts/tests` | SL `run_test_script refuses a relative name that escapes scripts/tests` |
| N | unknown; not JSON; no `steps` | SL `run_test_script answers an unknown or malformed script with an error, sending nothing` |
| N | a server-side tool as a step, in steps or cleanup; a command that is no tool; inline `source` without `name` | SL `test scripts refuse every server-side tool as a step`, `test scripts reject steps that only the MCP server can run`, `prepareTestScript checks the declared args and the cleanup array`, `a step whose params carry a key its tool does not declare is refused` |
| N | `params.path`: by bare name, `.cs` name, display name, absolute path; no such script; with `source` too; neither | RTS `a library script step sends the file's source, by bare name, .cs name and catalog display name`, `a library script that does not exist fails the script before any command is sent`; SL `a script step names a library script or inlines source, never both` |
| N | `origin` on an `execute_script` step, given or read from its `path` | SL `an execute_script step sends its origin: the one it names, else the file its path read, and a compileOnly step none` |
| N | a stray `params` key, in a step or a cleanup step | SL `a step whose params carry a key its tool does not declare is refused`, `run_test_script refuses a stray step key before it sends anything`, `a misspelled params key is refused in steps and cleanup steps alike, placeholders filled first`; RTS `run_test_script checks each step's params against its tool's schema before it sends anything` |
| N | a `params` value of a type its tool's schema does not allow; a null in `params` | SL `a step's params are checked against its tool's types, a null passing as absent` |
| N | every step and script key the engine reads, beside declared `params` | SL `a step may carry every key the engine reads beside params its tool declares`, `a script using args, until, report, cleanup and continueOnFailure prepares against the tools' schemas` |
| N | a misspelled step key, in a step or a cleanup step; a misspelled script key | SL `a misspelled step key is refused, in steps and cleanup steps alike`, `a misspelled script key is refused before anything is sent` |
| N | `expect` met, unmet, thrown, malformed, empty | SL `an expected failure passes the step and the script keeps going`, `an unmet expectation fails the step and stops the script`, `a thrown command satisfies an expectation of failure`, `contains is matched against the result as the tools print it`, `test scripts reject a malformed expect`, `test scripts reject an expect that checks nothing` |
| N | no `expect`, passing or throwing | SL `a step without expect keeps the old pass/fail behaviour`, `a step whose command throws without an expect fails and stops the script` |
| N | `wait`; no `params`; a `wait` that is not a number from 0 to 2147483647 | SL `a step waits its wait before the next, and a step with no params sends {}`, `a step wait that is not a usable number of milliseconds is refused` |
| N | a take_screenshot step | SL `a take_screenshot step reports the path as this machine sees it` |
| N | `until`: met, timed out, default interval, the game gone; malformed | RTS `until re-sends the step every interval until its expect holds`, `until gives up at its timeout, attempting once more at the deadline, and fails on the last attempt`, `until defaults to a one-second interval`, `until stops polling a game that went away`; SL `until needs an expect and a timeout in seconds; report is a boolean` |
| N | `cleanup` after a failed or thrown step; the game gone before or during it; not an array | RTS `cleanup runs after a failed step and every cleanup step runs even when one fails`, `cleanup runs after a step whose command threw while the game is still up`, `cleanup is skipped when the game died under a step`, `a crash-like error with the game still running does not skip cleanup`, `cleanup stops once the game dies under a cleanup step`; SL `prepareTestScript checks the declared args and the cleanup array` |
| N | `args`: given, defaulted, nested, missing, not an object; malformed declarations | RTS `placeholders are filled from args and declared defaults, nested params included, keeping types`, `a placeholder with no value is a validation error naming it`, `run_test_script takes args and answers with passed and logs`, `run_test_script refuses args that are not an object`; SL `prepareTestScript checks the declared args and the cleanup array` |
| N | a given arg neither declared nor named by a placeholder; an undeclared placeholder filled from `args` | RTS `a given arg neither declared nor named by a placeholder is refused before anything is sent`, `an undeclared placeholder can be filled from args, in a step and in a cleanup step` |
| N | `report`: a JSON string, an object, two reports, unparsable, not an object | RTS `a report step lifts its JSON string into the reply, and its passed counts`, `a report object is lifted as is, and a report without passed leaves the verdict to the steps`, `two report steps give an array of reports, each counting toward the verdict`, `a report that does not parse fails its step, saying so`, `a report that parses to something other than an object fails its step` |
| N | `passed` over steps, cleanup steps and reports | RTS `passed needs every step and every cleanup step to pass` |
| N | a run cancelled between steps; during a step's `wait`; during an `until` sleep, its cleanup's `until` still polling; a cleanup `simulate_input` after the cancel; a step's command cut short, `expect: {success: false}` included; under `continueOnFailure` | SL `a cancelled run stops between steps, runs its cleanup and says it was cancelled`, `a cancel during an until sleep sends no further attempt, and cleanup polls unsignalled`, `a cancel wakes an until step from its sleep between attempts`, `a step whose command the cancel cut short never passes, an expected failure included`, `a continueOnFailure script stops at a cancel, neither waiting its wait nor sending the next step`; RTS `a run_test_script cancelled during a step's wait sends no later step, runs its cleanup and returns at once`, `a cancelled run's cleanup input is polled to its end, not recorded as cancelled` |
| N | a run cancelled inside a `simulate_input` step | RTS `a run cancelled inside a simulate_input step cancels the plan in the game, and its cleanup still runs` |
| N | `continueOnFailure`: past failures, at a dead game, over cleanup, not a boolean | RTS `continueOnFailure runs past an unmet expectation and a thrown command, listing each failure`, `continueOnFailure stops at a step the game died under, and cleanup is skipped`, `continueOnFailure lists failed cleanup steps too, and is empty on a clean run`, `continueOnFailure must be a boolean` |
| N | the compact reply: previews, `resultsFile`, an unwritable results file, shedding, pruning, the results directory, a refused script | RTS `the reply previews each step's result in 300 characters, flagging a cut one`, `resultsFile holds the whole run, every step's full result included`, `a run that could not write its results file says why and still answers`, `a failing step's preview opens with the unmet expectation or the error's first lines`, `a run with no failures stays small however large its results`, `an over-long reply sheds previews, then logs, then the report's bulky fields, the report and the step list`, `an array of reports is trimmed report by report`, `the results directory keeps only the newest files`, `pruning leaves alone every file and directory it did not write`, `the results directory is the session's own, in the user's state directory, never the temp directory`, `one session's pruning never touches another's results, and a session idle for a week is cleared`, `a script refused before it ran answers as it was, with no results file`, `run_test_script answers with previews and a results file in the results directory` |
| N | `logs`: after failed steps, a dead game and its crash log, no baseline; the UMM flush wait; an `UNITY_INSPECTOR_LOG` override; overlapping runs | RTS `the run carries what the player log gained, also when a step failed`, `the run carries the log delta after the game died, and when the baseline could not be taken`, `the final log read waits out UMM's write buffer while the game runs`, `the final log read does not wait for a game that is gone, or with no UMM log to read`, `UNITY_INSPECTOR_LOG is read as the player log or the UMM log by its file name`, `two runs on one server overlapping each say their logs may hold the other's lines`, `a player log the run never wrote gives way to the UMM log the game is writing`; RL `while a game runs, the logs a test run snapshots name no player log it has not written` |
| N | `logs`: a rotated, truncated, regrown, relaunched, missing or oversized log; attribution, mirrors, engine lines, generic frames, stamps, severities, crashes, floods, normalizing, the payload cap | LD (all) |
| N | the shipped scripts | SL `the shipped test scripts are well formed`, `the shipped test scripts only use game-side commands`, `the shipped test scripts only use the arguments their tools declare, cleanup steps included`, `every shipped test script prepares with its declared defaults, library paths included` |
