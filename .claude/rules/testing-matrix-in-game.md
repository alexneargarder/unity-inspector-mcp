---
paths:
  - "scripts/tests/**"
---

# Input-class matrix: in-game steps

## Every tool

| | class | covered by |
|---|---|---|
| C | a caller error in a request, answered at once under its own id with no `Internal error` prefix | execute-code-shapes 99, over a second connection of its own, opened with the hello and its token |
| C | a number or boolean of the wrong JSON type, a non-integer and an out-of-range int, a float past the float range, a null optional and a null required argument, sent to the mod's message handler directly since the server refuses them first | param-types 1-21 |
| C | a caller error (bad path): its own message, no `Internal error`, nothing logged | inspection 22, 173 |
| C | a main thread that does not answer: `success: false`, `mainThreadAnswered: false`, no `Internal error`, no stack | inspection 115, 175, 178; levels 49; spawning 101; scripts-lifecycle 83-84, 90, 93, 96, 101; execute-code-shapes 66 |
| C | a caller error (a parameter value that does not convert): its own message, no `Internal error` | param-types 1-16 |
| C | a parameter caller error left out of the log; a conversion error under a `Newtonsoft.Json.Linq` frame; an internal `ArgumentException` still logged as `Internal error` | not produced by any step: param-types reads no log, every parameter read goes through `ReadInt`, `ReadLong`, `ReadFloat` and `ReadBool` but `take_screenshot`'s highlight, whose type checks answer a field of the wrong type with a `highlightError` before anything converts it (inspection 136-137), and no step makes the mod throw on its own data |

## game_state

| | class | covered by |
|---|---|---|
| S | in a level | game-states 7; levels 9, 13, 16 |
| S | a level loading, its level fields null | game-states 8-10 |
| S | main menu, its level fields null | game-states 40, 71 |
| S | the join screen, before and after a join | game-states 64, 67 |
| S | a joined slot whose Player the level has not spawned: at the join screen, while a level loads (`playerCount` 1) | game-states 10, 67 |
| S | world map, its level fields null | game-states 79 |
| S | the main thread held: `mainThreadAnswered` false with an `error` | inspection 157 |
| S | finished level: `isInGame` false | game-states 87-88; levels 69 |
| S | a challenge map; the Victory map | levels 19, 27 |
| S | dead; respawning | player-states 50, 70 |
| S | two players | player-states 99 |
| S | paused; speed 0 and fractional | player-states 29, 117, 121; input 9, 51, 55 |
| S | piloting | player-states 81 |
| S | a bro the game holds: `state` `held` | player-states 155 |
| S | `BrosReleased` false over a level in play: a live bro `alive`, a hidden one `held` | player-states 167, 170-171 |
| S | a slot whose bro the start-of-level transport holds (`arriving`), from the drop-off until the release | player-states 174-182 |
| S | a Player whose bro has not spawned yet (`joined`) | not produced by any step: the Player exists without a bro only for the frames between its creation and its first spawn; code review |
| S | a cutscene | player-states 130 |
| S | IronBro | player-states 137 |

## go_to_level

| | class | covered by |
|---|---|---|
| C | from a level, with the suppression warning; the reply once the level is in play (`loaded`), naming no cutscene | levels 7-9, 14, 17, 25, 29 |
| S | a bro's intro on a level whose bros arrive by transport: answered at once with `cutscene` and its warning, the bro `arriving`, `start` skipping it | levels 86-91 |
| C | every challenge and Muscle Temple campaign | levels 76-84 |
| C | a fractional index, sent to the mod's message handler directly | levels 85 |
| C | a level that is not in play within 60 s | not produced by any step: every campaign the list names loads; code review |
| C | stock and challenge campaigns | levels 14-19 |
| C | campaign 26, 99, -1; level -1 | levels 20-24 |
| C | a level past the campaign's end | levels 25-27 |
| C | the main thread held past the 3 s budget: the level left as it was | levels 47-51 |
| S | during a load | game-states 33-38 |
| S | from the main menu | game-states 72-76; levels 59 |
| S | from the main menu with no save slot it could use | levels 56-58 |
| S | from the pause menu: a persistent object the pause deactivated is active again | levels 60-62 |
| S | from the world map | game-states 83-86 |
| S | with the player dead | player-states 54-58 |
| S | in IronBro | player-states 143-146 |

## inspect_component

| | class | covered by |
|---|---|---|
| C | the whole component: HeroController, exact TestVanDammeAnim, a bro subclass, SpriteRenderer | inspection 24-26, 102 |
| C | component absent; object absent; component by full type name | inspection 27-28, 101 |
| C | members by kind: int, Color, null, statics, private, enum, arrays, List, Object reference, Vector3, const | inspection 29-41 |
| C | dotted paths: a struct field, through a static array | inspection 42-43 |
| C | a typo, first segment and leaf | inspection 44-45 |
| C | a null intermediate; an empty segment | inspection 46-47 |
| C | a `shared*` twin, as a leaf, dotted, and read through `sharedMaterial` | inspection 48-50 |
| C | a script component's null `const string` | inspection 51-55 |
| C | a member read with the main thread held past its 5 s budget; the read after | inspection 114-116 |
| C | the whole component: a base field an indexer named `Item` shadows, a field holding `m_`, a static getter left unrun, a getter that throws, a destroyed reference, a List | inspection 118 |
| C | a getter that throws; a write-only property; a static getter by `memberPath` | inspection 119-121 |
| C | a numeric segment into a List of structs; past its end; a destroyed reference | inspection 122-124 |
| C | a component named by its base type | inspection 132 |
| C | a type whose script was replaced | inspection 145-148 |
| S | a cutscene | player-states 131 |

## inspect_gameobject

| | class | covered by |
|---|---|---|
| C | an absolute path; a bare root name; a bare child name | inspection 12-14 |
| C | an inactive child with spaces and parentheses; an inactive root | inspection 15-16 |
| C | the `[local]` suffix, kept and dropped | inspection 17-18 |
| C | duplicate names, counted in `matches`; a root whose name holds a slash; a prefab asset root, flagged `isAsset` | inspection 19-21 |
| C | resolved by a GameObject's `instanceId`, by a component's, and by an unused one, through `GameObjectInspector.Resolve` | inspection 163, which calls it through execute_code, not the tool |
| C | an active child of an inactive root: `isActive` beside `activeInHierarchy` | inspection 141 |
| C | not found | inspection 22 |
| C | `detailed` on a small object | inspection 23 |
| C | the bro in detail; an object with over 2,000 children | inspection 108-109, which call `GameObjectInspector.InspectGameObject` through execute_code, not the tool |
| C | the 30,000-character detailed budget and the 100-child cap with `childrenTruncated`, through the tool | inspection 111-112 |

## inspect_player

| | class | covered by |
|---|---|---|
| S | in a level | levels 10 |
| S | main menu | game-states 41 |
| S | a joined slot whose Player the level has not spawned: at the join screen, while a level loads, on the world map | game-states 13, 68, 80 |
| S | dead; respawning; piloting | player-states 51, 71, 82 |
| S | a bro the game holds | player-states 156 |
| S | two players | player-states 100 |

## list_bros

| | class | covered by |
|---|---|---|
| C | in a level; the custom roster | bros 7-8 |
| C | `playerNum` 4 and -1: `bad-player` | bros 58-59 |
| M | a custom bro locked | bros 33 |
| C | after an `ignoreUnlocks` swap; the selection beside the live bro | bros 38, 42, 54 |
| S | main menu | game-states 42 |
| S | second player | player-states 101 |
| S | after a respawn | player-states 75 |
| M | Swap Bros Mod missing, in memory | bros 66 |

## list_campaigns

| | class | covered by |
|---|---|---|
| C | no arguments: only campaigns the game's levels bundle holds | levels 6 |

## list_enemies

| | class | covered by |
|---|---|---|
| M | suppression on, enemies left; on, count 0 | spawning 12, 87 |
| C | after spawns: mooks, a villager, bosses, vehicles, a worm, aliens | spawning 24, 31, 43 |
| M | suppression off with units; off and empty | spawning 50, 89 |
| M | a full level after suppression is turned off; back on | spawning 52-58 |
| M | the suppressor mod disabled | spawning 64 |
| C | registered units that are inactive | spawning 86-87 |
| C | the main thread held past the 5 s budget: `success: false` with `error` and nothing else; the call after | spawning 100-102 |
| C | a corpse: `isAlive` false, beside `aliveCount` | spawning 110-113 |
| S | main menu; world map | game-states 48, 81 |
| S | a level loading | game-states 14-17 |
| S | a piloted vehicle, its `IsEnemy` read before the pilot climbed in | player-states 80, 83 |
| S | a cutscene | player-states 132 |

## list_gameobjects

| | class | covered by |
|---|---|---|
| C | a capped listing; `maxResults` 0 and negative, refused | inspection 10-11, 180 |
| C | every root, no prefab asset among them, each with `scene`, `instanceId` and `activeInHierarchy` | inspection 139 |
| S | a listing past the size cap | not produced by any step: a level holds a few hundred roots, under the cap; query_gameobjects' cap is the same code, inspection 138 |

## modify_component

| | class | covered by |
|---|---|---|
| C | a script const beside a writable field | inspection 54 |
| C | empty `properties` | inspection 57 |
| C | static bool, private static int, private float, float array, a struct field | inspection 58-64 |
| C | instance bools; an enum by name and by number | inspection 65-68 |
| C | partial Vector3, Color, Vector2; a Quaternion by euler | inspection 69-72 |
| C | a dotted struct property; good and bad together | inspection 73-74 |
| C | a component by full type name; a string | inspection 75-77 |
| C | a path with no leading slash, to an inactive child | inspection 78-79 |
| C | null to a value type | inspection 80-81 |
| C | an Object reference; a type mismatch | inspection 82-83 |
| C | no setter; a game const | inspection 84-85 |
| C | not found, plain and dotted | inspection 86-87 |
| C | through a `shared*` twin | inspection 88 |
| C | component absent; object absent | inspection 89-90 |
| C | an inactive root; a root whose name holds a slash | inspection 103-104 |
| C | a live object with no scene is written | inspection 104 |
| C | partial Color and Vector2 keep the parts they leave out | inspection 70-71, 79 |
| C | a dotted write through a List element that is a struct | inspection 125-126 |
| C | a value the game sets back every frame, listed in `reverted` | inspection 127 |
| C | a setter that clamps (`not-kept`); a fraction for an int; a string for an int | inspection 128-130 |
| C | a partial Quaternion, normalized | inspection 131 |
| C | a prefab asset, directly and through a reference to one | inspection 134, 159 |
| C | Euler angles Unity decomposes differently (-90 reads back 270) | inspection 160 |
| C | a struct object with keys the type does not have | inspection 161 |
| S | a next frame that does not come within 1 s (`nextFrameChecked: false`) | not produced by any step: the game renders every frame |
| S | a component whose script is missing, in the scan | not produced by any step: code review only |

## ping

| | class | covered by |
|---|---|---|
| S | main menu | game-states 50 |
| S | the main thread held: `mainThreadAnswered` false, then true | inspection 155-156, 158 |

## query_gameobjects

| | class | covered by |
|---|---|---|
| C | a name; another case | inspection 91-92 |
| C | name and type; a base type | inspection 93-94 |
| C | a type that does not resolve, an error; one with no instances | inspection 95-96 |
| C | a prefab asset's name finds nothing | inspection 133 |
| C | the whole scene, cut at the size cap | inspection 138 |
| C | an inactive child: `activeInHierarchy` and `instanceId` | inspection 140 |
| C | a script type loaded after a miss; a script type replaced | inspection 142-144, 145-147 |
| C | `includeInactive` false and true | inspection 97-98 |
| C | `maxResults` 1; 0 and negative, refused | inspection 99-100, 181 |
| C | `*` and `?` globs, anchored | inspection 105-107 |
| S | main menu | game-states 51 |

## restart_level

| | class | covered by |
|---|---|---|
| C | in a level | levels 11-13 |
| S | main menu | game-states 47; levels 52-55 |
| S | world map | game-states 82 |
| S | a level loading | game-states 24-26 |
| S | dead | player-states 62-66 |
| S | paused | player-states 123-128 |
| S | a cutscene: the objects the pause deactivated are active again | levels 63-65 |
| C | the reply once the level is in play again | levels 11, 64 |
| S | a bro's intro on the restart: answered with `cutscene` and its warning, `start` skipping it | levels 92-96 |
| C | no GameModeController; an online client | not produced by any step: code review |
| S | a finished level | not produced by any step: the level test is the one levels 67-73 cover for the slot tools |
| M | after suppression is turned off and on | spawning 52-58 |

## set_game_speed

| | class | covered by |
|---|---|---|
| C | 1; 0; 0.5 and 0.002; 2 and 10 | input 8-9, 50-51, 54-58, 64 |
| C | above 10, negative; bare NaN and Infinity literals, sent to the mod's message handler directly | input 59-63 |
| S | paused: `timeScale` held at 1, `timeScaleAfterUnpause` the speed | player-states 119-121 |
| S | a running slow-motion that overrides it: `gameTimeEffect` | player-states 163-165 |
| S | 0 under a jump and Bro Lee's special: the bro, the camera shake and the level's time stay finite, and the bro moves on at 1 | player-states 185-191 |
| S | no later frame runs within 1 s | not produced by any step: code review |

## set_player_health

| | class | covered by |
|---|---|---|
| C | high; low | player-states 21-24 |
| C | an empty slot; `playerNum` 7 | player-states 25-26 |
| C | 0; negative | player-states 37-44 |
| S | dead | player-states 59-61 |
| S | piloting: a positive value; the kill path refused, alone and with `playerNum` -1 | player-states 85-89 |
| S | `playerNum` -1 with a slot empty | player-states 111-113 |
| S | main menu | game-states 46 |
| S | IronBro | player-states 140-142 |
| S | a revive halo: refused before the hit | player-states 147-150 |
| S | a bro that revives after the hit | not produced by any step: code review |
| S | a bro the game holds | player-states 153 |
| C | a fractional value, sent to the mod's message handler directly | player-states 161 |
| S | a fade to another scene | levels 73 |

## simulate_input

| | class | covered by |
|---|---|---|
| C | a plan cancelled by its own connection, by another's, twice and then polled, its keys released; a cancel of no such plan and with no `planId` | input-sequence 13-16; through a real cancelled call: not produced by any step, since a step cannot cancel the call it runs in; SI and RTS rows |
| C | a press, in any case | input 11-12, 19 |
| C | a hold; 5 s, released when its reply arrives | input 14-17 |
| C | a pause step with a duration | input 18 |
| C | `count` and `interval`; `interval` 0; `count` 0 | input 20-22; input-sequence 7 |
| C | negative `count`, `interval`, `duration` | input 23-26 |
| C | a sequence; wait-only | input 27-28; input-sequence 6 |
| C | a sequence with an unknown action, a negative wait, over 60 s | input 29-32 |
| C | a non-array sequence and a step that is not an object, sent to the mod's message handler directly; both forms | input 33-36 |
| C | a hold or repeat over 60 s; an unknown action | input 37-39 |
| C | `player` 7 | input 40 |
| C | bro actions: highFive, gesture, sprint | input 42-44 |
| C | `start` and `escape` in a level | input 45-49 |
| S | a press the pause menu takes as accept | input 98-101 |
| S | paused | input 47 |
| S | speed 0: the press taken, with a `note` and no `warning` | input 52-53; player-states 33, 187-188 |
| C | fire in a level, for player 0, and for player 1 not playing, which no frame reads | input 65-69 |
| C | a held `start`: reported on its first frame only, so the pause toggles once | input 71-74 |
| S | an input block; players held still | input 75-80 |
| C | a misnamed step key; a duration sent as a string and a fractional count, both sent to the mod's message handler directly; a count beside a sequence | input-sequence 8-10; param-types 8 |
| C | more finished plans than the mod keeps, never polled | input-sequence 11-12 |
| S | two players holding one action at once; a later plan taking over a running one; a plan stopped by a scene load or a closed connection | not produced by any step: `run_test_script` runs its steps one at a time, so no two plans overlap |
| S | `escape` backing out of the Offline/Online choice, an `InputObserver` menu, and fire opening it again | input 82-92 |
| S | the deathmatch score screen and flyby helicopter (`IsControllerPressing*`), cutscene fast-forward and the credits (`GetControllerHoldingFire`) | not produced by any step: no script plays deathmatch, a fast-forwardable cutscene or the credits |
| S | menu keys at the main menu; fire through to the join screen | game-states 54-69 |
| S | a level loading | game-states 27-29 |
| S | `player` 1 with two players | player-states 106-107 |
| C | `binding` for a bro's binding read every frame whatever its key: Furibrosa's Switch Weapon switching his weapon | input 103-106 |
| C | `binding` for a mod's own binding: Utility Mod's Pause/Unpause Game pausing the game, then resuming it | input 114-117 |
| C | a `binding` step in a sequence | input 111-113 |
| C | a binding the mod never calls `IsDown` for (another player's Utility Mod binding): no frame read | input 118 |
| C | an unknown binding, in a known mod and in an unknown one | input 107-108 |
| C | `binding` beside `action`; a sequence step with both | input 109-110 |
| S | RocketLib absent, or the `KeyBinding.IsDown` patch not installed | not produced by any step: the mod requires RocketLib, and a step cannot unpatch the mod's own postfix |

## spawn_entity

| | class | covered by |
|---|---|---|
| M | a Mook suppressed; bypassed | spawning 20, 22-23 |
| M | a settings save while a step holds `disableEnemySpawn` changed: the value found reaches the file, the changed one stays in memory | spawning 6, 125 |
| C | player-states leaves the Utility Mod slots as found | player-states 173, 197 |
| C | display, enum and messy names; unknown; `Bro` | spawning 25-29 |
| C | a villager | spawning 30 |
| C | Mech, Mook Truck, Stealth Tank, Terrorkopter, Satan Miniboss, Sand Worm | spawning 34-39 |
| C | Facehugger and Screecher; floats and initial velocity | spawning 40-42 |
| C | negative and far coordinates | spawning 44-45 |
| M | suppression off; bypassed while off | spawning 48-49 |
| M | the suppressor mod disabled, its setting still on | spawning 60-63 |
| M | a local mook suppressed; local mooks bypassed | spawning 91-96 |
| S | main menu | game-states 49 |
| S | a level loading | game-states 18-20 |
| S | a finished level | levels 68 |
| C | a non-finite coordinate or velocity | not produced by any step: JSON numbers are finite; code review |
| C | alien and hell units in a jungle level | spawning 103-108 |
| C | a prefab the level's theme lacks | not produced by any step: all seven level themes hold a prefab for every type |
| C | a local spawn that returns nothing | spawning 91 for the local mook route; the Facehugger and Screecher helpers are not produced by any step: code review only |

## swap_bro

| | class | covered by |
|---|---|---|
| C | vanilla; Expendabros and unfinished names | bros 10-15 |
| C | case; spacing; unknown | bros 16-20, 27 |
| M | a custom bro unlocked; held already | bros 21-26 |
| C | `playerNum` 4 and -1; many swaps in one level | bros 28-30 |
| M | a custom bro locked, without and with `ignoreUnlocks` | bros 32-37 |
| M | the respawn after a bypass swap; after a plain swap with `alwaysChosen` on | bros 39-40, 43-46 |
| C | `ignoreUnlocks` on a vanilla bro | bros 41-42 |
| S | a level loading; main menu | game-states 21-23, 44 |
| S | dead; respawning; piloting | player-states 53, 72, 84 |
| S | the second player | player-states 108-110 |
| M | IronBro's roster, without and with `ignoreUnlocks` | player-states 138-139 |
| C | the failure `reason`: `unknown-bro`, `unreachable`, `player-dead`, `piloting`, `no-player`, `no-level`, `held`, `bad-player`, `swap-bros-incompatible` | bros 18-19, 27-29, 34-35, 55-57, 75, 79, 93; player-states 53, 72, 84, 138, 154; game-states 23, 44 |
| C | the reply: roster `broName`, `objectName`, `heroType` for a vanilla bro only | bros 10-16, 76-77 |
| S | a bro the game holds | bros 78-80; player-states 154 |
| C | the save's hero unlocks kept, no unlock cutscene | bros 81-84 |
| M | a locked custom bro Filter Bros leaves out, with `ignoreUnlocks` | bros 85-87 |
| M | the Swap Bros Mod lookup made again once lost | bros 95 |
| C | a fractional `playerNum`, sent to the mod's message handler directly | bros 96 |
| C | `swap-failed` after Swap Bros Mod reports a swap the slot does not hold, with `currentBro`; `swap-undone` when another spawn replaces the bro within 500 ms | bros 97-103 |
| S | the bro arriving in the start-of-level transport: `not-released` | player-states 179 |
| S | `BrosReleased` false over a level in play: a live bro swapped, a hidden one `held` | player-states 169-171 |
| C | the selection restored when `CreateBroList` throws | not produced by any step: code review |
| M | Swap Bros Mod missing, in memory, with and without `nextSpawn` | bros 63-65 |
| C | `swap-failed`: Swap Bros Mod refusing the swap and the selection, in memory | bros 68-74 |
| C | `nextSpawn`: a vanilla bro, then the respawn | bros 47-49 |
| M | `nextSpawn`: a custom bro, then the respawn | bros 50-52 |
| C | `nextSpawn`: case; spacing | bros 53-55 |
| C | `nextSpawn`: `appliesThisLevel` on a level that forces its bros, and on one that does not | bros 47, 88-91 |
| C | `nextSpawn`: `playerNum` 4 and -1 | bros 56-57 |
| M | `nextSpawn`: a custom bro locked | bros 35 |
| M | `nextSpawn`: `alwaysChosen` off before the call, and before and after in the reply | bros 60-62 |
| S | `nextSpawn`: main menu | game-states 43 |
| S | `nextSpawn`: the bro respawning | player-states 67-76 |
| M | a custom bro whose preset throws, with and without `nextSpawn` | not produced by any step: no installed custom bro has one |

## take_screenshot

| | class | covered by |
|---|---|---|
| C | plain, on the Victory map | levels 28 |
| C | an object; off-screen; with nothing to outline; inactive; missing; an empty path | levels 32-37 |
| C | rectangles on, partly on, negative size, off-screen | levels 38-41 |
| C | a rectangle missing a field; null; a number, array and bool sent to the mod's message handler directly | levels 42-46 |
| S | a level loading; main menu | game-states 30-32, 52 |
| S | speed 0; paused | player-states 34, 118 |
| C | a highlight on a prefab asset; a rectangle field null; one not a number, sent to the mod's message handler directly since the server refuses it first | inspection 135-137 |
| C | a highlight by a component's and by a GameObject's `instanceId` | inspection 164-165, which call `ScreenshotCapture.TakeScreenshot` off the main thread through execute_code, not the tool |
| S | the `Screenshots` folder removed under the running game | inspection 150-151 |
| C | more than 50 screenshots kept; the newest a complete PNG | inspection 152-154 |
| S | a screenshot file that never appears | not produced by any step: code review only |
| S | two captures from two connections in one frame | not produced by any step: a test script sends one command at a time; the capture lock is code review only |

## teleport_player

| | class | covered by |
|---|---|---|
| C | x and y; `playerNum` 0; floats | player-states 8-15 |
| C | `z` | player-states 16-18 |
| C | an empty slot; `playerNum` 7 | player-states 19-20 |
| C | a moving bro | player-states 30-32 |
| C | outside the map; 1e30 and -1e30 | player-states 35, 159-160 |
| C | a fractional `playerNum`, sent to the mod's message handler directly | player-states 162 |
| S | a bro the game holds | player-states 152 |
| S | the bro arriving in the start-of-level transport: `not-released` | player-states 180 |
| S | `BrosReleased` false over a level in play: a live bro | player-states 168 |
| S | a finished level; the switch to the next scene | levels 67, 71 |
| S | dead; respawning; piloting | player-states 52, 73, 90-91 |
| S | `playerNum` -1, its empty slots skipped, and each of two players | player-states 102-105 |
| S | main menu | game-states 45 |

## trace_spawns

| | class | covered by |
|---|---|---|
| C | `stop` and `read` with no trace | spawning 9, 13, 18 |
| C | an unknown action; unknown, empty and non-array targets, all but the empty ones sent to the mod's message handler directly | spawning 14-17 |
| C | the default targets; a suppressed spawn recorded | spawning 19-21 |
| C | a replacing start; a local mook and a projectile | spawning 67-71 |
| C | `since` past the counter, between records, not a number (sent to the mod's message handler directly) | spawning 72-74 |
| C | a doodad on a level load | spawning 75-77, step 77 reading `SpawnTrace.Read` through execute_code, not the tool |
| C | stop; ring overflow | spawning 78-83 |
| C | stop removes its own prefixes | spawning 114-117 |

## Not produced by any step

Classes of no single tool.

| class | coverage |
|---|---|
| the method-end pad's or the method-body guard's patch failing to install: its log line | not produced by any step: code review |
| a reply that outlasts its budget while the main thread is busy, outside list_enemies, inspect_component, go_to_level, execute_code (execute-code-shapes 66), execute_script (scripts-lifecycle 83, 96) and unload_script (scripts-lifecycle 90, 101) | UC rows for modify_component and spawn_entity, and `all.started-action-timeout` |
| the Intro scenes after a launch; DeathMatch, BroDown and Rogueforce scenes | none: no step reaches them |
| the inspector disabled in Unity Mod Manager, then enabled | none: toggling the mod drops the connection a step runs on; checked by hand, the server stops on disable and starts on enable |
| a first line over 4,096 characters; more than 16 connections waiting for a hello | none: no tool sends either; checked by hand with a raw socket |
| the token file's mode under Proton | none: it needs a game running under Proton, then `stat` of the prefix's token file |
| a reply written to a client that has gone: no `Write failure` line in the mod's log | none: a step's own connection is the one that would go; another read failure still logging: code review only |
| a Utility Mod with no `enabled` field: `suppressionFound: null`, a `suppressionNote` and one log line | none: no installed Utility Mod lacks it; code review only |
| a main thread that has stopped running frames | `ping` and `game_state`: inspection 155-158, which hold it 8 s; `wait_for_game`'s `main-thread-hung`: none, since a stalled main thread hangs the game the step runs on; WG `a game whose main thread does not answer is main-thread-hung, not ready` |
| `GetTypes()` throwing during a compile | none: no input triggers it |
| `Main.Log` from a TCP thread during UMM's batch write | none: the queue drained by `MainThreadDispatcher.Update` is checked by trace only |
| a native crash's lines in `logs` and `crashLog` | RTS `the run carries the log delta after the game died, and when the baseline could not be taken`; LD `a native crash report is an error`; the crash text itself is unconfirmed |
| an inspection read racing the main thread's object creation | none: every inspection handler now reads on the main thread, so no step can race it |
| library scripts: `menu-tweaker` and `rogueforce-runner`, a traced argument whose `ToString` throws, a name only a prefab asset carries; the level-run driver piloting a mech, on an IronBro save, at a refusing teleport door, on a super-checkpoint reload or under the pause menu | none: the set has no FlexMenu, Rogueforce, level or save that produces them |
