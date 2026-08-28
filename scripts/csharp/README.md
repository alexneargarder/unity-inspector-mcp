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

## .NET 3.5 Constraints

The game runs on .NET 3.5. Key limitations:
- No `Dictionary.GetValueOrDefault()` — use `ScriptContext.GetArg()` or `TryGetValue`
- No `string.IsNullOrWhiteSpace()` — use `string.IsNullOrEmpty(s) || s.Trim().Length == 0`
- No `async/await`
- No `nameof()`
- LINQ is available (`System.Linq`)

## Auto-Imported Namespaces

The following are automatically imported — no `using` statements needed:
`System`, `System.Collections.Generic`, `System.Linq`, `System.Reflection`, `UnityEngine`, `HarmonyLib`, `Unity_Inspector_Mod`

Add additional `using` statements as needed for other namespaces.

## Private Member Access

Scripts can directly access private fields and methods on game types — no reflection needed.

## Temporary Scripts

Scripts outside this directory can be executed via absolute path. They won't appear in `list_scripts` or the catalog resource.
