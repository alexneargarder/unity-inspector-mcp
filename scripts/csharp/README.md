# C# Script Library

Runtime C# scripts that compile and execute inside the Unity game process via the MCP tool.

## Script Format

Scripts are `.cs` files with optional comment-header metadata:

```csharp
// #name Human-Readable Name
// #description What this script does and when to use it
// #tags comma, separated, tags
// #args paramName: Description of the parameter

public static class MyScript
{
    public static void Main()
    {
        var arg = ScriptContext.GetArg("paramName", "default");
        ScriptContext.Logger("Hello from script!");
    }

    public static void Unload()
    {
        // Cleanup: called when the script is unloaded
    }
}
```

## Lifecycle

- **`Main()`** — Called when the script is executed. Optional — scripts without Main() just register their types.
- **`Unload()`** — Called when the script is unloaded via `unload_script`. Optional but recommended for scripts that apply patches or create GameObjects.

Re-running `execute_script` **restarts** the script: `Unload()` runs, patches are removed and
tracked GameObjects are destroyed, then `Main()` runs again. Unchanged source still skips
recompilation. `Main()` is never entered twice on top of its own state, so it does not need
to be idempotent — but `Unload()` must actually undo what `Main()` did, or the restart leaks.

## ScriptContext API

Available as static fields/methods during `Main()` and `Unload()`:

- `ScriptContext.Harmony` — Isolated Harmony instance for this script. Patches are auto-unpatched on unload.
- `ScriptContext.Logger(string msg)` — Log to the mod logger. Output prefixed with `[Script:name]`.
- `ScriptContext.GameObjects` — `List<GameObject>`. Add GameObjects here for auto-cleanup on unload.
- `ScriptContext.Args` — `Dictionary<string, string>` of arguments passed from the MCP tool.
- `ScriptContext.GetArg(string key, string defaultValue)` — Safe argument getter (.NET 3.5 compatible).

`ScriptContext` describes the script whose `Main()` or `Unload()` is currently running, and
is restored when that call returns — so running or unloading another script never disturbs
yours. Code that runs later (Harmony patches, coroutines, MonoBehaviours) must capture what
it needs into a static field during `Main()`:

```csharp
private static System.Action<string> cachedLogger;

public static void Main()
{
    cachedLogger = ScriptContext.Logger;  // keeps the [Script:name] prefix
    ...
}
```

`ScriptContext.Logger` is never null; outside `Main()`/`Unload()` it falls back to the mod
logger under a plain `[Script]` prefix. `Harmony`, `GameObjects` and `Args` are null outside
`Main()`/`Unload()`.

`ex.StackTrace` and `ex.ToString()` on a caught exception both return a normal managed trace
naming your script's own methods. No file names or line numbers in it, since the script
assembly is compiled in memory.

## The Pause Menu

Opening the pause menu offline deactivates every active GameObject not tagged `Unpausable`,
`DontDestroyOnLoad` ones included, so their MonoBehaviours stop updating until it closes. A
script whose MonoBehaviour must keep running under the pause menu tags its GameObject
`go.tag = "Unpausable";`, as `scenario-menus.cs` does.

## .NET 3.5 Constraints

The game runs on .NET 3.5. Key limitations:
- No `Dictionary.GetValueOrDefault()` — use `ScriptContext.GetArg()` or `TryGetValue`
- No `string.IsNullOrWhiteSpace()` — use `string.IsNullOrEmpty(s) || s.Trim().Length == 0`
- No `async/await`
- No `nameof()`
- No iterator methods (`yield return`), the whole file fails to compile
- LINQ is available (`System.Linq`)

## Auto-Imported Namespaces

The following are automatically imported — no `using` statements needed:
`System`, `System.Collections.Generic`, `System.Linq`, `System.Reflection`, `UnityEngine`, `HarmonyLib`, `Unity_Inspector_Mod`

Add additional `using` statements as needed for other namespaces.

## Private Member Access

Scripts can directly access private fields and methods on game types — no reflection needed.

## Capturing Spawn Calls

`spawn-capture.cs` patches a method with a prefix that logs the call arguments and a postfix that
dumps the returned object's initial state (type, name, GameObject and position for a Component,
plus its simple public fields). Arguments are `typeName`, `methodName` and `captureCount`.

Every overload of the name is patched with the same pair of patch methods, and each capture line
carries the overload's parameter-type list, so entries stay attributable; `Main()` logs the
signatures it patched. `captureCount` is the total across all of them. An overload that returns
void gets the prefix only, since there is no `__result` to read. Everything lands in the UMM
log — read it back with `read_log`.

Reaching `captureCount` only stops the logging. The patches stay applied, so every call of every
patched overload still pays for Harmony's argument array and the boxing of its value arguments —
run `unload_script` to remove them once you have the captures you wanted.

### Holding a Spawn Still Long Enough to Inspect It

Projectile lifetime is driven by `Time.timeScale`, so `set_game_speed` decides whether a fresh
spawn is still around by the time the next MCP call reaches the game. At speed 1 a projectile is
gone before the first round-trip completes. At 0.02 it survives roughly two round-trips. At 0.002
it is still present and has barely moved after three seconds of wall-clock time, which makes
0.002 the setting for inspecting transient objects — set the speed back to 1 when finished.

### BroMakerLib Spawn Prefixes

BroMakerLib patches `ProjectileController.SpawnGrenadeLocally`, `SpawnProjectileLocally` (all
three overloads), `SpawnGrenadeOverNetwork` and `SpawnProjectileOverNetwork` with prefixes at
default priority. When the prefab is a BroMaker custom projectile — or, for the `*OverNetwork`
methods, the firing unit is a custom bro — those prefixes perform the spawn themselves, assign
`__result` and return `false`; otherwise they return `true` and the game's own method runs.

A prefix that only wants to observe the call therefore needs priority `int.MaxValue`, or
BroMakerLib's prefix consumes the invocation first and the observer never runs. A postfix always
runs and still receives the spawned object in `__result` even when the original was skipped;
`__runOriginal` (Harmony 2.2+) distinguishes the two cases.

## Temporary Scripts

Scripts outside this directory can be executed via absolute path. They won't appear in `list_scripts` or the catalog resource.
