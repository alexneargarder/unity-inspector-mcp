---
paths:
  - "scripts/tests/**"
---

# Input-class matrix: in-game steps of capture_animations, execute_code, execute_script, run_test_script and unload_script

## capture_animations

| | class | covered by |
|---|---|---|
| S | a character swapped mid-sweep to a different bro | not produced by any step: only a live sweep reaches it |
| S | a smashed `ClonePod` in `levelChanges`; a companion turned with the bro and put back | not produced by any step: only a live sweep reaches it |
| S | a paused game, a cutscene, a piloting bro, one still on the level-start transport, another sweep or claim holding the game (refused by the tool's `execute_code` claim first), a slot holding another bro than `bro`: `Main()` refuses | not produced by any step: only a live sweep reaches it |
| S | the clock set by the game mid-sweep; a level load or restart mid-sweep | not produced by any step: only a live sweep reaches it |
| S | a state going non-finite on the frozen clock, `t` with no error and another field with one, the bro finite and moving after it; a state recursing through `ChangeFrame`; a real special's leftovers on the bro put back between states; a child a state spawned under the bro retired, and not counted as his within that state; a cell off its sheet named in the state's error | not produced by any step: only a live sweep reaches it |
| S | a state that damages, disturbs or kills: `levelChanges`, `suppressed`, `damageCalls` | not produced by any step: only a live sweep reaches it |
| C | a step call (`RunGun`, `StartHanging`, `AttachToZipline`), the `written` flags and `gunFrame`; a provided ladder or zipline | not produced by any step: only a live sweep reaches it |
| N | a box whose strip passes the GPU texture limit; `capture.json` after an unload mid-sweep | not produced by any step: only a live sweep reaches it |

## execute_code

| | class | covered by |
|---|---|---|
| C | an expression; a trailing `return`; a trailing bare expression; void | execute-code-shapes 2-5; execute-code-errors 5-6 |
| C | a `return` inside `if` and inside `try` | execute-code-shapes 6-7 |
| C | an anonymous type, dictionary, list, over 100 items | execute-code-shapes 8-11 |
| C | Vector3, GameObject, Component, null | execute-code-shapes 12-15 |
| C | a 40 KB string; a self-containing list; nesting past the depth limit | execute-code-shapes 16-18 |
| C | a reply over 64 KB with surrogate pairs at both parities and BMP characters, decoded whole | execute-code-shapes 110; UC `a reply split inside a multi-byte character reaches the caller whole` |
| C | an enum, a Type, a decimal; a destroyed object | execute-code-shapes 19-22 |
| C | `using` before statements; a local function, one declared `static` and one `public static`, one inside a declared type's method; no local-function hint for a method inside a declared type | execute-code-shapes 23-24, 102-104, 107 |
| C | a `using` alias replayed after the Evaluator is rebuilt: for an unloaded script assembly, after a compiler crash | execute-code-shapes 84-87, 90 |
| C | an alias: repeated, with whitespace, alone, in the preamble, after a declarations compile failed and was retried | execute-code-shapes 84, 127-130, 133-134 |
| C | an alias with another target: CS1537 saying to pick another name, a bad target too, alone, the earlier one staying in force, across a rebuild; the same for the preamble's `Object`, and its own target compiling | execute-code-shapes 131-132, 162-171 |
| C | LINQ, lambdas and generics; a throwing lambda | execute-code-shapes 25-27, 32 |
| C | a declared generic method compiling and running: holding a lambda that captures nothing, declared alone and called in the same input; with a capturing lambda, called in the same input; plain, called in a later input | execute-code-shapes 81-83, 100-101 |
| C | a declared generic class, used in the same input and in a later one | execute-code-shapes 108-109 |
| C | a generic class: a property, a field refused, reflection, nested, self-referencing, a struct, a base declared in the same input, a constraint, from a script | execute-code-shapes 108-109, 117-126 |
| C | a generic class's field named from a sibling class in the same input, and the game answering after it | execute-code-shapes 224-225 |
| C | a lambda in a generic method, capturing and not, `Func<T,string>`, one calling the method itself, in execute_code and a script | execute-code-shapes 81-83, 116, 194-196 |
| C | a generic method called from the compile declaring it: itself, inferred, another before and after it, mutually, from a non-generic method before and after it, across classes, on a generic class; in a script | execute-code-shapes 186-193, 195-196 |
| C | a generic method called with other type arguments from inside its own body: refused, naming the rewrites, which run; in a script | execute-code-shapes 197-203 |
| C | a virtual or interface generic method: called with the caller's own type parameters, and a base call; with fixed type arguments from the compile declaring it refused, in a script too; from a later call | execute-code-shapes 216-223 |
| C | a refused declaration: calling it says it does not exist, an earlier declaration of the name stays, its input's `using` stays out, the corrected resend compiles | execute-code-shapes 204-215, 218-219 |
| C | a delegate declared again: another signature, alone, after a rebuild, over a class and by a class, generic, beside a refused type, in a namespace | execute-code-shapes 172-185 |
| C | `JsonConvert` at the first naming in an Evaluator, in a declaration and in statements; an overload naming an absent assembly missing, and reading its attributes throwing; `JObject`, `JToken`, `Harmony`, `AccessTools`, `LevelSelectionController`, `List<T>` and LINQ in a declaration | execute-code-shapes 139-150 |
| C | an anonymous type through `JsonConvert` and `JObject`, its fields and members by reflection, declared in a type; a generic class's public field through `JsonConvert`; in a script | execute-code-shapes 151-157, 160-161 |
| C | an anonymous type with an earlier one's names and other types | execute-code-shapes 158-159 |
| C | a bare `IEnumerator` with no `using` | execute-code-shapes 111; scripts-lifecycle 141 |
| C | an interpolation hole holding a string with a `;`, a conditional's strings, a `'"'`, a verbatim and a nested interpolated string, before a `return` | execute-code-shapes 112-115 |
| C | `foreach` over Dictionary Keys and Values, SortedDictionary | execute-code-shapes 28-31 |
| C | unqualified `Object`; unqualified `Math` | execute-code-shapes 33-34 |
| C | reflection on private members; a static write | execute-code-shapes 35-37 |
| C | comments; a line over 1000 characters; a block comment right before a trailing `return`, after a statement and opening the input | execute-code-shapes 38-41, 105-106 |
| C | declared types: nested, with a trailing statement, declared again | execute-code-shapes 42-47 |
| C | a result whose `ToString` throws | execute-code-shapes 48-49 |
| C | user code throws: explicit, cast, null reference | execute-code-shapes 50, 52; execute-code-errors 3-4, 7-8 |
| C | a stack trace through user methods | execute-code-shapes 51 |
| C | a compiler diagnostic | execute-code-shapes 53; execute-code-errors 9 |
| C | a compiler crash: built once and not retried, the Evaluator rebuilt after it | execute-code-shapes 88-91 |
| C | an internal compiler error (CS0584) with its `Cause:` lines, in execute_code and in a script compile, while the mod's nested-type import fix is taken away | execute-code-shapes 92-98 |
| C | an inaccessible type | execute-code-errors 2 |
| C | the compiler's limits: `string.Join` over IEnumerable, a value tuple | execute-code-shapes 54-55 |
| M | types from RocketLib, BroMakerLib, Swap Bros Mod | execute-code-shapes 56-58 |
| C | types of a loaded class-only script, by name and by reflection | execute-code-shapes 59-61 |
| C | several statics of a declared type in one input, then an asset unload | execute-code-shapes 62-64, 70-74 |
| C | 9.5 s on the main thread, returned; 12 s, past the 9 s budget and 2 s grace, reported still running; then a trivial call | execute-code-shapes 65-67 |
| C | a loop that never returns: bare, in a lazily enumerated result, in a declared type's method, catching every exception, its catch wrapping the stop in another exception; stopped at the 9 s budget, the game answering after | execute-code-errors 10-17 |
| C | a method ending in an unreachable try, nothing looping: its exception answered | execute-code-errors 18-25 |
| C | a loop in try, catch, finally, nested, do, foreach, a leave back-edge, lock, using, a lambda, a declared method, an iterator: stopped at 9 s | execute-code-errors 26-43 |
| C | a loop in a static initializer; an exception filter | execute-code-errors 44-46 |
| C | runaway recursion: a method, mutual, a lambda, a property, a constructor, a static initializer, caught, an iterator, `using`, `ToString` | execute-code-errors 61-72 |
| C | deep legitimate recursion | execute-code-errors 65 |
| C | a stop at method entry: no loop; a catch at every level | execute-code-errors 73-74 |
| C | a stop runs the compiled calls it unwinds through: a `finally`, a `using`, a loop in a `finally`, 7000 frames deep, a `catch`, in `Main()` | execute-code-errors 98-107, 110-113 |
| C | a stop still ends a heavy call in a `finally` and a loop in a `catch` at every level | execute-code-errors 108-109 |
| C | `catch when`: true, false, several clauses, throwing, hoisted, in a class method, in a script, stopped | execute-code-errors 45, 86-96 |
| C | a Harmony patch on a compiled method: refused | scripts-lifecycle 144-146 |
| C | every read of a compiled method's body: refused; a game or library method's answered | scripts-lifecycle 148-157 |
| C | input naming `GetMethodBody` with the guard not installed: refused unrun | scripts-lifecycle 158-162 |
| C | not started within 9 s: behind a script's `Main()` still running, behind a held frame | scripts-lifecycle 84, 93 |
| C | the name of an enum an unloaded script declared; an enum's name as a member of another script's type | scripts-lifecycle 107-110, 111-115 |
| C | the enum pre-flight on `$"`: a name in a hole, an odd quote, literal text only | execute-code-shapes 135-138 |
| C | real calls: Harmony `Unpatch` as a statement and as the last statement, Harmony's patch registry, a `LevelSelectionController` static property and constant, `JsonConvert` | execute-code-shapes 75-80 |
| C | a script's constants: long, ulong, char, bool, float, double, string, null string, private | script-constants 1-11 |
| C | a script's enum; a member a script type lacks | script-constants 12-14 |
| C | a class declared by execute_code with constants | script-constants 15-17 |
| C | an enum declared by execute_code | script-constants 18, 20-21 |
| C | a script's enum-typed constants, public and private: a method using them; the public one named | scripts-lifecycle 137-138 |
| S | no level: menu reads | game-states 53 |
| S | a cutscene | player-states 129, 133 |
| S | an empty second player slot | player-states 7 |
| S | a scene load started from code | game-states 39, 70, 77 |
| C | a call after a `Main()` stopped at its budget; after one still running past its budget and grace | scripts-lifecycle 79, 85 |

## execute_script

| | class | covered by |
|---|---|---|
| C | `compileOnly`: a clean compile; the same file again | scripts-lifecycle 3-5 |
| C | `compileOnly`: a compile error, at the script's own line numbers | scripts-lifecycle 6 |
| C | `compileOnly`: the script's own enum | scripts-lifecycle 8 |
| C | `compileOnly`: unqualified `Object` | scripts-lifecycle 9 |
| C | `compileOnly`: an internal mod type | scripts-lifecycle 10 |
| C | `compileOnly`: an iterator method; an auto-property | scripts-lifecycle 11-12 |
| C | `compileOnly`: a type execute_code declared | scripts-lifecycle 13-14 |
| C | `compileOnly`: a member a script type lacks | scripts-lifecycle 16 |
| C | `compileOnly`: an enum execute_code declared | script-constants 18-19 |
| C | `compileOnly`: a nested type used as a field | scripts-lifecycle 133 |
| C | `compileOnly`: only `Main(string[])` | scripts-lifecycle 121 |
| C | two files with one basename | scripts-lifecycle 62-64 |
| C | `args` of strings; int and float; bool; object, array and null; none | scripts-lifecycle 33-37 |
| C | `args` strings shaped like ISO dates, at the top level and nested | scripts-lifecycle 38 |
| C | a first run; a rerun of the same source; of an edited source; after an unload | scripts-lifecycle 22-26, 29 |
| C | an edited source replacing a script that uses a type execute_code declared; that type afterwards | scripts-lifecycle 56-61 |
| C | a compile error | scripts-lifecycle 7 |
| C | `Main()` throws: reported loaded | scripts-lifecycle 66 |
| C | a type execute_code declared; declared again | scripts-lifecycle 15, 19-20 |
| C | a MonoBehaviour with Update; a coroutine | scripts-lifecycle 40-47 |
| C | a Harmony patch through `ScriptContext.Harmony` | scripts-lifecycle 48-51 |
| C | a class-only script; another script naming its types | scripts-lifecycle 52-55 |
| C | a generic method with a lambda | scripts-lifecycle 68-69 |
| M | RocketLib, BroMakerLib and Swap Bros Mod types | scripts-lifecycle 70 |
| C | an iterator method | scripts-lifecycle 72 |
| C | `foreach` over Dictionary Keys and Values and a SortedDictionary | scripts-lifecycle 74-75 |
| C | `Main()` looping past its 15 s budget: stopped, reported loaded; with a catch-all inside the loop | scripts-lifecycle 78-82 |
| C | `Main()` ending in an unreachable try | execute-code-errors 47 |
| C | `Main()` looping in try, catch, finally, nested, do, foreach, a leave back-edge, lock: stopped | execute-code-errors 48-57 |
| C | recursion in `Main()`, in `Unload()`, in `Update`, in a Harmony prefix | execute-code-errors 76-84 |
| C | `Main()` asleep past its budget and grace: reported still running, unloaded once it returns | scripts-lifecycle 83-86; UC `execute_script.long-main: the mod's own late answer reaches the caller` |
| C | a script that cannot start within 10 s while a frame is held: not loaded | scripts-lifecycle 94-97 |
| C | a type another loaded script declares | scripts-lifecycle 116-120 |
| C | overloaded `Main` and `Unload` | scripts-lifecycle 122-124 |
| C | a Harmony patch on the script's own method: refused, the game answering after | scripts-lifecycle 125-127 |
| C | `PatchAll` on the script's own method: the wrapped refusal named; a patch on a method execute_code declared | scripts-lifecycle 142-143, 147, 163-164 |
| C | a script naming Harmony with the guard not installed: refused | scripts-lifecycle 160 |
| C | `nameof` | scripts-lifecycle 131 |
| C | a nested type used as a field | scripts-lifecycle 134 |
| C | enum-typed constants, public and private | scripts-lifecycle 136 |
| C | library `trace-method-calls`: an overloaded name; a method the type inherits | library-scripts 3, 5 |
| C | library `trace-method-calls` and `spawn-capture` on an inherited method: a call on another type, unrecorded; a call on the named type, recorded once | library-scripts 10-17 |
| C | an inherited method: patched, `dump-harmony-patches` reading the patch | library-scripts 5-17, 31-33 |
| C | library `spawn-capture` and `dump-harmony-patches`: a method the type inherits | library-scripts 7, 9 |
| C | library `trace-method-calls` and `spawn-capture`: a type the script system compiled, refused | library-scripts 25-26 |
| C | library `inspect-private-fields` and `watch-field`: a private field a base class declares | library-scripts 19-20 |
| S | library `watch-field` under the pause menu | library-scripts 21-24 |
| C | library `diff-component`: an inactive object by a path with no leading slash | library-scripts 29 |

## run_test_script

| | class | covered by |
|---|---|---|
| C | the same script twice in one game | scripts-lifecycle, run twice |
| C | `logs` from the player log: a mod line, an uncaught exception, lines logged under time scale 0 | not produced by any step: `logs` is the run's own reply; LD `the console copies in Player.log are the mod lines, read the moment they are logged` |

## unload_script

| | class | covered by |
|---|---|---|
| C | a loaded script | scripts-lifecycle 17, 21, 30, 139; execute-code-shapes 68 |
| C | another case; another case after a Harmony patch, the patch removed | scripts-lifecycle 27, 50-51 |
| C | already unloaded; never loaded | scripts-lifecycle 31-32 |
| C | a MonoBehaviour, a coroutine, a Harmony patch | scripts-lifecycle 42-51 |
| C | a component on an object the script does not track | scripts-lifecycle 128-130 |
| C | `Unload()` throws | scripts-lifecycle 76-77 |
| C | cannot start within 10 s while a frame is held | scripts-lifecycle 87-90, 98-99 |
| C | `Unload()` asleep past its budget and grace: reported still running, the teardown finished once it returns | scripts-lifecycle 100-103; UC `unload_script.unload-stalled: the mod's own late answer reaches the caller` |
| C | `Unload()` looping past its budget: stopped, the teardown finished | scripts-lifecycle 104-106 |
| C | `Unload()` looping in a try whose catch wraps the stop | execute-code-errors 58-60 |
